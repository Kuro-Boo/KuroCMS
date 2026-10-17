/**
 * KuroEditor — 本文 HTML の形（DOM 非依存・共有）。
 * ============================================================================
 * 「保存される本文はこういう形」を 1 か所で決め、書き込むすべての経路が通す:
 *
 *   - エディタの貼り付け（_sanitizePastedHTML の最後）
 *   - エディタの読み込み（setContent）と保存（getContent）
 *   - ホストの API・保存の境目（KuroCMS の Worker、Admin の文書。DOM は無い）
 *   - 保守の一括処理（保存済みの本文）
 *
 * DOM を使わずに書く（blocks.js と同じ制約）ので、ブラウザと Cloudflare Worker が
 * 同じコードを動かす。⚠ import を持たない（単体で配る）。
 *
 * ## 方針（2026-10-17 利用者の決定。Admin 仕様「本文の形」）
 *
 * 以前は「壊れ方」ごとに規則を足していた（R1〜R8: <b>→<strong>、段落の <div>、
 * ブロックに付いた font-size、見出しが抱えた段落…）。壊れ方は外の道具の数だけあり
 * 際限が無い。いまは逆に【エディタの形以外はすべてエディタの形へ写す】
 * （conformContentHtml）。R1〜R8 はすべてこの一部になった。
 *
 *   - 文字は絶対に消さない
 *   - 選べない値は近いものを採る。無ければ初期値（書かない）
 *   - エディタが書かない機能の記法（data-*・id・kuro-/kurocms- のコメント・[[…]]）は残す
 *
 * 公開済みの本文も、次に保存したときにこの形になる（見た目が変わることがある —
 * 承知の上での決定。以前の clipboardRepair の区別は無くなった）。
 *
 * 守り（R0: 動くもの・ページ全体に効くもの）は別に持つ。出す経路（公開ページ・
 * エディタへの読み込み）でも、保存済みの古い本文に掛けるため。
 */

// ── sanitize (R0) ─────────────────────────────────────────────────────────────
//
// 本文に「動くもの」と「ページ全体に効くもの」を残さない。書き込む経路（貼り付け・
// API・保存・メンテナンス）も、出す経路（公開ページ・エディタへの読み込み）も
// これを通す — 保存済みの本文が古くても、出口で同じ規則が効く。
//
// ## なぜ木（parseTree）の上に作らないのか
//
// normalizeContentHtml は壊れた HTML を【無変換で返す】（推測して直さない）。
// 守りがその上に載っていると、閉じない <a> を 1 つ混ぜるだけで素通りできる。
// だからここは木を作らず、ブラウザの字句解析と【同じ区切り】でタグを読む:
//   - 属性の引用符が効くのは `=` の直後だけ（`<a "x>` の `>` はタグの終わり）
//   - `/` は属性の区切り（`<img/onerror=…>`）
//   - script / style / iframe … の中身は文字（RAWTEXT）。閉じタグまで読み飛ばす
//   - コメントは最初の `-->` か `--!>` で終わる（`<!-->` `<!--->` は空コメント）
// ブラウザと食い違う所は【多めに消す】側にだけ倒す（svg の中など）。
//
// ## 何を残すか
//
// エディタが書けない・本文に置く理由が無いものだけを落とす。見た目の許可リスト
// （色・字間…）は貼り付けだけの規則で、ここには入れない — API や AI が書く本文の
// 書式まで削ると、それは守りではなく書き換えになる。
//
// ⚠ 出力は必ずこの関数を【最後に】通す。normalize の規則は要素を外すので、
//   `<<div></div>script>` が外したあとで `<script>` に繋がりうる。
//   ここ自身も、消した跡で `<` と文字が繋がらないように `&lt;` にする。

/** 中身ごと落とす要素。 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'template', 'title', 'xmp', 'noembed', 'noframes',
  'object', 'applet', 'frameset', 'svg', 'math',
])
/** タグだけ落とす要素（空要素・中身は残してよい包み）。 */
const DROP_TAG_ONLY = new Set([
  'link', 'meta', 'base', 'embed', 'param', 'frame', 'form', 'plaintext',
  // svg の外に漏れても効く余地を残さない（attributeName=href values=javascript:）
  'animate', 'set', 'animatemotion', 'animatetransform', 'use', 'foreignobject',
  'handler', 'listener',
])
/** 中身が文字として読まれる要素（閉じタグまで読み飛ばす）。 */
const RAWTEXT_TAGS = new Set([
  'script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title',
])
/** 行き先を持つ属性（src 系は読み込み、それ以外は移動先として判定する）。 */
const URL_ATTRS = new Map([
  ['href', 'href'], ['xlink:href', 'href'], ['action', 'href'], ['formaction', 'href'],
  ['cite', 'href'], ['ping', 'href'], ['data', 'src'], ['codebase', 'src'],
  ['src', 'src'], ['poster', 'src'], ['background', 'src'], ['lowsrc', 'src'], ['dynsrc', 'src'],
])
/** 値を問わず落とす属性。 */
const DROP_ATTRS = new Set(['srcdoc', 'formaction'])

const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r'
const isAsciiAlpha = (ch) => /^[a-zA-Z]$/.test(ch || '')

/**
 * 属性値の URL が本文に置いてよい枠組みか。
 * ⚠ kuro-links.js の isSafeUrl と【同じ規則】（このファイルは import を持てない
 *   ＝ブラウザと Worker へ単体で配る）。ずれは tests/sanitize.test.js が見張る。
 */
function isSafeContentUrl(u, kind) {
  const cp = (n) => { try { return String.fromCodePoint(n) } catch { return '' } }
  const decoded = String(u ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => cp(Number(d)))
    .replace(/&colon;/gi, ':')
    .replace(/&(tab|newline);/gi, '')
    .replace(/[\u0000- \u007f]/g, '')
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)
  if (!m) return true
  const scheme = m[1].toLowerCase()
  if (kind === 'src') {
    if (scheme === 'data') return /^data:(image|video|audio)\//i.test(decoded)
    return scheme === 'http' || scheme === 'https' || scheme === 'blob'
  }
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
}

/**
 * 残してよい iframe の行き先 — KuroEditor が [[URL]] から作る埋め込み
 * （kuro-links.js の resolveEmbedUrl が返す形）と同じ所だけ。
 */
function isAllowedEmbedSrc(raw) {
  let u
  try { u = new URL(String(raw ?? '').replace(/&amp;/gi, '&').trim()) } catch { return false }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  const path = u.pathname
  if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'www.youtube-nocookie.com') {
    return path.startsWith('/embed/')
  }
  if (host === 'player.vimeo.com') return path.startsWith('/video/')
  if (/^maps\.google\.[a-z.]+$/.test(host)) return path.startsWith('/maps')
  if (/^(www\.)?google\.[a-z.]+$/.test(host)) return path.startsWith('/maps')
  return false
}

/** style 属性のうち、古いブラウザでスクリプトになりうる書き方。 */
function isDangerousStyle(v) {
  const d = String(v ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&#(\d+);?/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch { return '' } })
    .replace(/\\/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .toLowerCase()
  return /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/.test(d)
}

/**
 * `<` から始まるタグを、ブラウザの字句解析と同じ規則で読む。
 * @returns {{ name: string, attrs: Array<{name:string, value:string|null, raw:string}>,
 *             selfClose: boolean, end: number } | null}  null = 文書の終わりで切れた
 */
function readTag(html, lt) {
  const n = html.length
  let j = lt + 1
  if (html[j] === '/') j++
  const nameStart = j
  while (j < n && !isWs(html[j]) && html[j] !== '/' && html[j] !== '>') j++
  const name = html.slice(nameStart, j).toLowerCase()
  const attrs = []
  let selfClose = false
  for (;;) {
    while (j < n && (isWs(html[j]) || html[j] === '/')) {
      selfClose = html[j] === '/' && html[j + 1] === '>'
      j++
    }
    if (j >= n) return null
    if (html[j] === '>') return { name, attrs, selfClose, end: j + 1 }
    const aStart = j
    j++   // 先頭の 1 文字は `=` でも名前に入る（HTML の規則）
    while (j < n && !isWs(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++
    const aName = html.slice(aStart, j).toLowerCase()
    let k = j
    while (k < n && isWs(html[k])) k++
    let value = null
    if (html[k] === '=') {
      k++
      while (k < n && isWs(html[k])) k++
      const q = html[k]
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, k + 1)
        if (close === -1) return null
        value = html.slice(k + 1, close)
        k = close + 1
      } else {
        const vStart = k
        while (k < n && !isWs(html[k]) && html[k] !== '>') k++
        value = html.slice(vStart, k)
      }
      j = k
    }
    attrs.push({ name: aName, value, raw: html.slice(aStart, j) })
  }
}

/** コメント `<!--` の終わり（終端の直後）。閉じなければ文書の終わり。 */
function commentEnd(html, lt) {
  const body = lt + 4
  if (html[body] === '>') return body + 1                       // <!-->
  if (html.startsWith('->', body)) return body + 2              // <!--->
  const a = html.indexOf('-->', body)
  const b = html.indexOf('--!>', body)
  if (a === -1 && b === -1) return html.length
  if (a === -1) return b + 4
  if (b === -1) return a + 3
  return a < b ? a + 3 : b + 4
}

/** RAWTEXT 要素の閉じタグの位置（`</name` の `<`）。無ければ文書の終わり。 */
function rawtextClose(html, from, name) {
  const re = new RegExp(`</${name}(?=[\\s/>]|$)`, 'ig')
  re.lastIndex = from
  const m = re.exec(html)
  return m ? m.index : html.length
}

/**
 * @param {string} html
 * @returns {{ html: string, removed: number }}
 */
function sanitizeWithCount(html) {
  const n = html.length
  let out = ''
  let removed = 0
  const dropping = []   // 中身ごと落としている要素名の積み
  let i = 0

  // 消した跡で `<` と文字が繋がってタグにならないようにする
  const emitText = (s) => {
    if (dropping.length || !s) return
    if (out.endsWith('<') && /^[a-zA-Z/!?]/.test(s)) out = out.slice(0, -1) + '&lt;'
    out += s
  }
  const emitMarkup = (s) => { if (!dropping.length) out += s }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { emitText(html.slice(i)); break }
    emitText(html.slice(i, lt))
    const next = html[lt + 1]

    if (html.startsWith('<!--', lt)) {
      const end = commentEnd(html, lt)
      emitMarkup(html.slice(lt, end))
      i = end
      continue
    }
    if (next === '!' || next === '?' || (next === '/' && !isAsciiAlpha(html[lt + 2]))) {
      // <!DOCTYPE> / <![CDATA[ / <?…> / </ 1> はどれも「> までのコメント」。</> は無視される。
      const gt = html.indexOf('>', lt + 2)
      i = gt === -1 ? n : gt + 1
      continue
    }
    if (!isAsciiAlpha(next) && next !== '/') {
      emitText('<')
      i = lt + 1
      continue
    }

    const tag = readTag(html, lt)
    if (!tag) { i = n; break }   // 文書の終わりで切れたタグはブラウザも捨てる
    const isEnd = next === '/'
    const { name } = tag
    i = tag.end

    if (isEnd) {
      if (dropping.length) {
        const at = dropping.lastIndexOf(name)
        if (at !== -1) dropping.length = at
        continue
      }
      if (DROP_WITH_CONTENT.has(name) || DROP_TAG_ONLY.has(name) || name === 'iframe') continue
      emitMarkup(`</${name}>`)
      continue
    }

    if (name === 'plaintext') {   // 以降はすべて文字になる — 残りを捨てる
      removed++
      i = n
      break
    }

    if (RAWTEXT_TAGS.has(name)) {
      const close = rawtextClose(html, i, name)
      const content = html.slice(i, close)
      const closeTag = close < n ? readTag(html, close) : null
      const after = closeTag ? closeTag.end : n
      if (name === 'textarea') {
        if (!dropping.length) out += sanitizeStartTag(tag, html.slice(lt, tag.end)).html + content + '</textarea>'
        i = after
        continue
      }
      if (name === 'iframe') {
        const src = tag.attrs.find((a) => a.name === 'src')?.value
        if (!dropping.length && isAllowedEmbedSrc(src)) {
          const st = sanitizeStartTag(tag, html.slice(lt, tag.end))
          removed += st.removed
          out += st.html + '</iframe>'
        } else if (!dropping.length) {
          removed++
        }
        i = after
        continue
      }
      if (!dropping.length) removed++
      i = after
      continue
    }

    if (DROP_WITH_CONTENT.has(name)) {
      if (!dropping.length) removed++
      if (!tag.selfClose) dropping.push(name)
      continue
    }
    if (DROP_TAG_ONLY.has(name)) {
      if (!dropping.length) removed++
      continue
    }
    if (dropping.length) continue

    const st = sanitizeStartTag(tag, html.slice(lt, tag.end))
    removed += st.removed
    out += st.html
  }
  return { html: out, removed }
}

/**
 * 開きタグから危ない属性を落とす。何も落とさなければ元の綴りのまま返す。
 * @returns {{ html: string, removed: number }}
 */
function sanitizeStartTag(tag, raw) {
  const kept = []
  let removed = 0
  for (const a of tag.attrs) {
    const kind = URL_ATTRS.get(a.name)
    const bad =
      a.name.startsWith('on') ||
      DROP_ATTRS.has(a.name) ||
      (kind && a.value !== null && !isSafeContentUrl(a.value, kind)) ||
      (a.name === 'srcset' && a.value !== null &&
        a.value.split(',').some((c) => !isSafeContentUrl(c.trim().split(/\s+/)[0], 'src'))) ||
      (a.name === 'style' && isDangerousStyle(a.value))
    if (bad) removed++
    else kept.push(a.raw)
  }
  if (!removed) return { html: raw, removed: 0 }
  const attrs = kept.length ? ' ' + kept.join(' ') : ''
  return { html: `<${tag.name}${attrs}${tag.selfClose ? ' /' : ''}>`, removed }
}

/**
 * R0 — 本文から「動くもの」と「ページ全体に効くもの」を落とす。
 * 壊れた HTML でも効く（木を作らない）。冪等。危ないものが無ければ入力のまま。
 * @param {string} html
 * @returns {string}
 */
export function sanitizeContentHtml(html) {
  if (typeof html !== 'string' || html === '') return html ?? ''
  if (!html.includes('<')) return html
  return sanitizeWithCount(html).html
}


// ── KuroEditor の形（conform） ────────────────────────────────────────────────
//
// 本文は【エディタが自分で書く形】だけで持つ。外から来た HTML（貼り付け・API・
// AI・HTML タブ・古い版の保存）は、壊れ方ごとに直すのではなく、全部をこの形へ
// 写し直す。壊れ方は数えきれない（2026-10-17 の plaimy-rival 1 本だけで
// colspan="undefined"・コメント・<button>・何重もの <div>・Arial・負の margin・
// <hr> の文字サイズ・16px が出た）が、エディタの形は有限だから。
//
// ⚠ 【経路ごとの決まりを作らない】（2026-10-17 利用者の決定）。貼り付けも API も
//   読み込みも保存も、形と値はここだけが決める。貼り付けだけ・API だけの加工が
//   あると、同じ HTML が経路で違う本文になり、後で原因の分からない違いになる。
//   貼り付けを良くしたいときは、ここを直す（editor.js の貼り付けは【挿す】扱いだけ）。
//
// ## 3 つの約束（2026-10-17 利用者の決定）
//
//   1. 文字は絶対に消さない。タグは外しても中身の文字は残す。知らないタグ
//      （<app> など、文中に書かれた山括弧）は文字に戻す。
//   2. 選べない値は近いものを採る（150% に無い 140% → 150%、callout--info → note、
//      14px → 85%）。近いものも無ければ初期値（＝何も書かない）。
//   3. エディタが書かない【機能の記法】は残す: `data-*` 属性・`id`（ページ内リンクの
//      行き先）・`kuro-` / `kurocms-` で始まるコメント・`[[…]]`（文字なので元から残る）。
//      `data-kuro-*` を持つ要素はエディタ自身の部品なので、中も触らない。
//
// ## 例外（文字でないので残らないもの）
//
//   script / style / svg / math など R0 が落とすもの、機能でないコメント、
//   <input> の値。
//
// ## 形の一覧（要素 → 残す属性・クラス・スタイル）
//
//   p, h1–h6   text-align / line-height / 字下げ padding-left（2em 刻み）
//   ul         kuro-ul-*、margin-left（2em 刻み）
//   ol         kuro-list-*、start、--kuro-marker-color、margin-left
//   li         data-checked、value、text-align / line-height
//   table      class="kuro-table"、<colgroup><col style="width:N%">（列数が合うときだけ）、
//              <tbody> 1 つ、行は長方形に揃える
//   td, th     colspan / rowspan（2 以上の整数）、contenteditable="true"、
//              background-color / color / border-{top,right,bottom,left} / vertical-align /
//              text-align / line-height
//   pre        <pre class="kuro-code" data-gutter="1\n2…"><code>文字だけ</code></pre>
//   hr         class="kuro-hr"、border-top-color
//   span       color / font-size（75–200% の 7 段）/ font-family（serif・sans-serif・Web フォント）
//   strong em u s code kbd ruby rt rp a br img video audio source iframe figure(kuro-media-wrap)
//   div        kuro-callout（note / tip / warn / danger）、kuro-roundbox（data-align・data-width）
//
//   a          http(s) で中が文字だけなら記法 [[URL|文字]]（文字が URL なら [[URL]]）。
//              記法にできないもの（mailto・相対・中に書式・] | を含む・図になる URL・
//              id / data-* / rel の nofollow・sponsored・ugc を持つ）は <a> のまま
//
//   文字サイズの絶対値（px・pt・rem）は「本文の大きさ」＝文字数でいちばん多い大きさ
//   （書かれていない文字は 16px）を 100% として読む。同じ id は最初の 1 つだけ残す。
//   <b style="font-weight:normal">（Google ドキュメントの包み）は太字にしない。
//
//   b → strong、i → em、del・strike → s、ins → u、tt・samp・var → code、
//   font[color/size/face] → span、太字・斜体・下線・取り消し線のスタイル → それぞれのタグ。
//   意味を持たない <div>・<section> などは外す（中に段落が無ければ <p> にする）。

/** 書式（文字の並び）の要素。これ以外はブロックとして扱う。 */
const INLINE_NAMES = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'blink', 'br', 'button', 'cite', 'code',
  'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'meter',
  'nobr', 'output', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'select', 'option',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'audio',
  'video', 'source', 'iframe', 'input', 'textarea', 'marquee', 'slot', 'picture', 'map', 'area',
])

/** HTML の要素名（これに無く `-` も無い名前は、文中の山括弧の書き損じとみなして文字に戻す）。 */
const HTML_NAMES = new Set([
  ...INLINE_NAMES,
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup',
  'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'legend', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'p', 'pre', 'search', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'listing', 'xmp',
  'frameset', 'frame', 'noframes', 'object', 'embed', 'param', 'applet', 'canvas', 'track',
  'datalist', 'base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title',
  'svg', 'math', 'plaintext', 'image', 'basefont', 'keygen', 'menuitem', 'rb', 'rtc', 'portal',
])

const VOID_NAMES = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'embed', 'hr', 'image', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr', 'frame',
])

/** 中身を文字として読む要素（閉じタグまで）。 */
const RAW_NAMES = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])

/** 開いていると <p> を閉じる要素（ブラウザと同じ）。 */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section',
  'summary', 'table', 'ul', 'dd', 'dt', 'li', 'listing', 'xmp', 'plaintext',
])

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const TABLE_SCOPE = new Set(['table', 'td', 'th', 'caption', 'html', 'template'])

// ── 値の形 ────────────────────────────────────────────────────────────────────

/** エディタの文字サイズ（FONT_SIZE_OPTIONS と同じ）。100 は「書かない」。 */
const FONT_SIZES = [75, 85, 100, 120, 150, 175, 200]
/** エディタの行間（LINE_HEIGHT_OPTIONS と同じ）。 */
const LINE_HEIGHTS = [1.2, 1.4, 1.6, 1.8, 2.0, 2.5]
/** 角丸ボックスの横幅（RoundboxMenu と同じ）。 */
const BOX_WIDTHS = [30, 40, 50, 60, 70, 80, 90, 100]
const CALLOUT_TYPES = new Set(['note', 'tip', 'warn', 'danger'])
/** 近い種類へ寄せる（無い種類の callout）。 */
const CALLOUT_NEAR = { info: 'note', warning: 'warn', caution: 'warn', important: 'warn', error: 'danger', success: 'tip', hint: 'tip' }
const UL_STYLES = new Set(['disc', 'circle', 'square', 'none', 'arrow', 'asterisk', 'bullseye', 'check', 'dash', 'hash', 'star', 'star-open', 'tri', 'tri-open'])
const OL_STYLES = new Set(['decimal', 'alpha', 'circled', 'kata', 'none', 'paren-alpha', 'paren-kata', 'paren-num'])
const ALIGNS = new Set(['left', 'center', 'right', 'justify'])
const VALIGNS = new Set(['top', 'middle', 'bottom'])
const BORDER_STYLES = new Set(['solid', 'dotted', 'dashed', 'double'])
const FONT_KEYWORDS = { 'xx-small': 60, 'x-small': 75, small: 89, medium: 100, large: 120, 'x-large': 150, 'xx-large': 200, 'xxx-large': 300 }
const FONT_TAG_SIZES = { 1: 63, 2: 82, 3: 100, 4: 113, 5: 150, 6: 200, 7: 300 }

const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))

/** 色として通るか。テーマの変数（var(--…)）は書き手の選んだ色ではないので採らない。 */
export function cssColor(v) {
  const s = String(v ?? '').trim()
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s.toLowerCase()
  if (/^(?:rgba?|hsla?)\(\s*[-\d.%\s,/]+\)$/i.test(s)) return s.toLowerCase().replace(/\s+/g, ' ')
  if (/^[a-z]{3,20}$/i.test(s) && !/^(?:inherit|initial|unset|revert|currentcolor|transparent|none|auto)$/i.test(s)) return s.toLowerCase()
  return null
}

/** 長さ → em（1em = 16px）。単位の無い 0 だけ通す。 */
function toEm(v) {
  const m = /^(-?[\d.]+)(px|pt|em|rem)?$/i.exec(String(v ?? '').trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const u = (m[2] || '').toLowerCase()
  if (!u) return n === 0 ? 0 : null
  if (u === 'px') return n / 16
  if (u === 'pt') return n * 4 / 3 / 16
  return n
}

/** 字下げ（2em 刻み、0 以下は無し）。 */
function indentValue(v) {
  const em = toEm(v)
  if (em === null || em <= 0.5) return null
  const steps = Math.max(1, Math.round(em / 2))
  return `${steps * 2}em`
}

function lineHeightValue(v) {
  const s = String(v ?? '').trim().toLowerCase()
  let n = null
  if (/^[\d.]+$/.test(s)) n = parseFloat(s)
  else if (/^[\d.]+%$/.test(s)) n = parseFloat(s) / 100
  else if (/^[\d.]+em$/.test(s)) n = parseFloat(s)
  else if (/^[\d.]+(px|pt)$/.test(s)) n = (toEm(s) ?? 0)
  if (!n || !Number.isFinite(n)) return null
  return String(nearest(LINE_HEIGHTS, n).toFixed(1)).replace(/\.0$/, '.0')
}

function alignValue(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'start') return 'left'
  if (s === 'end') return 'right'
  return ALIGNS.has(s) ? s : null
}

/**
 * 文字サイズ → 親に対する %（null = 書かない）。
 * @param {string} v
 * @param {number} ctxPct  祖先が決めた大きさ（%。絶対値を相対に直すのに使う）
 * @param {boolean} inHeading  見出しの中の絶対値は見出しの大きさに任せる
 */
function fontSizeRel(v, ctxPct, inHeading, basePx) {
  const s = String(v ?? '').trim().toLowerCase()
  let rel = null
  let abs = null
  let m
  if ((m = /^([\d.]+)%$/.exec(s))) rel = parseFloat(m[1])
  else if ((m = /^([\d.]+)em$/.exec(s))) rel = parseFloat(m[1]) * 100
  else if ((m = /^([\d.]+)rem$/.exec(s))) abs = parseFloat(m[1]) * 100
  else if ((m = /^([\d.]+)px$/.exec(s))) abs = parseFloat(m[1]) / 16 * 100
  else if ((m = /^([\d.]+)pt$/.exec(s))) abs = parseFloat(m[1]) * 4 / 3 / 16 * 100
  else if (s in FONT_KEYWORDS) abs = FONT_KEYWORDS[s]
  else if (s === 'smaller') rel = 85
  else if (s === 'larger') rel = 120
  if (abs !== null) {
    if (inHeading) return null
    // 絶対値は「本文の大きさ」（bodyFontPx）を 100% として読む
    rel = abs * 16 / (basePx || 16) / (ctxPct || 100) * 100
  }
  if (rel === null || !Number.isFinite(rel) || rel <= 0) return null
  const snapped = nearest(FONT_SIZES, rel)
  return snapped === 100 ? null : snapped
}

/** 書体 → エディタの書き方（serif / sans-serif / "Web フォント", sans-serif）。null = 書かない。 */
function fontFamilyValue(v) {
  const s = String(v ?? '').trim()
  if (s === 'serif' || s === 'sans-serif') return s
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  // Web フォント（エディタは `"名前", sans-serif` と書く）
  if (parts.length === 2 && /^"[^"]+"$/.test(parts[0]) && parts[1] === 'sans-serif') return `${parts[0]}, sans-serif`
  const last = parts[parts.length - 1]?.toLowerCase()
  // 明朝の指定だけは意味がある（ゴシックは既定と同じなので書かない）
  if (last === 'serif') return 'serif'
  return null
}

/** 罫線 `<幅> <線種> [色]` → エディタの書き方。 */
function borderValue(v) {
  const parts = String(v ?? '').trim().toLowerCase().replace(/\s*,\s*/g, ',').split(/\s+(?![^(]*\))/)
  let width = null
  let style = null
  let color = null
  for (const p of parts) {
    if (BORDER_STYLES.has(p)) style = p
    else if (p === 'none' || p === 'hidden') return null
    else if (/^[\d.]+(px|pt|em)?$/.test(p) || p === 'thin' || p === 'medium' || p === 'thick') {
      const px = p === 'thin' ? 1 : p === 'medium' ? 3 : p === 'thick' ? 5 : Math.round((toEm(p.match(/[a-z]/) ? p : `${p}px`) ?? 0) * 16)
      width = Math.min(3, Math.max(1, px))
    } else if (cssColor(p)) color = cssColor(p)
  }
  if (!style || !width) return null
  if (style === 'dashed' || style === 'double') style = 'solid'
  if (style === 'dotted') width = 1
  return `${width}px ${style}${color ? ` ${color}` : ''}`
}

// ── 読み取り（寛容） ──────────────────────────────────────────────────────────

/**
 * 属性値の中の文字参照は【触らない】（&copy; などを解いて書き戻すと意味が変わる）。
 * スタイルの宣言を `;` で分けるときだけ、文字参照の `;` を区切りと見ない。
 */
function styleMap(raw) {
  const out = new Map()
  if (!raw) return out
  const s = String(raw).replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
  for (const d of s.split(/;(?![^(]*\))/)) {
    const c = d.indexOf(':')
    if (c === -1) continue
    const prop = d.slice(0, c).trim().toLowerCase()
    const val = d.slice(c + 1).replace(/!important/i, '').trim()
    if (prop && val) out.set(prop, val)
  }
  return out
}

// ── 文字の書き方（ブラウザの innerHTML と同じ） ─────────────────────────────────
//
// 文字参照は一度解いてから、ブラウザが書き出すのと同じ形で書き直す: 文字の中は
// & < > と nbsp、属性の中はそれに " を足す（Chrome 155 で確かめた）。こうしないと、
// エディタで開いて保存しただけで綴りが変わり（&#x20bb7; → 𠮷、Q&A → Q&amp;A）、
// 開くたびに「変更あり」になる。
// ⚠ 名前の文字参照は HTML4 の 252 個だけ解く（全 2,231 個は持たない）。知らない
//   名前（&bigstar; など）は書かれたまま残す —— 意味は変えない。

const ENTITIES = new Map('AElig:c6,Aacute:c1,Acirc:c2,Agrave:c0,Alpha:391,Aring:c5,Atilde:c3,Auml:c4,Beta:392,Ccedil:c7,Chi:3a7,Dagger:2021,Delta:394,ETH:d0,Eacute:c9,Ecirc:ca,Egrave:c8,Epsilon:395,Eta:397,Euml:cb,Gamma:393,Iacute:cd,Icirc:ce,Igrave:cc,Iota:399,Iuml:cf,Kappa:39a,Lambda:39b,Mu:39c,Ntilde:d1,Nu:39d,OElig:152,Oacute:d3,Ocirc:d4,Ograve:d2,Omega:3a9,Omicron:39f,Oslash:d8,Otilde:d5,Ouml:d6,Phi:3a6,Pi:3a0,Prime:2033,Psi:3a8,Rho:3a1,Scaron:160,Sigma:3a3,THORN:de,Tau:3a4,Theta:398,Uacute:da,Ucirc:db,Ugrave:d9,Upsilon:3a5,Uuml:dc,Xi:39e,Yacute:dd,Yuml:178,Zeta:396,aacute:e1,acirc:e2,acute:b4,aelig:e6,agrave:e0,alefsym:2135,alpha:3b1,amp:26,and:2227,ang:2220,aring:e5,asymp:2248,atilde:e3,auml:e4,bdquo:201e,beta:3b2,brvbar:a6,bull:2022,cap:2229,ccedil:e7,cedil:b8,cent:a2,chi:3c7,circ:2c6,clubs:2663,cong:2245,copy:a9,crarr:21b5,cup:222a,curren:a4,dArr:21d3,dagger:2020,darr:2193,deg:b0,delta:3b4,diams:2666,divide:f7,eacute:e9,ecirc:ea,egrave:e8,empty:2205,emsp:2003,ensp:2002,epsilon:3b5,equiv:2261,eta:3b7,eth:f0,euml:eb,euro:20ac,exist:2203,fnof:192,forall:2200,frac12:bd,frac14:bc,frac34:be,frasl:2044,gamma:3b3,ge:2265,gt:3e,hArr:21d4,harr:2194,hearts:2665,hellip:2026,iacute:ed,icirc:ee,iexcl:a1,igrave:ec,image:2111,infin:221e,int:222b,iota:3b9,iquest:bf,isin:2208,iuml:ef,kappa:3ba,lArr:21d0,lambda:3bb,lang:2329,laquo:ab,larr:2190,lceil:2308,ldquo:201c,le:2264,lfloor:230a,lowast:2217,loz:25ca,lrm:200e,lsaquo:2039,lsquo:2018,lt:3c,macr:af,mdash:2014,micro:b5,middot:b7,minus:2212,mu:3bc,nabla:2207,nbsp:a0,ndash:2013,ne:2260,ni:220b,not:ac,notin:2209,nsub:2284,ntilde:f1,nu:3bd,oacute:f3,ocirc:f4,oelig:153,ograve:f2,oline:203e,omega:3c9,omicron:3bf,oplus:2295,or:2228,ordf:aa,ordm:ba,oslash:f8,otilde:f5,otimes:2297,ouml:f6,para:b6,part:2202,permil:2030,perp:22a5,phi:3c6,pi:3c0,piv:3d6,plusmn:b1,pound:a3,prime:2032,prod:220f,prop:221d,psi:3c8,quot:22,rArr:21d2,radic:221a,rang:232a,raquo:bb,rarr:2192,rceil:2309,rdquo:201d,real:211c,reg:ae,rfloor:230b,rho:3c1,rlm:200f,rsaquo:203a,rsquo:2019,sbquo:201a,scaron:161,sdot:22c5,sect:a7,shy:ad,sigma:3c3,sigmaf:3c2,sim:223c,spades:2660,sub:2282,sube:2286,sum:2211,sup:2283,sup1:b9,sup2:b2,sup3:b3,supe:2287,szlig:df,tau:3c4,there4:2234,theta:3b8,thetasym:3d1,thinsp:2009,thorn:fe,tilde:2dc,times:d7,trade:2122,uArr:21d1,uacute:fa,uarr:2191,ucirc:fb,ugrave:f9,uml:a8,upsih:3d2,upsilon:3c5,uuml:fc,weierp:2118,xi:3be,yacute:fd,yen:a5,yuml:ff,zeta:3b6,zwj:200d,zwnj:200c'.split(',').map((p) => {
  const [k, v] = p.split(':')
  return [k, String.fromCodePoint(parseInt(v, 16))]
}))
for (const k of ['AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']) ENTITIES.set(k, ENTITIES.get(k.toLowerCase()))
ENTITIES.set('apos', "'")
/** `;` を省いても解かれる古い名前（HTML の仕様の 106 個）。 */
const LEGACY_ENTITIES = new Set('AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml'.split(' '))

const escChar = (ch, inAttr) => ch === '&' ? '&amp;' : ch === '\u00a0' ? '&nbsp;' : ch === '<' ? '&lt;'
  : ch === '>' ? '&gt;' : (inAttr && ch === '"') ? '&quot;' : ch
const escText = (s, inAttr) => s.replace(inAttr ? /[&\u00a0<>"]/g : /[&\u00a0<>]/g, (c) => escChar(c, inAttr))

/** 文字参照を解いて、ブラウザと同じ形で書き直す。冪等。 */
function canon(raw, inAttr = false) {
  const s = String(raw ?? '')
  if (!/[&<>"\u00a0]/.test(s)) return s
  let out = ''
  let last = 0
  const re = /&(#[xX][0-9a-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z0-9]*;?)/g
  let m
  while ((m = re.exec(s))) {
    out += escText(s.slice(last, m.index), inAttr)
    last = m.index + m[0].length
    const body = m[1]
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const n = parseInt(body.slice(hex ? 2 : 1).replace(';', ''), hex ? 16 : 10)
      const ok = n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
      out += escText(ok ? String.fromCodePoint(n) : '\ufffd', inAttr)
      continue
    }
    if (body.endsWith(';')) {
      const name = body.slice(0, -1)
      out += ENTITIES.has(name) ? escText(ENTITIES.get(name), inAttr) : `&${body}`
      continue
    }
    // `;` の無い古い名前（&copy など）。属性の中では、後ろに英数字・= が続けば解かない
    let k = body.length
    while (k > 0 && !LEGACY_ENTITIES.has(body.slice(0, k))) k--
    const next = s[m.index + 1 + k] ?? ''
    if (k > 0 && !(inAttr && /[=a-zA-Z0-9]/.test(next))) {
      out += escText(ENTITIES.get(body.slice(0, k)), inAttr) + escText(body.slice(k), inAttr)
    } else out += '&amp;' + escText(body, inAttr)
  }
  return out + escText(s.slice(last), inAttr)
}

const escAttr = (s) => canon(s, true)

/**
 * HTML を木にする。壊れた HTML でも必ず木を返す（閉じ忘れは親で閉じる、
 * 対応の無い閉じタグは捨てる、<p> の暗黙の閉じはブラウザと同じ）。
 */
function parseLoose(html) {
  const root = { t: 'el', name: '#root', attrs: [], kids: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const n = html.length
  let i = 0
  const text = (raw) => {
    if (!raw) return
    const k = top().kids
    const last = k[k.length - 1]
    if (last?.t === 'text') last.raw += raw
    else k.push({ t: 'text', raw })
  }
  const popTo = (idx) => { stack.length = idx }
  const findOpen = (names, stopAt) => {
    for (let j = stack.length - 1; j > 0; j--) {
      const nm = stack[j].name
      if (names.has(nm)) return j
      if (stopAt?.has(nm)) return -1
    }
    return -1
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { text(html.slice(i)); break }
    text(html.slice(i, lt))
    const next = html[lt + 1]
    if (html.startsWith('<!--', lt)) {
      const end = commentEnd(html, lt)
      const body = html.slice(lt + 4, end).replace(/--!?>$/, '').replace(/^-?>$/, '')
      top().kids.push({ t: 'comment', data: body })
      i = end
      continue
    }
    if (next === '!' || next === '?' || (next === '/' && !isAsciiAlpha(html[lt + 2]))) {
      const gt = html.indexOf('>', lt + 2)
      i = gt === -1 ? n : gt + 1
      continue
    }
    if (!isAsciiAlpha(next) && next !== '/') { text('&lt;'); i = lt + 1; continue }
    const tag = readTag(html, lt)
    if (!tag) { text(html.slice(lt).replace(/</g, '&lt;')); break }
    i = tag.end
    const name = tag.name
    const attrs = tag.attrs.map((a) => ({ name: a.name, value: a.value }))

    if (next === '/') {
      if (name === 'br') { top().kids.push({ t: 'el', name: 'br', attrs: [], kids: [] }); continue }
      const idx = findOpen(new Set([name]), TABLE_SCOPE.has(name) ? null : (name === 'p' ? new Set(['td', 'th', 'table', 'caption', 'button']) : null))
      if (idx > 0) { stack[idx].closed = html.slice(lt, tag.end); popTo(idx) }
      continue
    }

    // ── 暗黙に閉じるもの（ブラウザと同じ） ──
    if (CLOSES_P.has(name)) {
      const p = findOpen(new Set(['p']), new Set(['td', 'th', 'table', 'caption', 'button']))
      if (p > 0) popTo(p)
    }
    if (name === 'li') { const j = findOpen(new Set(['li']), new Set(['ul', 'ol', 'td', 'th', 'table'])); if (j > 0) popTo(j) }
    if (name === 'dt' || name === 'dd') { const j = findOpen(new Set(['dt', 'dd']), new Set(['dl', 'td', 'th', 'table'])); if (j > 0) popTo(j) }
    if (name === 'tr') { const j = findOpen(new Set(['tr']), new Set(['table'])); if (j > 0) popTo(j) }
    if (name === 'td' || name === 'th') { const j = findOpen(new Set(['td', 'th']), new Set(['table', 'tr'])); if (j > 0) popTo(j) }
    if (name === 'tbody' || name === 'thead' || name === 'tfoot') { const j = findOpen(new Set(['tbody', 'thead', 'tfoot']), new Set(['table'])); if (j > 0) popTo(j) }
    if (name === 'option') { const j = findOpen(new Set(['option']), new Set(['select'])); if (j > 0) popTo(j) }
    if (HEADINGS.has(name) && HEADINGS.has(top().name)) popTo(stack.length - 1)
    if (name === 'a') { const j = findOpen(new Set(['a']), TABLE_SCOPE); if (j > 0) popTo(j) }

    const el = { t: 'el', name, attrs, kids: [], src: html.slice(lt, tag.end) }
    top().kids.push(el)
    if (name === 'plaintext') { el.kids.push({ t: 'text', raw: html.slice(i).replace(/&/g, '&amp;').replace(/</g, '&lt;') }); break }
    if (RAW_NAMES.has(name)) {
      const close = rawtextClose(html, i, name)
      const content = html.slice(i, close)
      if (content) el.kids.push({ t: 'text', raw: name === 'textarea' || name === 'title' ? content : content.replace(/</g, '&lt;'), raw0: content })
      const ct = close < n ? readTag(html, close) : null
      i = ct ? ct.end : n
      el.closed = true
      continue
    }
    if (VOID_NAMES.has(name) || (tag.selfClose && !HTML_NAMES.has(name))) continue
    stack.push(el)
  }
  return root
}

// ── 書き出し ──────────────────────────────────────────────────────────────────

function serializeNodes(nodes) {
  let out = ''
  for (const nd of nodes) {
    if (nd.t === 'text') out += canon(nd.raw)
    else if (nd.t === 'comment') out += `<!--${nd.data}-->`
    else if (nd.t === 'raw') out += nd.html
    else {
      const attrs = nd.attrs.map((a) => ` ${a.name}="${escAttr(a.value ?? '')}"`).join('')
      out += `<${nd.name}${attrs}>`
      if (VOID_NAMES.has(nd.name)) continue
      out += serializeNodes(nd.kids) + `</${nd.name}>`
    }
  }
  return out
}

/** 手を付けない部分木（data-kuro-* の部品）。元の綴りのまま書き戻す。 */
function serializeOriginal(nd) {
  if (nd.t === 'text') return nd.raw0 !== undefined ? nd.raw0 : canon(nd.raw)
  if (nd.t === 'comment') return `<!--${nd.data}-->`
  const attrs = nd.attrs.map((a) => ` ${a.name}="${escAttr(a.value ?? '')}"`).join('')
  if (VOID_NAMES.has(nd.name)) return `<${nd.name}${attrs}>`
  return `<${nd.name}${attrs}>${nd.kids.map(serializeOriginal).join('')}</${nd.name}>`
}

// ── 変換 ──────────────────────────────────────────────────────────────────────

const el = (name, attrs = [], kids = []) => ({ t: 'el', name, attrs, kids })
const attrOf = (nd, name) => nd.attrs?.find((a) => a.name === name)?.value ?? null
const classesOf = (nd) => (attrOf(nd, 'class') || '').split(/\s+/).filter(Boolean)
const isBlockNode = (nd) => (nd.t === 'el' ? !INLINE_NAMES.has(nd.name) : nd.t === 'raw' && nd.block)
const isBlank = (nd) => (nd.t === 'text' && !/\S/.test(nd.raw)) || nd.t === 'comment'

/** 文字が 1 つも無く、見えるもの（br・画像など）も無いか。 */
function isEmptyInline(nd) {
  if (nd.t === 'text') return !/\S/.test(nd.raw)
  if (nd.t === 'comment') return true
  if (nd.t === 'raw') return false
  // 機能の記法を持つ空の要素（<a data-brand-site href> など）は中身があるものとして扱う
  if (nd.attrs.some((a) => a.name.startsWith('data-') && a.name !== 'data-bid' && a.name !== 'data-cbid')) return false
  if (['br', 'img', 'video', 'audio', 'iframe', 'hr', 'input'].includes(nd.name)) return false
  return nd.kids.every(isEmptyInline)
}

/**
 * 機能の記法として残す属性（約束 3）: data-*・id・lang・dir="rtl"。
 * 並びは元のまま。
 */
function functionalAttrs(nd) {
  const out = []
  for (const a of nd.attrs) {
    if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'lang') out.push(a)
    else if (a.name === 'dir' && String(a.value).toLowerCase() === 'rtl') out.push({ name: 'dir', value: 'rtl' })
  }
  return out
}

/** 元の並びを保ったまま、属性を組み立てる（class と style は元の位置に）。 */
function buildAttrs(nd, { cls = null, style = null, extra = [] } = {}) {
  const out = []
  let placedCls = false
  let placedStyle = false
  const extraNames = new Set(extra.map((a) => a.name))
  for (const a of nd.attrs) {
    if (a.name === 'class') { if (cls && !placedCls) { out.push({ name: 'class', value: cls }); placedCls = true } continue }
    if (a.name === 'style') { if (style && !placedStyle) { out.push({ name: 'style', value: style }); placedStyle = true } continue }
    if (extraNames.has(a.name)) {
      const e = extra.find((x) => x.name === a.name)
      if (!out.some((o) => o.name === e.name)) out.push(e)
      continue
    }
    if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'lang') out.push(a)
    else if (a.name === 'dir' && String(a.value).toLowerCase() === 'rtl') out.push({ name: 'dir', value: 'rtl' })
  }
  if (cls && !placedCls) out.unshift({ name: 'class', value: cls })
  for (const e of extra) if (!out.some((o) => o.name === e.name)) out.push(e)
  if (style && !placedStyle) out.push({ name: 'style', value: style })
  return out
}

const styleText = (decls) => decls.length ? decls.map(([p, v]) => `${p}: ${v}`).join('; ') : null

/** 行（段落・見出し・項目・セル）に付けてよい配置のスタイル。 */
function lineDecls(sm, { indent = true } = {}) {
  const out = []
  const al = alignValue(sm.get('text-align'))
  if (al) out.push(['text-align', al])
  const lh = lineHeightValue(sm.get('line-height'))
  if (lh) out.push(['line-height', lh])
  if (indent) {
    const ind = indentValue(sm.get('padding-left') ?? sm.get('margin-left') ?? sm.get('padding-inline-start') ?? sm.get('margin-inline-start'))
    if (ind) out.push(['padding-left', ind])
  }
  return out
}

/**
 * 書式のスタイル → 包むタグ。太字・斜体・下線・取り消し線はタグに、色・大きさ・
 * 書体は <span> に。外側から順に [strong, em, u, s, span]。
 */
function inlineWrappers(sm, ctx) {
  const wraps = []
  const w = String(sm.get('font-weight') ?? '').toLowerCase()
  if (w === 'bold' || w === 'bolder' || (Number(w) >= 600)) wraps.push(el('strong'))
  const fs = String(sm.get('font-style') ?? '').toLowerCase()
  if (fs === 'italic' || fs === 'oblique') wraps.push(el('em'))
  const td = `${sm.get('text-decoration') ?? ''} ${sm.get('text-decoration-line') ?? ''}`.toLowerCase()
  if (/underline/.test(td)) wraps.push(el('u'))
  if (/line-through/.test(td)) wraps.push(el('s'))
  const span = []
  // 背景と組で決めた文字色は、背景を落とすなら一緒に落とす（白地に白い字を残さない。
  // ボタン風のリンク `background:#030712; color:#fff` など）
  const color = sm.has('background') || sm.has('background-color') ? null : cssColor(sm.get('color'))
  if (color) span.push(['color', color])
  let pct = ctx.pct
  const size = fontSizeRel(sm.get('font-size'), ctx.pct, ctx.inHeading, ctx.basePx)
  if (size) { span.push(['font-size', `${size}%`]); pct = ctx.pct * size / 100 }
  const fam = fontFamilyValue(sm.get('font-family'))
  if (fam) span.push(['font-family', fam])
  if (span.length) wraps.push(el('span', [{ name: 'style', value: styleText(span) }]))
  return { wraps, pct }
}

/** wraps を外から順に入れ子にして、いちばん内側へ kids を入れる。 */
function nest(wraps, kids) {
  if (!wraps.length) return kids
  const outer = wraps[0]
  let cur = outer
  for (let k = 1; k < wraps.length; k++) { cur.kids = [wraps[k]]; cur = wraps[k] }
  cur.kids = kids
  return [outer]
}

/**
 * 書式の要素がブロックを抱えていたら、書式をブロックの内側へ配り直す
 * （<span 14px><p>…</p></span> → <p><span 14px>…</span></p>）。
 */
function distribute(makeWrap, kids) {
  if (!kids.some(isBlockNode)) return makeWrap(kids)
  const out = []
  let run = []
  const flush = () => {
    if (run.length && !run.every(isEmptyInline)) out.push(...makeWrap(run))
    else out.push(...run.filter((r) => r.t === 'comment'))
    run = []
  }
  for (const k of kids) {
    if (!isBlockNode(k)) { run.push(k); continue }
    flush()
    if (k.name === 'p' || HEADINGS.has(k.name) || k.name === 'li' || k.name === 'td' || k.name === 'th') k.kids = distribute(makeWrap, k.kids)
    out.push(k)
  }
  flush()
  return out
}

/**
 * 図として描かれる `[[…]]`（画像・動画・音声・埋め込み）か。kuro-links.js の
 * classifyLink の media / iframe と同じ見分け（このファイルは import できないので写し）。
 * 段落の中に置くと、ブラウザは図の手前で段落を閉じる —— 開いて保存すると段落の外へ出る。
 */
function isFigureToken(tok) {
  const m = /^\[\[([^\]|[]+)(?:\|([^\]]*))?\]\]$/.exec(tok)
  if (!m) return false
  const [, slug, label] = m
  if (label === '') return false   // [[x|]] は URL カード（段落の中に置ける）
  if (/^(img|vid|aud|mid)-/.test(slug) || /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|ogg|mov|mp3|wav|aac|flac|m4a)(\?.*)?$/i.test(slug)) return true
  if (/^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch|shorts\/)|youtu\.be\/|vimeo\.com\/\d|player\.vimeo\.com\/video\/|google\.[a-z.]+\/maps|maps\.google\.)/i.test(slug)) return true
  if (/^https?:/.test(slug) && label !== undefined) {
    const params = (label.includes('|') ? label.slice(0, label.indexOf('|')) : label).trim()
    return params === '' || params.split(',').every((t) => /^\d+%$/.test(t.trim()) || ['left', 'right', 'center'].includes(t.trim()))
  }
  return false
}

/** 段落の直下の文字から、図の `[[…]]` をブロックとして切り出す。 */
function splitFigureTokens(kids) {
  if (!kids.some((k) => k.t === 'text' && k.raw.includes('[['))) return kids
  const out = []
  for (const k of kids) {
    if (k.t !== 'text' || !k.raw.includes('[[')) { out.push(k); continue }
    let last = 0
    const re = /\[\[(?!\[)[^\]]+\]\](?!\])/g
    let m
    while ((m = re.exec(k.raw))) {
      if (!isFigureToken(m[0])) continue
      if (m.index > last) out.push({ t: 'text', raw: k.raw.slice(last, m.index) })
      out.push({ t: 'raw', html: m[0], block: true })
      last = m.index + m[0].length
    }
    if (last < k.raw.length) out.push({ t: 'text', raw: k.raw.slice(last) })
  }
  return out
}

/** `[[…]]` だけの文字（空白は可）。 */
const isTokenText = (raw) => /^\s*(?:\[\[(?:(?!\]\]).)+\]\]\]?\s*)+$/.test(raw)

/**
 * 段落・見出しの並び（器の中身）を整える。
 *   mode 'root' / 'box' — 文字の並びは必ず <p> に入れる
 *   mode 'free'         — ブロックと混ざっているときだけ <p> に入れる（li・td・blockquote）
 * 空白だけの並びは捨てる（見えない）。<br> だけの並びは 1 本につき空行 1 つ。
 */
function settleFlow(kids, mode) {
  // 図の [[…]] はブロック。段落で包む前に切り出す（包むと、次に通したときに外へ出る）
  kids = splitFigureTokens(kids)
  const hasBlock = kids.some(isBlockNode)
  if (mode === 'free' && !hasBlock) return kids
  const out = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const visible = run.filter((r) => !isBlank(r))
    if (!visible.length) { out.push(...run.filter((r) => r.t === 'comment')); run = []; return }
    if (mode === 'root' && visible.every((r) => (r.t === 'el' && r.name === 'br') || (r.t === 'text' && isTokenText(r.raw)))) {
      // 本文直下の `[[…]]`（URL カード・メディア）と <br>（カードのあいだの空行）は
      // エディタ自身の保存形（_wrapAtomicBlocks が編集中だけ囲う）。段落で包まない。
      // <br> の data-bid も保存形のうち（1 本で 1 ブロック）
      out.push(...run.filter((r) => !isBlank(r) || r.t === 'comment').map((r) =>
        r.t === 'el' && r.name === 'br' ? el('br', r.attrs.filter((a) => a.name === 'data-bid')) : r))
    } else if (visible.every((r) => r.t === 'el' && r.name === 'br')) {
      for (const br of visible) out.push(el('p', br.attrs.filter((a) => a.name === 'data-bid'), [el('br')]))
    } else if (run.every(isEmptyInline)) {
      out.push(...run.filter((r) => r.t === 'comment'))
    } else {
      // 先頭・末尾の <br> は段落の境目なので要らない（1 本だけの空行は上で扱った）
      while (run.length && (isBlank(run[0]) || (run[0].t === 'el' && run[0].name === 'br'))) {
        const r = run.shift(); if (r.t === 'comment') out.push(r)
      }
      while (run.length && (isBlank(run[run.length - 1]) || (run[run.length - 1].t === 'el' && run[run.length - 1].name === 'br'))) run.pop()
      if (run.length) {
        // 本文直下の書式要素が持っていた data-bid は、包んだ段落のもの
        const p = el('p', [], run)
        const owner = run.find((r) => r.t === 'el' && attrOf(r, 'data-bid') !== null)
        if (owner) {
          p.attrs.push({ name: 'data-bid', value: attrOf(owner, 'data-bid') })
          owner.attrs = owner.attrs.filter((a) => a.name !== 'data-bid')
          // id を運ぶためだけに残した <span> は、運び終えたら外す
          if (owner.name === 'span' && !owner.attrs.length) p.kids.splice(p.kids.indexOf(owner), 1, ...owner.kids)
        }
        out.push(p)
      }
    }
    run = []
  }
  for (const k of kids) {
    if (isBlockNode(k)) {
      flush()
      // 器の外の <li> は <ul> に入れる
      if (k.name === 'li') {
        const prev = out[out.length - 1]
        if (prev?.t === 'el' && prev.name === 'ul' && prev.adopted) prev.kids.push(k)
        else { const ul = el('ul', [], [k]); ul.adopted = true; out.push(ul) }
        continue
      }
      out.push(k)
    } else run.push(k)
  }
  flush()
  return out
}

/** 空の段落の扱い（R4 を引き継ぐ）。null = 捨てる。 */
function settleEmptyLine(nd, nested) {
  if (nd.kids.some((k) => !isEmptyInline(k) && !(k.t === 'el' && k.name === 'br'))) return nd
  const brs = nd.kids.filter((k) => k.t === 'el' && k.name === 'br').length
  if (!brs) return null
  if (nested && nd.name === 'p') return el('br')
  nd.kids = [el('br')]
  return nd
}

/**
 * 見出し・段落がブロックを抱えていたら解く（R7）。最初の文字の並びは元の
 * タグのまま、後の並びは段落になる。data-bid は 1 つだけ残す（R8）。
 */
function splitLine(nd) {
  if (!nd.kids.some(isBlockNode)) return [nd]
  const out = []
  let run = []
  const flush = () => {
    if (!run.length) return
    if (!run.every(isEmptyInline)) {
      const lead = out.length === 0
      out.push(lead ? { ...nd, kids: run } : el('p', [], run))
    }
    run = []
  }
  for (const k of nd.kids) {
    if (isBlockNode(k)) { flush(); out.push(k) } else run.push(k)
  }
  flush()
  const bid = attrOf(nd, 'data-bid')
  out.forEach((o, ix) => {
    if (!o.attrs) return   // 図の [[…]] など、属性を持たない節
    if (o === out[0]) {
      if (bid && attrOf(o, 'data-bid') !== bid) o.attrs = [{ name: 'data-bid', value: bid }, ...(o.attrs || []).filter((a) => a.name !== 'data-bid')]
    } else if (o.attrs && o !== nd) o.attrs = o.attrs.filter((a) => a.name !== 'data-bid')
    else if (ix > 0) o.attrs = o.attrs.filter((a) => a.name !== 'data-bid')
  })
  return out
}

/** 外した要素の data-bid / id を、最初にできたブロックへ移す（ページ内リンクと同期を守る）。 */
function carryIdentity(from, blocks) {
  const first = blocks.find((b) => b.t === 'el' && isBlockNode(b))
  if (!first) return blocks
  for (const a of functionalAttrs(from)) {
    if (attrOf(first, a.name) === null) first.attrs = [...first.attrs, { ...a }]
  }
  return blocks
}

/** 子を変換する。 */
function convertKids(kids, ctx) {
  const out = []
  for (const k of kids) out.push(...convertNode(k, ctx))
  return out
}

/** 生の文字をそのまま取り出す（pre の中身。<br> は改行）。 */
function rawText(nd) {
  if (nd.t === 'text') return nd.raw
  if (nd.t === 'comment') return ''
  if (nd.name === 'br') return '\n'
  return nd.kids.map(rawText).join('')
}

/** 書式の要素（<span> など）。tag = 残すタグ（null は外す）。 */
function convertInline(nd, ctx, tag, extraAttrs = []) {
  const sm = styleMap(attrOf(nd, 'style'))
  // <font color size face> は <span> の書き方へ
  if (nd.name === 'font') {
    if (attrOf(nd, 'color') && !sm.has('color')) sm.set('color', attrOf(nd, 'color'))
    const sz = parseInt(attrOf(nd, 'size'), 10)
    if (FONT_TAG_SIZES[sz] && !sm.has('font-size')) sm.set('font-size', `${FONT_TAG_SIZES[sz]}%`)
    if (attrOf(nd, 'face') && !sm.has('font-family')) sm.set('font-family', attrOf(nd, 'face'))
  }
  const { wraps, pct } = inlineWrappers(sm, ctx)
  // 同じ意味のタグを二重にしない（<strong style="font-weight:700">）
  const own = wraps.filter((w) => w.name !== tag)
  const kids = convertKids(nd.kids, { ...ctx, pct })
  const keep = functionalAttrs(nd)
  const make = (inner) => {
    const fresh = own.map((w) => el(w.name, w.attrs.map((a) => ({ ...a }))))
    let res = nest(fresh, inner)
    if (tag) res = [el(tag, [...extraAttrs, ...keep.map((a) => ({ ...a }))], res)]
    else if (keep.length && res.length === 1 && res[0].t === 'el') res[0].attrs = [...res[0].attrs, ...keep]
    else if (keep.length) res = [el('span', keep.map((a) => ({ ...a })), res)]
    return res
  }
  const res = distribute(make, kids)
  return res.filter((r) => !(r.t === 'el' && INLINE_NAMES.has(r.name) && isEmptyInline(r)))
}

/** 意味を持たない器（div・section…）。中にブロックが無ければ段落にする。 */
function convertContainer(nd, ctx, lineStyle = true) {
  const kids = convertKids(nd.kids, ctx)
  if (!kids.some(isBlockNode)) {
    if (kids.every(isEmptyInline)) {
      const brs = kids.filter((k) => k.t === 'el' && k.name === 'br')
      if (!brs.length) return carryIdentity(nd, kids.filter((k) => k.t === 'comment'))
      return ctx.nested ? [el('br')] : [el('p', buildAttrs(nd), [el('br')])]
    }
    const style = lineStyle ? styleText(lineDecls(styleMap(attrOf(nd, 'style')))) : null
    if (ctx.nested && !ctx.flowBlocks) return kids
    const p = settleEmptyLine(el('p', buildAttrs(nd, { style }), kids), false)
    return p ? [p] : []
  }
  // 外した器の中身は親の並びに入る。本文直下なら本文直下と同じ扱い（カード・<br> を包まない）
  return carryIdentity(nd, settleFlow(kids, ctx.nested ? 'box' : 'root'))
}

/** 表を組み直す。 */
function convertTable(nd, ctx) {
  const before = []
  const rows = []
  const cols = []
  const cctx = { ...ctx, nested: true, inTable: true, pct: ctx.pct }
  const takeRow = (tr) => {
    const cells = []
    for (const c of tr.kids) {
      if (c.t === 'el' && (c.name === 'td' || c.name === 'th')) cells.push(convertCell(c, cctx))
      else if (c.t === 'el' || (c.t === 'text' && /\S/.test(c.raw))) {
        // セルの外の文字は直前のセルへ（文字は消さない）
        const conv = convertNode(c, cctx)
        if (cells.length) cells[cells.length - 1].kids.push(...conv)
        else cells.push(el('td', [{ name: 'contenteditable', value: 'true' }], conv))
      }
    }
    rows.push({ tr, cells })
  }
  const walk = (kids) => {
    for (const c of kids) {
      if (c.t !== 'el') {
        if (c.t === 'text' && /\S/.test(c.raw)) before.push(el('p', [], [c]))
        continue
      }
      if (c.name === 'tr') takeRow(c)
      else if (c.name === 'tbody' || c.name === 'thead' || c.name === 'tfoot') walk(c.kids)
      else if (c.name === 'colgroup') {
        const span = parseInt(attrOf(c, 'span'), 10)
        const own = c.kids.filter((k) => k.t === 'el' && k.name === 'col')
        if (own.length) own.forEach((col) => cols.push(...colWidths(col)))
        else cols.push(...colWidths(c, Number.isInteger(span) && span > 0 ? span : 1))
      } else if (c.name === 'col') cols.push(...colWidths(c))
      else if (c.name === 'td' || c.name === 'th') takeRow(el('tr', [], [c]))
      else if (c.name === 'caption') before.push(...convertContainer(c, { ...ctx, nested: false }))
      else before.push(...convertNode(c, ctx))
    }
  }
  walk(nd.kids)
  if (!rows.length) return [...before]

  // 長方形にする（足りない枠は空のセルで埋める）
  const occupied = []
  let width = 0
  rows.forEach(({ cells }, r) => {
    occupied[r] = occupied[r] || []
    let c = 0
    for (const cell of cells) {
      while (occupied[r][c]) c++
      const cs = cellSpanOf(cell, 'colspan')
      const rs = Math.min(cellSpanOf(cell, 'rowspan'), rows.length - r)
      if (rs > 1) setSpan(cell, 'rowspan', rs)
      else setSpan(cell, 'rowspan', 1)
      for (let dr = 0; dr < rs; dr++) {
        occupied[r + dr] = occupied[r + dr] || []
        for (let dc = 0; dc < cs; dc++) occupied[r + dr][c + dc] = true
      }
      c += cs
    }
    width = Math.max(width, occupied[r].length)
  })
  rows.forEach(({ cells }, r) => {
    const filled = occupied[r].filter(Boolean).length
    for (let k = filled; k < width; k++) cells.push(el('td', [{ name: 'contenteditable', value: 'true' }], [el('br')]))
  })

  const out = []
  if (cols.length === width && cols.every((w) => w && w.unit === cols[0].unit)) {
    const sum = cols.reduce((a, w) => a + w.n, 0)
    // 既に合計 100% なら数字に触らない（割り直すと桁がずれ、保存のたびに変わる）
    const asIs = cols[0].unit === '%' && Math.abs(sum - 100) < 0.05
    if (sum > 0) out.push(el('colgroup', [], cols.map((w) => el('col', [{ name: 'style', value: `width: ${asIs ? w.raw : (w.n / sum * 100).toFixed(4)}%` }]))))
  }
  out.push(el('tbody', [], rows.map(({ tr, cells }) => el('tr', functionalAttrs(tr), cells))))
  return [...before, el('table', buildAttrs(nd, { cls: 'kuro-table' }), out)]
}

function colWidths(col, count = null) {
  const span = count ?? (parseInt(attrOf(col, 'span'), 10) || 1)
  const raw = styleMap(attrOf(col, 'style')).get('width') ?? attrOf(col, 'width')
  let w = null
  const m = /^([\d.]+)\s*(px|%)?$/.exec(String(raw ?? '').trim())
  if (m && parseFloat(m[1]) > 0) w = { n: parseFloat(m[1]), raw: m[1], unit: m[2] || 'px' }
  return Array.from({ length: Math.max(1, Math.min(span, 1000)) }, () => w)
}

function cellSpanOf(cell, name) {
  const v = attrOf(cell, name)
  return /^\d+$/.test(String(v ?? '')) && Number(v) > 0 ? Math.min(Number(v), 1000) : 1
}

function setSpan(cell, name, v) {
  cell.attrs = cell.attrs.filter((a) => a.name !== name)
  if (v > 1) cell.attrs.push({ name, value: String(v) })
}

function convertCell(nd, ctx) {
  const sm = styleMap(attrOf(nd, 'style'))
  const decls = []
  const bg = cssColor(sm.get('background-color') ?? sm.get('background') ?? attrOf(nd, 'bgcolor'))
  if (bg) decls.push(['background-color', bg])
  const fg = cssColor(sm.get('color'))
  if (fg) decls.push(['color', fg])
  const all = sm.get('border')
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const b = borderValue(sm.get(`border-${side}`) ?? all)
    if (b) decls.push([`border-${side}`, b])
  }
  const va = String(sm.get('vertical-align') ?? attrOf(nd, 'valign') ?? '').toLowerCase()
  if (VALIGNS.has(va)) decls.push(['vertical-align', va])
  const al = alignValue(sm.get('text-align') ?? attrOf(nd, 'align'))
  if (al) decls.push(['text-align', al])
  const lh = lineHeightValue(sm.get('line-height'))
  if (lh) decls.push(['line-height', lh])
  const extra = []
  const cs = cellSpanOf(nd, 'colspan')
  if (cs > 1) extra.push({ name: 'colspan', value: String(cs) })
  const rs = cellSpanOf(nd, 'rowspan')
  if (rs > 1) extra.push({ name: 'rowspan', value: String(rs) })
  extra.push({ name: 'contenteditable', value: 'true' })
  let kids = settleFlow(convertKids(nd.kids, ctx), 'free').map((k) => (k.t === 'el' && k.name === 'p' ? settleEmptyLine(k, false) ?? el('br') : k))
  if (kids.every(isEmptyInline)) kids = [el('br')]
  const cell = el(nd.name, buildAttrs(nd, { style: styleText(decls), extra }), kids)
  cell.attrs = cell.attrs.filter((a) => !['colspan', 'rowspan'].includes(a.name) || extra.some((e) => e.name === a.name))
  return cell
}

function convertList(nd, ctx) {
  const sm = styleMap(attrOf(nd, 'style'))
  const isOl = nd.name === 'ol'
  const cls = classesOf(nd)
  let kind = null
  for (const c of cls) {
    const m = isOl ? /^kuro-list-(.+)$/.exec(c) : /^kuro-ul-(.+)$/.exec(c)
    if (m && (isOl ? OL_STYLES : UL_STYLES).has(m[1])) kind = m[1]
  }
  if (!kind) {
    const lst = String(sm.get('list-style-type') ?? sm.get('list-style') ?? attrOf(nd, 'type') ?? '').toLowerCase().trim()
    if (isOl) {
      if (/alpha|latin|^a$/i.test(lst)) kind = 'alpha'
      else if (/katakana/.test(lst)) kind = 'kata'
      else if (lst === 'none') kind = 'none'
    } else if (['disc', 'circle', 'square', 'none'].includes(lst)) kind = lst
  }
  const decls = []
  const ml = indentValue(sm.get('margin-left'))
  if (ml) decls.push(['margin-left', ml])
  if (isOl) {
    const mc = cssColor(sm.get('--kuro-marker-color'))
    if (mc) decls.push(['--kuro-marker-color', mc])
  }
  const extra = []
  if (isOl) {
    const st = attrOf(nd, 'start')
    if (/^-?\d+$/.test(String(st ?? '')) && Number(st) !== 1) extra.push({ name: 'start', value: String(Number(st)) })
  }
  const lctx = { ...ctx, nested: true }
  const items = []
  let loose = []
  const flushLoose = () => {
    if (!loose.length) return
    if (!loose.every(isEmptyInline)) items.push(el('li', [], loose))
    loose = []
  }
  for (const k of nd.kids) {
    if (k.t === 'el' && k.name === 'li') { flushLoose(); items.push(...convertNode(k, lctx)); continue }
    const conv = convertNode(k, lctx)
    for (const c of conv) {
      if (c.t === 'el' && (c.name === 'ul' || c.name === 'ol') && !loose.length && items.length) {
        items[items.length - 1].kids.push(c)   // 項目の外の入れ子 → 直前の項目の子
      } else if (c.t === 'el' && c.name === 'li') { flushLoose(); items.push(c) } else loose.push(c)
    }
  }
  flushLoose()
  if (!items.length) return []
  const prefix = isOl ? 'kuro-list-' : 'kuro-ul-'
  return [el(nd.name, buildAttrs(nd, { cls: kind ? prefix + kind : null, style: styleText(decls), extra }), items)]
}

/** 1 つの節を、エディタの形の節の並びへ。 */
function convertNode(nd, ctx) {
  if (nd.t === 'text') return [nd]
  if (nd.t === 'comment') return /^\s*kuro(?:cms)?[-:]/i.test(nd.data) ? [nd] : []
  const name = nd.name

  // エディタ自身の部品（data-kuro-*）は中まで触らない
  if (nd.attrs.some((a) => a.name.startsWith('data-kuro'))) return [{ t: 'raw', html: serializeOriginal(nd), block: !INLINE_NAMES.has(name) }]

  // 知らない名前: `-` 付きは独自要素なので外す。無いものは文中の山括弧の書き損じ → 文字に戻す。
  // 名前を知っていても、属性名に英数字以外が混ざるものは書き損じ（"<A função de uso…>" は
  // ブラウザでは <a função de uso…> と読まれて文字が消える）
  const prose = nd.attrs.some((a) => /[^\w:.-]/.test(a.name))
  if (!HTML_NAMES.has(name) || prose) {
    const kids = convertKids(nd.kids, ctx)
    if (name.includes('-') && !prose) return kids
    // 書かれたとおりの綴りで文字に戻す（大文字・属性の並びも元のまま）
    const asText = (s) => ({ t: 'text', raw: s.replace(/&(?![#a-zA-Z0-9]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') })
    return nd.closed ? [asText(nd.src), ...kids, asText(nd.closed)] : [asText(nd.src), ...kids]
  }

  // 前の版が <p> に化けさせた器を戻す（R5 を引き継ぐ）
  if (name === 'p' && (classesOf(nd).some((c) => c === 'kuro-callout' || c === 'kuro-roundbox') || attrOf(nd, 'data-language') !== null)) {
    if (attrOf(nd, 'data-language') !== null) return codeBlock(nd, nd.kids.map(rawText).join('').replace(/\r\n?/g, '\n'))
    return convertNode({ ...nd, name: 'div' }, ctx)
  }

  switch (name) {
    case 'p': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const heading = HEADINGS.has(name)
      const sm = styleMap(attrOf(nd, 'style'))
      const kids = splitFigureTokens(convertKids(nd.kids, { ...ctx, inHeading: ctx.inHeading || heading }))
      const line = el(name, buildAttrs(nd, { style: styleText(lineDecls(sm)) }), kids)
      return splitLine(line).flatMap((b) => {
        if (b.t !== 'el' || (b.name !== 'p' && !HEADINGS.has(b.name))) return [b]
        if (b.kids.some(isBlockNode)) return [b]
        const s = settleEmptyLine(b, ctx.nested)
        return s ? [s] : []
      })
    }
    case 'div': {
      const cls = classesOf(nd)
      if (cls.includes('kuro-callout')) {
        let type = 'note'
        for (const c of cls) {
          const m = /^kuro-callout--(.+)$/.exec(c)
          if (m) type = CALLOUT_TYPES.has(m[1]) ? m[1] : (CALLOUT_NEAR[m[1]] ?? type)
        }
        const kids = settleFlow(convertKids(nd.kids, { ...ctx, nested: false }), 'box')
        return [el('div', buildAttrs(nd, { cls: `kuro-callout kuro-callout--${type}` }), kids.length ? kids : [el('p', [], [el('br')])])]
      }
      if (cls.includes('kuro-roundbox')) {
        const alRaw = String(attrOf(nd, 'data-align') ?? '').toLowerCase()
        const align = ['left', 'center', 'right'].includes(alRaw) ? alRaw : 'center'
        const wRaw = parseFloat(attrOf(nd, 'data-width') ?? styleMap(attrOf(nd, 'style')).get('width') ?? '100')
        const w = `${nearest(BOX_WIDTHS, Number.isFinite(wRaw) ? wRaw : 100)}%`
        const style = align === 'left' ? `width: ${w}; float: left; margin: 0 1em 1em 0`
          : align === 'right' ? `width: ${w}; float: right; margin: 0 0 1em 1em`
          : `width: ${w}; display: block; margin: 0 auto`
        const attrs = buildAttrs(nd, { cls: 'kuro-roundbox', style, extra: [{ name: 'data-align', value: align }, { name: 'data-width', value: w }] })
        const kids = settleFlow(convertKids(nd.kids, { ...ctx, nested: false }), 'box')
        return [el('div', attrs, kids.length ? kids : [el('p', [], [el('br')])])]
      }
      // 古い形のコードブロック（行ごとの <div data-language>）→ エディタのコードブロック
      const lines = nd.kids.filter((k) => k.t === 'el')
      if (lines.length && lines.every((k) => k.name === 'div' && attrOf(k, 'data-language') !== null) &&
          nd.kids.every((k) => k.t === 'el' || isBlank(k))) {
        const text = lines.map(rawText).join('\n').replace(/\r\n?/g, '\n')
        return codeBlock(nd, text)
      }
      return convertContainer(nd, ctx)
    }
    case 'blockquote': {
      const kids = settleFlow(convertKids(nd.kids, { ...ctx, nested: false }), 'free')
      return kids.every(isEmptyInline) ? kids.filter((k) => k.t === 'comment') : [el('blockquote', buildAttrs(nd), kids)]
    }
    case 'ul': case 'ol': case 'dir': case 'menu':
      return convertList(name === 'ol' ? nd : { ...nd, name: 'ul' }, ctx)
    case 'li': {
      const sm = styleMap(attrOf(nd, 'style'))
      const extra = []
      const v = attrOf(nd, 'value')
      if (/^-?\d+$/.test(String(v ?? ''))) extra.push({ name: 'value', value: String(Number(v)) })
      const kids = settleFlow(convertKids(nd.kids, { ...ctx, nested: true }), 'free')
        .flatMap((k) => (k.t === 'el' && k.name === 'p' && !k.kids.some(isBlockNode) ? [settleEmptyLine(k, false) ?? null].filter(Boolean) : [k]))
      return [el('li', buildAttrs(nd, { style: styleText(lineDecls(sm, { indent: false })), extra }), kids)]
    }
    case 'table':
      return convertTable(nd, ctx)
    case 'tbody': case 'thead': case 'tfoot': case 'tr': case 'td': case 'th': case 'caption':
      // 表の外に出てきた表の部品 → 表に入れ直す
      return convertTable(el('table', [], [nd]), ctx)
    case 'colgroup': case 'col':
      return []
    case 'pre': {
      let text = nd.kids.map(rawText).join('')
      if (nd.kids[0]?.t === 'text' && nd.kids[0].raw.startsWith('\n')) text = text.slice(1)
      return codeBlock(nd, text.replace(/\r\n?/g, '\n'))
    }
    case 'hr': {
      const sm = styleMap(attrOf(nd, 'style'))
      const c = cssColor(sm.get('border-top-color')) ?? cssColor(sm.get('border-color'))
        ?? cssColor(borderColorOf(sm.get('border-top') ?? sm.get('border'))) ?? cssColor(sm.get('background-color'))
        ?? cssColor(sm.get('color')) ?? cssColor(attrOf(nd, 'color'))
      return [el('hr', buildAttrs(nd, { cls: 'kuro-hr', style: c ? `border-top-color: ${c}` : null }))]
    }
    case 'br': return [el('br', nd.attrs.filter((a) => a.name === 'data-bid'))]
    case 'wbr': return []
    case 'img': {
      const src = attrOf(nd, 'src')
      if (!src || !isSafeContentUrl(src, 'src')) return []
      const extra = [{ name: 'src', value: src }, { name: 'alt', value: attrOf(nd, 'alt') ?? '' }]
      if (attrOf(nd, 'title')) extra.push({ name: 'title', value: attrOf(nd, 'title') })
      return [el('img', buildAttrs(nd, { extra }))]
    }
    case 'video': case 'audio': {
      const extra = []
      for (const a of ['src', 'poster']) if (attrOf(nd, a)) extra.push({ name: a, value: attrOf(nd, a) })
      extra.push({ name: 'controls', value: null })
      const sources = nd.kids.filter((k) => k.t === 'el' && k.name === 'source' && attrOf(k, 'src'))
        .map((k) => el('source', [{ name: 'src', value: attrOf(k, 'src') }, ...(attrOf(k, 'type') ? [{ name: 'type', value: attrOf(k, 'type') }] : [])]))
      if (!extra.some((a) => a.name === 'src') && !sources.length) return []
      return [el(name, buildAttrs(nd, { extra }), sources)]
    }
    case 'iframe': {
      const extra = []
      for (const a of ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'loading', 'title', 'referrerpolicy']) {
        const v = nd.attrs.find((x) => x.name === a)
        if (v) extra.push({ name: a, value: v.value })
      }
      return [el('iframe', buildAttrs(nd, { extra }))]
    }
    case 'source': case 'track': case 'input': case 'param': case 'embed':
      return []
    case 'figure': {
      const cls = classesOf(nd).filter((c) => /^kuro-media-wrap(--(left|right|center|video|audio|iframe))?$/.test(c))
      const MEDIA = new Set(['img', 'video', 'audio', 'iframe', 'picture'])
      const hasMedia = (n) => n.t === 'el' && (MEDIA.has(n.name) || n.kids.some(hasMedia))
      // 画像などを抱えた図は図のまま（エディタはこれを 1 つのブロックとして扱う）
      if (!cls.includes('kuro-media-wrap') && !nd.kids.some(hasMedia)) return convertContainer(nd, ctx)
      const w = String(styleMap(attrOf(nd, 'style')).get('width') ?? '')
      const style = /^\d+(\.\d+)?%$/.test(w) && w !== '100%' ? `width: ${w}` : null
      const kids = convertKids(nd.kids, { ...ctx, inFigure: true }).filter((k) => !isBlank(k))
      return [el('figure', buildAttrs(nd, { cls: cls.length ? cls.join(' ') : null, style }), kids)]
    }
    case 'figcaption':
      if (ctx.inFigure) return [el('figcaption', buildAttrs(nd), convertKids(nd.kids, ctx))]
      return convertContainer(nd, ctx, false)
    case 'summary': case 'legend':
      return convertContainer(nd, ctx, false)
    case 'dl':
      return carryIdentity(nd, settleFlow(convertKids(nd.kids, ctx), ctx.nested ? 'free' : 'box'))
    case 'dt': {
      const kids = convertKids(nd.kids, ctx)
      if (kids.some(isBlockNode)) return carryIdentity(nd, settleFlow(kids, 'box'))
      return kids.every(isEmptyInline) ? [] : [el('p', buildAttrs(nd), [el('strong', [], kids)])]
    }
    case 'dd': {
      const kids = convertKids(nd.kids, ctx)
      if (kids.some(isBlockNode)) return carryIdentity(nd, settleFlow(kids, 'box'))
      return kids.every(isEmptyInline) ? [] : [el('p', buildAttrs(nd, { style: 'padding-left: 2em' }), kids)]
    }
    case 'address': case 'article': case 'aside': case 'body': case 'center': case 'details':
    case 'dialog': case 'fieldset': case 'footer': case 'form': case 'header': case 'hgroup':
    case 'html': case 'main': case 'nav': case 'search': case 'section': case 'listing':
      return convertContainer(nd, ctx)
    case 'textarea': {
      // 書きかけの欄でも、中身は文字（約束 1）
      const t = nd.kids.map(rawText).join('').replace(/</g, '&lt;')
      return /\S/.test(t) ? [el('p', [], [{ t: 'text', raw: t }])] : []
    }
    case 'head': case 'script': case 'style': case 'template': case 'title': case 'meta': case 'link':
    case 'base': case 'noscript': case 'svg': case 'math': case 'object': case 'applet': case 'frameset':
    case 'frame': case 'noframes': case 'canvas': case 'datalist': case 'xmp': case 'plaintext':
    case 'select': case 'optgroup': case 'map': case 'area': case 'keygen': case 'menuitem': case 'portal':
      // 本文に置けないもの（R0 と同じ）。<select> の選択肢は文字ではなく欄の中身
      if (name === 'xmp' || name === 'plaintext') return [el('p', [], [{ t: 'text', raw: nd.kids.map(rawText).join('') }])]
      return []
    // ── 書式 ──
    case 'strong': case 'b': {
      // 太さを normal に戻した <b> は太字ではない（Google ドキュメントの全体の包み）
      const w = String(styleMap(attrOf(nd, 'style')).get('font-weight') ?? '').toLowerCase()
      return convertInline(nd, ctx, w === 'normal' || w === '400' || w === 'lighter' ? null : 'strong')
    }
    case 'em': case 'i': return convertInline(nd, ctx, 'em')
    case 'u': case 'ins': return convertInline(nd, ctx, 'u')
    case 's': case 'strike': case 'del': return convertInline(nd, ctx, 's')
    case 'code': case 'tt': case 'samp': case 'var': return convertInline(nd, ctx, 'code')
    case 'kbd': return convertInline(nd, ctx, 'kbd')
    case 'ruby': {
      const size = classesOf(nd).find((c) => c === 'kuro-ruby--sm' || c === 'kuro-ruby--lg')
      return convertInline(nd, ctx, 'ruby', size ? [{ name: 'class', value: size }] : [])
    }
    case 'rt': return convertInline(nd, ctx, 'rt')
    case 'rp': return convertInline(nd, ctx, 'rp')
    case 'rb': case 'rtc': return convertInline(nd, ctx, null)
    case 'a': {
      const href = attrOf(nd, 'href')
      // 危ない行き先（javascript: など）は行き先ごと持たない＝ただの文字
      if (!href || !isSafeContentUrl(href, 'href')) return convertInline({ ...nd, attrs: nd.attrs.filter((a) => a.name !== 'href') }, ctx, null)
      const tok = linkToken(nd, href)
      if (tok) return convertInline({ ...nd, kids: [{ t: 'text', raw: escText(tok, false) }] }, ctx, null)
      const extra = [{ name: 'href', value: href }]
      if (String(attrOf(nd, 'target') ?? '').toLowerCase() === '_blank') extra.push({ name: 'target', value: '_blank' })
      const rel = String(attrOf(nd, 'rel') ?? '').toLowerCase().split(/\s+/).filter((r) => ['noopener', 'noreferrer', 'nofollow', 'ugc', 'sponsored'].includes(r))
      if (rel.length) extra.push({ name: 'rel', value: rel.join(' ') })
      if (attrOf(nd, 'title')) extra.push({ name: 'title', value: attrOf(nd, 'title') })
      const keep = buildAttrs(nd, { extra })
      return convertInline({ ...nd, attrs: nd.attrs.filter((a) => !keep.some((k) => k.name === a.name) || a.name === 'style') }, ctx, 'a', keep)
    }
    case 'option':
      return []
    default:
      // span・font・small・mark・button・label… 意味を持たない包み → 書式だけ残して外す
      return convertInline(nd, ctx, null)
  }
}

/** 同じ id は最初の 1 つだけ（外した包みの id が中の複数のブロックへ配られることがある）。 */
function uniqueIds(nodes, seen) {
  const out = []
  for (const n of nodes) {
    if (n.t !== 'el') { out.push(n); continue }
    const id = attrOf(n, 'id')
    let drop = false
    if (id !== null) {
      if (seen.has(id)) { n.attrs = n.attrs.filter((a) => a.name !== 'id'); drop = n.name === 'span' && !n.attrs.length }
      else seen.add(id)
    }
    if (n.kids) n.kids = uniqueIds(n.kids, seen)
    // id を運ぶためだけの <span> は外す
    if (drop) out.push(...n.kids)
    else out.push(n)
  }
  return out
}

/** 文字参照を解いた素の文字。 */
function plainText(raw) {
  return canon(raw, true).replace(/&(amp|lt|gt|quot|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0' })[n])
}

/**
 * 外の書き方のリンク `<a href="https://…">文字</a>` → エディタの記法 `[[URL|文字]]`
 * （文字が URL そのものなら `[[URL]]`）。null = 記法にできない（<a> のまま残す）:
 * http(s) 以外・中に文字以外がある・記法を壊す ] | を含む・図として描かれる・
 * 機能の記法（data-*・id。ブロックの名札 data-bid は除く）や rel の nofollow / sponsored / ugc を持つ。
 */
function linkToken(nd, href) {
  const url = plainText(href).trim()
  if (!/^https?:\/\//i.test(url) || /[\]|\s]/.test(url)) return null
  // data-bid / data-cbid はブロックの名札（段落へ移る）なので妨げない
  if (nd.attrs.some((a) => a.name === 'id' || (a.name.startsWith('data-') && a.name !== 'data-bid' && a.name !== 'data-cbid'))) return null
  // 検索エンジンへの申告（広告・ユーザー投稿）は記法では書けない＝<a> のまま
  if (/\b(nofollow|sponsored|ugc)\b/i.test(attrOf(nd, 'rel') ?? '')) return null
  if (!nd.kids.every((k) => k.t === 'text')) return null
  const text = plainText(nd.kids.map((k) => k.raw).join('')).replace(/\s+/g, ' ').trim()
  if (!text || /[\]\[|]/.test(text)) return null
  const tok = text === url ? `[[${url}]]` : `[[${url}|${text}]]`
  return isFigureToken(tok) ? null : tok
}

/**
 * 本文の大きさ（px）＝文字数でいちばん多い文字の大きさ。大きさの書かれていない文字は
 * 16px として数える。外の HTML は計算済みの 14px などを全部に焼き込むので、それを
 * 100% として読む（そうしないと本文全体が「小さい文字」になる）。見出しは数えない。
 */
function bodyFontPx(root) {
  const tally = new Map()
  const walk = (nd, px) => {
    for (const k of nd.kids ?? []) {
      if (k.t === 'text') {
        const len = plainText(k.raw).trim().length
        if (len) tally.set(px, (tally.get(px) ?? 0) + len)
        continue
      }
      if (k.t !== 'el' || RAW_NAMES.has(k.name) || /^h[1-6]$/.test(k.name)) continue
      walk(k, elementFontPx(k, px))
    }
  }
  walk(root, 16)
  let best = 16
  for (const [px, n] of tally) if (n > (tally.get(best) ?? 0)) best = px
  return best
}

function elementFontPx(nd, px) {
  let v = styleMap(attrOf(nd, 'style')).get('font-size')
  if (!v && nd.name === 'font' && FONT_TAG_SIZES[parseInt(attrOf(nd, 'size'), 10)]) v = `${FONT_TAG_SIZES[parseInt(attrOf(nd, 'size'), 10)]}%`
  const s = String(v ?? '').trim().toLowerCase()
  let m
  if ((m = /^([\d.]+)px$/.exec(s))) return parseFloat(m[1])
  if ((m = /^([\d.]+)pt$/.exec(s))) return parseFloat(m[1]) * 4 / 3
  if ((m = /^([\d.]+)rem$/.exec(s))) return parseFloat(m[1]) * 16
  if ((m = /^([\d.]+)%$/.exec(s))) return px * parseFloat(m[1]) / 100
  if ((m = /^([\d.]+)em$/.exec(s))) return px * parseFloat(m[1])
  if (s in FONT_KEYWORDS) return FONT_KEYWORDS[s] * 16 / 100
  return px
}

/** エディタのコードブロック（行番号は data-gutter に焼き込む。_serializeCodeBlocksToHtml と同じ形）。 */
function codeBlock(nd, text) {
  const lines = Math.max(1, text.split('\n').length)
  const gutter = Array.from({ length: lines }, (_, k) => k + 1).join('\n')
  const attrs = buildAttrs(nd, { cls: 'kuro-code', extra: [{ name: 'data-gutter', value: gutter }] })
    .filter((a) => a.name !== 'data-language' && a.name !== 'spellcheck')
  return [el('pre', attrs, [el('code', [], [{ t: 'text', raw: text }])])]
}

function borderColorOf(v) {
  if (!v) return null
  for (const p of String(v).split(/\s+(?![^(]*\))/)) if (cssColor(p) && !BORDER_STYLES.has(p.toLowerCase()) && p.toLowerCase() !== 'none') return p
  return null
}

/**
 * 本文 HTML を KuroEditor の形にする（上の一覧）。冪等。
 * @param {string} html
 * @returns {string}
 */
export function conformContentHtml(html) {
  if (typeof html !== 'string' || html === '') return html ?? ''
  const root = parseLoose(html)
  const kids = settleFlow(convertKids(root.kids, { pct: 100, inHeading: false, nested: false, basePx: bodyFontPx(root) }), 'root')
  // 段落の中の空白だけの段落など、最後に空になったものを落とす
  return sanitizeContentHtml(serializeNodes(uniqueIds(kids, new Set())))
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * 本文 HTML を KuroEditor の形にする（{@link conformContentHtml}）。
 * 以前の名前のまま残す（KuroCMS・Admin がこの名前で呼ぶ）。
 * @param {string} html
 * @param {object} [_opts]  以前の clipboardRepair。いまは意味を持たない（常に形へ揃える）
 * @returns {string}
 */
export function normalizeContentHtml(html, _opts = {}) {
  return conformContentHtml(html)
}

/**
 * {@link normalizeContentHtml} が何を変えるかを、変えずに数える（保守画面の予告）。
 * 正は `changed`。内訳は目安（文字列で数える）。
 * @param {string} html
 */
export function inspectContentHtml(html, _opts = {}) {
  const stats = {
    bTags: 0, boldSpans: 0, divBlocks: 0, emptyBlocks: 0,
    blockDecor: 0, nestedBlocks: 0, unsafe: 0, changed: false,
  }
  if (typeof html !== 'string' || html === '') return stats
  if (html.includes('<')) stats.unsafe = sanitizeWithCount(html).removed
  const count = (re) => (html.match(re) || []).length
  stats.bTags = count(/<b[\s>]/gi)
  stats.boldSpans = count(/<span\b[^>]*font-weight\s*:\s*(?:bold|bolder|[6-9]00)/gi)
  stats.divBlocks = count(/<div(?![^>]*\bkuro-)(?![^>]*data-kuro)[\s>]/gi)
  stats.emptyBlocks = count(/<(p|div)\b[^>]*>\s*(?:<br\s*\/?>\s*)*<\/\1>/gi)
  stats.blockDecor = count(/<(?:p|li|h[1-6]|ol|ul|td|th|div)\b[^>]*style="[^"]*font-(?:size|weight)/gi)
  stats.nestedBlocks = count(/<(?:p|h[1-6])\b[^>]*>(?:(?!<\/(?:p|h[1-6])>)[\s\S])*?<(?:p|div|ul|ol|table|h[1-6])[\s>]/gi)
  stats.changed = normalizeContentHtml(html) !== html
  return stats
}
