/**
 * KuroEditor — content HTML normalization (DOM-free, shared).
 * ============================================================================
 * ONE implementation of "what canonical saved HTML looks like", used by every
 * ingest path so they cannot drift:
 *
 *   - the editor's rich-paste sanitizer  (_sanitizePastedHTML)
 *   - the host's API/save boundary       (KuroCMS worker, no DOM available)
 *   - the maintenance cleaner            (existing stored articles)
 *
 * It is deliberately written WITHOUT a DOM (same constraint as blocks.js) so
 * the browser and a Cloudflare Worker run the exact same code.
 *
 * Why these rules exist — measured on the live corpus (1,639 translations):
 *
 *   bold was stored FOUR ways: <strong> 17,668 / <b> 647 /
 *   span[font-weight:700] 23 / span[font-weight:bolder] 2.
 *   <strong> comes from the API, <b> from execCommand('bold') in the editor,
 *   the spans from external paste. Same meaning, three spellings.
 *
 *   paragraphs were stored as BOTH <p> and <div>, and empty lines as
 *   <div><br></div>. Root cause: contenteditable's defaultParagraphSeparator
 *   was never set, so Chrome's default (div) applied on every Enter. The
 *   editor now pins it to "p"; this module repairs what already exists and
 *   anything arriving from outside.
 *
 *   copying inside the editor and pasting back destroyed the structure
 *   (2026-08-16, Entamy 管理画面の規約編集): one document went from 1 <h1> to
 *   35, gained 21 <h1><p> nestings and 46 `font-size: 15px; font-weight: 400`.
 *   Chrome's clipboard serializer is the source — it inlines computed styles
 *   and wraps a fragment in the element the selection started inside. There is
 *   no browser setting that turns this off, so R6/R7/R8 undo it here, and the
 *   editor also writes canonical HTML to the clipboard on copy so the damage
 *   never reaches other applications either.
 *
 * Refuses (returns the input unchanged) on malformed HTML, like blocks.js.
 */

/** HTML void elements — no closing tag, never affect nesting depth. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose presence means "this container holds blocks, not a paragraph". */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Subtrees whose text is significant — never rewritten. */
const OPAQUE_TAGS = new Set(['pre', 'code', 'textarea', 'script', 'style'])

/** font-weight values that mean "bold". */
const BOLD_WEIGHTS = new Set(['bold', 'bolder', '600', '700', '800', '900'])

/**
 * Blocks that must never carry a font-size / font-weight of their own (R6).
 *
 * The editor writes a size ONLY as `<span style="font-size:…">` (_applyFontSize
 * wraps the selection in a span) and bold only as `<strong>`. So a size or a
 * weight sitting on a BLOCK cannot have come from this editor — it is Chrome's
 * clipboard serializer, which inlines the element's computed style on copy.
 * That is where `font-size: 15px; font-weight: 400` comes from: a <p> that had
 * been swallowed by a heading inherits the heading's size, and Chrome writes
 * the value that cancels it back out.
 *
 * The judgement has no grey area, which is why it can be applied blindly:
 * on a span → the writer asked for it, keep it; on a block → foreign, drop it.
 */
const BLOCK_DECOR_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'td', 'th', 'div',
])

/** Declarations removed from {@link BLOCK_DECOR_TAGS} elements. */
const FOREIGN_BLOCK_DECOR = new Set(['font-size', 'font-weight'])

/**
 * Tags whose content model is phrasing only — a block inside one is damage (R7).
 * Chrome produces this when the selection STARTS inside a heading and runs past
 * it: the whole fragment gets wrapped in that heading as a "context element",
 * so an entire article ends up inside a single <h1>.
 */
const PHRASING_ONLY_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

// ── parse ─────────────────────────────────────────────────────────────────────

/**
 * Parse HTML into a shallow tree. Text nodes keep their raw source (entities
 * are never decoded, so serializing back is byte-identical when nothing
 * matched a rule).
 * @param {string} html
 * @returns {{ root: object, ok: boolean }}
 */
function parseTree(html) {
  const root = { type: 'root', children: [] }
  const stack = [root]
  let ok = true
  const n = html.length
  let i = 0
  let textStart = 0

  const flushText = (end) => {
    if (end > textStart) {
      stack[stack.length - 1].children.push({ type: 'text', raw: html.slice(textStart, end) })
    }
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    flushText(lt)

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) { ok = false; break }
      stack[stack.length - 1].children.push({ type: 'text', raw: html.slice(lt, end + 3) })
      i = end + 3
      textStart = i
      continue
    }

    // end of tag, quote-aware
    let j = lt + 1
    let quote = ''
    while (j < n) {
      const ch = html[j]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    if (j >= n) { ok = false; break }
    const tag = html.slice(lt, j + 1)
    i = j + 1
    textStart = i

    const nameMatch = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)
    if (!nameMatch) {
      stack[stack.length - 1].children.push({ type: 'text', raw: tag })
      continue
    }
    const name = nameMatch[1].toLowerCase()

    if (tag[1] === '/') {
      // Closing tag. It must close the element we are actually inside; anything
      // else is mismatched nesting and the whole document is refused.
      //
      // This is not hypothetical: a body containing an unescaped "<A função …>"
      // parses as an <a> that is never closed, and a lenient unwind would make
      // the following </b> close BOTH — emitting a </a> that was never in the
      // source. Browsers recover from that their own way; a normalizer must not
      // guess, so it declines to touch such a document.
      const idx = stack.map((s) => s.name).lastIndexOf(name)
      if (idx <= 0) { ok = false; continue }
      if (idx !== stack.length - 1) { ok = false; break }
      stack.length = idx
      continue
    }

    const selfClosing = VOID_TAGS.has(name) || tag.endsWith('/>')
    const attrs = tag.slice(1 + name.length, tag.length - (tag.endsWith('/>') ? 2 : 1))
    const el = { type: 'el', name, attrs, children: [], void: selfClosing }
    stack[stack.length - 1].children.push(el)
    if (!selfClosing) stack.push(el)
  }
  flushText(n)
  if (stack.length !== 1) ok = false
  return { root, ok }
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serialize(node) {
  if (node.type === 'text') return node.raw
  if (node.type === 'root') return node.children.map(serialize).join('')
  const open = `<${node.name}${node.attrs}${node.void && node.attrs.endsWith('/') ? '' : ''}>`
  if (node.void) return open
  return open + node.children.map(serialize).join('') + `</${node.name}>`
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse a raw attribute string into a lowercase-keyed map. */
function attrMap(attrs) {
  const out = {}
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m
  while ((m = re.exec(attrs))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

/**
 * true when this element's attributes mark it as a structural CONTAINER —
 * a callout, a table wrapper, a code-block widget. A <p> can never legitimately
 * carry these, so seeing them on one means the tag was rewritten by mistake.
 *
 * This exists because an earlier revision of R3 renamed attribute-carrying divs
 * to <p>, which converted 44 callouts and 44 code-block wrappers in the live
 * corpus. Restoring them here makes the normalizer self-healing: re-running it
 * repairs documents damaged by that version instead of needing a rollback.
 */
function isStructuralContainer(attrs) {
  const a = attrMap(attrs)
  if (a['data-language'] !== undefined) return true
  if (a['spellcheck'] !== undefined) return true
  if (a['contenteditable'] !== undefined) return true
  const cls = a['class'] || ''
  return /\bkuro-(callout|table|code|roundbox|media)/.test(cls)
}

/** true when the element carries no attribute other than block identity. */
function hasOnlyIdentityAttrs(attrs) {
  const a = attrMap(attrs)
  return Object.keys(a).every((k) => k === 'data-bid' || k === 'data-cbid')
}

/** Split a style attribute into [prop, value] pairs. */
function styleDecls(style) {
  return style.split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const c = d.indexOf(':')
      return c === -1 ? null : [d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim().toLowerCase()]
    })
    .filter(Boolean)
}

/**
 * true when a <span> means nothing but "bold" — its ONLY styling is a bold
 * font-weight. A span that also carries a size/colour/family is left alone,
 * because collapsing it to <strong> would silently drop that styling.
 */
function isBoldOnlySpan(node) {
  if (node.name !== 'span') return false
  const a = attrMap(node.attrs)
  const keys = Object.keys(a).filter((k) => k !== 'data-bid' && k !== 'data-cbid')
  if (keys.length !== 1 || keys[0] !== 'style') return false
  const decls = styleDecls(a.style)
  return decls.length === 1 && decls[0][0] === 'font-weight' && BOLD_WEIGHTS.has(decls[0][1])
}

/**
 * Classify a block's content for the empty-block rule.
 *
 * The distinction matters because the two blank shapes render DIFFERENTLY:
 *   <p><br></p>  — the <br> forces a line box → one blank line high
 *   <p>\n</p>    — whitespace collapses, no line box → zero height
 * Rewriting the second into the first would insert visible blank lines all
 * through an article, so the two are kept apart.
 *
 * @returns {'content'|'collapsed'|'break'}
 *   content   — renders something
 *   collapsed — whitespace only, occupies no line
 *   break     — one or more <br>, occupies a line
 */
function blankKind(children) {
  let sawBreak = false
  for (const c of children) {
    if (c.type === 'text') {
      // &nbsp; is content; plain whitespace and comments are not
      if (c.raw.trim() !== '' && !/^(?:\s|<!--[\s\S]*?-->)*$/.test(c.raw)) return 'content'
    } else if (c.type === 'el') {
      if (c.name === 'br') { sawBreak = true; continue }
      return 'content'
    }
  }
  return sawBreak ? 'break' : 'collapsed'
}

/** true when any direct child is a block element. */
function hasBlockChild(node) {
  return node.children.some((c) => c.type === 'el' && BLOCK_TAGS.has(c.name))
}

/** Match one attribute in a raw attribute string, quoted or bare. */
const attrRe = (name) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')

const STYLE_ATTR_RE = attrRe('style')
const BID_ATTR_RE = attrRe('data-bid')

/** The captured value of an attrRe match, whichever quoting was used. */
const attrValue = (m) => m[1] ?? m[2] ?? m[3] ?? ''

/**
 * Drop `props` from an element's style attribute, leaving every other
 * declaration BYTE-IDENTICAL (original casing, spacing and order).
 *
 * ⚠ Do not rebuild from {@link styleDecls} — it lowercases values, which would
 *   silently rewrite font-family names and CSS custom properties on any element
 *   this touches. Only the removed declarations may change.
 *
 * @returns {string} the new raw attribute string (the input when nothing matched)
 */
function stripStyleProps(attrs, props) {
  const m = attrs.match(STYLE_ATTR_RE)
  if (!m) return attrs
  const decls = attrValue(m).split(';').map((d) => d.trim()).filter(Boolean)
  const kept = decls.filter((d) => {
    const c = d.indexOf(':')
    return c === -1 || !props.has(d.slice(0, c).trim().toLowerCase())
  })
  if (kept.length === decls.length) return attrs
  const before = attrs.slice(0, m.index)
  const after = attrs.slice(m.index + m[0].length)
  return kept.length ? `${before} style="${kept.join('; ')}"${after}` : before + after
}

/** The element's data-bid, or null. */
function readBid(attrs) {
  const m = attrs.match(BID_ATTR_RE)
  return m ? attrValue(m) : null
}

/** The raw attribute string with any data-bid removed. */
function withoutBid(attrs) {
  const m = attrs.match(BID_ATTR_RE)
  return m ? attrs.slice(0, m.index) + attrs.slice(m.index + m[0].length) : attrs
}

/** The raw attribute string carrying exactly this data-bid. */
function withBid(attrs, bid) {
  return ` data-bid="${bid}"${withoutBid(attrs)}`
}

/** Keep only data-bid / data-cbid from a raw attribute string. */
function identityAttrsOnly(attrs) {
  const a = attrMap(attrs)
  let out = ''
  if (a['data-bid']) out += ` data-bid="${a['data-bid']}"`
  if (a['data-cbid']) out += ` data-cbid="${a['data-cbid']}"`
  return out
}

// ── transform ─────────────────────────────────────────────────────────────────

/**
 * R7 — take the blocks back out of a heading / paragraph that swallowed them.
 *
 *   <h1 data-bid="A">見出し<p data-bid="B">本文</p></h1>
 *     → <h1 data-bid="A">見出し</h1>  <p>本文</p>
 *
 * ## The one invariant: no text is ever lost
 *
 * A tag may be discarded; the characters inside it may not. Everything between
 * the promoted blocks is therefore re-wrapped rather than dropped. The FIRST
 * such run keeps the original tag (that run is the heading's own text — it was
 * a heading before the damage and stays one); later runs became body text the
 * moment a block was opened in front of them, so they become paragraphs.
 * Runs that occupy no line — whitespace between blocks — carry nothing and go.
 *
 * ## R8 — one data-bid, on one block
 *
 * Unwrapping turns one block into several, and collaborative merge requires
 * `data-bid` to be unique per block. Exactly one output keeps an id: the outer
 * element's if it had one (so a block someone else is editing keeps its
 * identity), otherwise whatever the first promoted child already carried. Every
 * other output is stripped and gets a fresh id from `_ensureBlockIds` on load.
 * Leaving two behind is worse than leaving none: `_dedupeNestedBids` would
 * re-issue one of them, and it cannot know which one the other editor meant.
 *
 * ⚠ Attributes other than data-bid on the unwrapped tag are lost when it has no
 *   leading text run. There is no correct place to put them — the tag they
 *   described could not legally exist.
 *
 * @param {object} node  a phrasing-only element with at least one block child
 * @returns {Array} the replacement sibling list
 */
function unwrapPhrasingBlock(node) {
  const outerBid = readBid(node.attrs)
  const out = []
  let run = []

  const flushRun = () => {
    if (!run.length) return
    if (blankKind(run) !== 'collapsed') {
      const lead = out.length === 0
      out.push({
        type: 'el',
        name: lead ? node.name : 'p',
        attrs: lead ? node.attrs : '',
        children: run,
        void: false,
      })
    }
    run = []
  }

  for (const child of node.children) {
    if (child.type === 'el' && BLOCK_TAGS.has(child.name)) {
      flushRun()
      out.push(child)
      continue
    }
    run.push(child)
  }
  flushRun()

  for (let i = 0; i < out.length; i++) {
    if (i > 0) { out[i].attrs = withoutBid(out[i].attrs); continue }
    if (outerBid && readBid(out[i].attrs) !== outerBid) out[i].attrs = withBid(out[i].attrs, outerBid)
  }
  return out
}

/**
 * Rewrite one element list in place, returning the replacement list.
 * @param {Array} children
 * @param {boolean} topLevel  true for the document's own top-level run
 */
function transformChildren(children, topLevel, clipboardRepair) {
  const out = []
  for (const node of children) {
    if (node.type !== 'el') { out.push(node); continue }

    // Opaque subtree (code / pre) — copy through untouched.
    if (OPAQUE_TAGS.has(node.name)) { out.push(node); continue }

    node.children = transformChildren(node.children, false, clipboardRepair)

    // R6 — a size/weight on a BLOCK is never this editor's; it is Chrome's
    // computed style, inlined on copy. Drop it before anything else looks at
    // the element (clearing the style attribute can make a div bare, which is
    // what R3 below needs to see to recognise it as a paragraph).
    if (clipboardRepair && BLOCK_DECOR_TAGS.has(node.name)) {
      node.attrs = stripStyleProps(node.attrs, FOREIGN_BLOCK_DECOR)
    }

    // R7 — a heading or paragraph holding blocks is Chrome's context wrapper.
    // Undo it here, before the div/p rules below reason about the contents.
    if (clipboardRepair && PHRASING_ONLY_TAGS.has(node.name) && hasBlockChild(node)) {
      out.push(...unwrapPhrasingBlock(node))
      continue
    }

    // R1 — <b> is execCommand's spelling of bold; the corpus uses <strong>.
    if (node.name === 'b') node.name = 'strong'

    // R2 — a span that only says "font-weight: bold" is a <strong> in disguise.
    if (isBoldOnlySpan(node)) {
      node.name = 'strong'
      node.attrs = identityAttrsOnly(node.attrs)
    }

    // R5 — repair: a <p> wearing container attributes is a container that was
    // wrongly renamed. Put the tag back before any other block rule looks at it.
    if (node.name === 'p' && isStructuralContainer(node.attrs)) {
      node.name = 'div'
      out.push(node)
      continue
    }

    if (node.name === 'div' || node.name === 'p') {
      // R4 — a blank block. Only its TAG is normalized; whether it occupies a
      // line is preserved exactly, so the rewrite never adds or removes
      // vertical space (see blankKind).
      const kind = blankKind(node.children)
      if (kind === 'break') {
        if (topLevel) {
          // canonical blank paragraph — one <br>, however many it had
          node.name = 'p'
          node.children = [{ type: 'el', name: 'br', attrs: '', children: [], void: true }]
          out.push(node)
        } else {
          // nested: cannot be a paragraph, but the line it occupied must stay
          out.push({ type: 'el', name: 'br', attrs: '', children: [], void: true })
        }
        continue
      }
      if (kind === 'collapsed') {
        // Occupies no line. A nested one contributes nothing at all → drop it;
        // a top-level one only gets its tag unified (content left untouched, so
        // it keeps collapsing).
        if (!topLevel) continue
        if (node.name === 'div') node.name = 'p'
        out.push(node)
        continue
      }
      // R3 — only a BARE <div> is treated as a paragraph.
      //
      // "It has no block children, so it must be a paragraph" is wrong: the
      // corpus stores real containers as divs — kuro-callout (402), code-block
      // wrappers carrying spellcheck / data-language (99), kuro-table (22) —
      // and an earlier version of this rule renamed 44 callouts and 44 code
      // blocks into <p>, which is destructive (a <p> cannot hold block content,
      // and the editor's callout/code handling looks for the container).
      //
      // So the tag is only rewritten when the div carries NOTHING but block
      // identity. Anything with a class / style / data-* is left exactly as it
      // is: we cannot prove it is a paragraph, so we do not claim it is one.
      if (node.name === 'div' && hasOnlyIdentityAttrs(node.attrs)) {
        if (hasBlockChild(node)) { out.push(...node.children); continue }
        node.name = 'p'
      }
    }
    out.push(node)
  }
  return out
}

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

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Normalize content HTML to KuroEditor's canonical shape.
 *
 *   <b>/bold-only <span>  → <strong>
 *   <div> paragraph       → <p>
 *   <div> block wrapper   → unwrapped (only when it carries no styling)
 *   empty block           → <p><br></p> at top level, <br> when nested
 *   font-size/weight on a block → dropped (kept on <span>)
 *   heading/paragraph holding blocks → unwrapped, one data-bid kept
 *
 *   script / style / on* / javascript: など（R0）→ 落とす（壊れた HTML にも掛かる）
 *
 * Malformed input keeps its shape (only R0 is applied).
 *
 * @param {string} html
 * @param {{ clipboardRepair?: boolean }} [opts]
 *   clipboardRepair — apply R6/R7/R8, the repairs for Chrome's clipboard
 *   serializer. Default true: every path that WRITES content wants them.
 *
 *   Pass false for a bulk sweep over ALREADY PUBLISHED content. Unlike R1–R5,
 *   these three CHANGE HOW A PAGE LOOKS, and an article that went out with the
 *   damage baked in would suddenly render differently. That is not a repair the
 *   reader asked for, so a sweep must not perform it as a side effect of
 *   "normalizing formatting".
 *
 *   This is "don't do it silently", NOT "never do it". Fixing existing articles
 *   deliberately is legitimate — the caller just has to say so, having been told
 *   what will change. KuroCMS's maintenance screen exposes exactly that: an
 *   unchecked-by-default box, with a preview of the counts.
 *   (Decision recorded 2026-08-16; see "貼り付け破壊の修正仕様" at admin.entamy.com (KuroEditor))
 * @returns {string}
 */
export function normalizeContentHtml(html, opts = {}) {
  if (typeof html !== 'string' || html === '') return html ?? ''
  const { root, ok } = parseTree(html)
  // 壊れた HTML は形を推測して直さない —— が、守り（R0）は必ず掛ける。
  if (!ok) return sanitizeContentHtml(html)
  root.children = transformChildren(root.children, true, opts.clipboardRepair !== false)
  // R0 は最後。上の規則が要素を外した跡で、文字とタグが繋がりうるため。
  return sanitizeContentHtml(serialize(root))
}

/**
 * Report what {@link normalizeContentHtml} would change, without changing it.
 * Used by the maintenance screen to show a preview count per rule.
 * @param {string} html
 * @returns {{ bTags:number, boldSpans:number, divBlocks:number, emptyBlocks:number,
 *             blockDecor:number, nestedBlocks:number, unsafe:number, changed:boolean }}
 */
export function inspectContentHtml(html, opts = {}) {
  const clipboardRepair = opts.clipboardRepair !== false
  const stats = {
    bTags: 0, boldSpans: 0, divBlocks: 0, emptyBlocks: 0,
    blockDecor: 0, nestedBlocks: 0, unsafe: 0, changed: false,
  }
  if (typeof html !== 'string' || html === '') return stats
  // R0 は壊れた HTML にも掛かるので、木を作る前に数える
  if (html.includes('<')) stats.unsafe = sanitizeWithCount(html).removed
  const { root, ok } = parseTree(html)
  if (!ok) return stats
  const walk = (children, topLevel) => {
    for (const node of children) {
      if (node.type !== 'el' || OPAQUE_TAGS.has(node.name)) continue
      // Counted independently of the chain below: an element can both carry a
      // foreign size AND hold blocks, and each is a separate repair.
      if (clipboardRepair && BLOCK_DECOR_TAGS.has(node.name) &&
          stripStyleProps(node.attrs, FOREIGN_BLOCK_DECOR) !== node.attrs) stats.blockDecor++
      if (clipboardRepair && PHRASING_ONLY_TAGS.has(node.name) && hasBlockChild(node)) stats.nestedBlocks++
      if (node.name === 'b') stats.bTags++
      else if (isBoldOnlySpan(node)) stats.boldSpans++
      else if (node.name === 'div' || node.name === 'p') {
        const kind = blankKind(node.children)
        if (kind !== 'content') { if (node.name === 'div' || !topLevel) stats.emptyBlocks++ }
        else if (node.name === 'div') stats.divBlocks++
      }
      walk(node.children, false)
    }
  }
  walk(root.children, true)
  stats.changed = normalizeContentHtml(html, opts) !== html
  return stats
}
