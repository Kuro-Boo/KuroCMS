// KuroEditor — DOM 非依存の [[...]] リンク/メディアレンダラ (kuro-links.js)
// editor.js から抽出した純文字列関数群。ブラウザでも Cloudflare Worker でも同一に動く。
// 公開ビルド(ホスト)はこの renderSpecialLinks を import して単一の正とする。

/**
 * Default slug → URL resolver.
 * Slugs starting with "http" are external; everything else becomes a relative path.
 * @param {string} slug
 * @returns {string}
 */
export function defaultResolver(slug) {
  return slug.startsWith('http') ? slug : `/${slug}`
}

/**
 * Media-asset ID prefix. A [[slug]] whose slug matches this is a stored media
 * reference (image / video / audio) — the PREFIX is the canonical "this is
 * media" signal, so detection never depends on the resolved URL's extension
 * being in MEDIA_EXT_RE. `mid-` is KuroEditor's own generic upload id; hosts
 * that mint typed ids (KuroCMS: img-/vid-/aud-) are recognised here too so the
 * judgment agrees across editor and public build.
 */
export const MEDIA_ID_RE = /^(img|vid|aud|mid)-/

/** File extensions treated as media (image, video, or audio) — for bare URLs. */
export const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|ogg|mov|mp3|wav|aac|flac|m4a)(\?.*)?$/i

export const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?.*)?$/i

export const AUDIO_EXT_RE = /\.(mp3|wav|aac|flac|m4a|oga)(\?.*)?$/i

/**
 * Media kind ('image' | 'video' | 'audio') for a media slug/url.
 * The typed ID PREFIX is authoritative — `vid-`→video, `aud-`→audio,
 * `img-`/`mid-`→image — so the kind is correct even when the resolved URL has
 * no file extension (e.g. a blob: ObjectURL). Only when the prefix is untyped
 * (a bare http URL) do we fall back to the URL extension, defaulting to image.
 * @param {string} slug
 * @param {string} url
 * @returns {'image'|'video'|'audio'}
 */
export function mediaKindFromSlug(slug, url = '') {
  if (/^vid-/.test(slug)) return 'video'
  if (/^aud-/.test(slug)) return 'audio'
  if (/^(img|mid)-/.test(slug)) return 'image'
  return VIDEO_EXT_RE.test(url) ? 'video' : AUDIO_EXT_RE.test(url) ? 'audio' : 'image'
}

/** Normalize a host's supported-kinds declaration to a Set (null → all kinds). */
export function normalizeMediaKinds(kinds) {
  if (!kinds) return null // null / undefined = all kinds supported
  const set = new Set(Array.isArray(kinds) ? kinds : [kinds])
  return set.size ? set : null
}

/** Inline globe icon for URL cards (self-contained SVG, currentColor). */
export const URL_CARD_ICON =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.5"/>' +
  '<ellipse cx="8" cy="8" rx="2.8" ry="6.5"/>' +
  '<line x1="1.5" y1="8" x2="14.5" y2="8"/>' +
  '</svg>'

/** Escape text for safe insertion as HTML text / attribute value. */
export function _escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Sanitize a host-supplied image URL (favicon / og:image) for use in a src
 * attribute. Only http(s) and data:image URLs are allowed — anything else
 * (javascript:, etc.) is dropped so the untrusted fetched metadata can't
 * inject an active URL.
 */
export function _safeImgUrl(u) {
  if (typeof u !== 'string') return ''
  const t = u.trim()
  return /^(https?:\/\/|data:image\/)/i.test(t) ? t : ''
}

/**
 * Inner markup of a URL card (icon + title/url lines + arrow).
 *
 * Two-step display:
 *   - Step 1 (no meta): the title is what can be derived from the URL itself
 *     without a network fetch — the hostname for http(s) URLs, the slug as-is
 *     for internal slugs (the browser can't read a foreign page's <title> due
 *     to CORS). This renders synchronously so the screen never blocks.
 *   - Step 2 (meta present): the host-provided metadata upgrades the card in
 *     place — real title, description, favicon, and thumbnail. All fetched
 *     text is escaped (untrusted, comes from an arbitrary external page).
 *
 * @param {string} slug - raw slug/URL from the [[slug|]] notation
 * @param {string} url  - resolved href
 * @param {{title?:string,description?:string,favicon?:string,image?:string}|null} [meta]
 */
export function _urlCardInner(slug, url, meta = null) {
  let title = slug
  const isHttp = /^https?:\/\//i.test(slug)
  if (isHttp) {
    try { title = new URL(slug).hostname } catch {}
  }
  const sub = isHttp ? slug : url
  const m = (meta && typeof meta === 'object') ? meta : null

  const favUrl = m ? _safeImgUrl(m.favicon) : ''
  const icon = favUrl
    ? `<img class="kuro-url-card__favicon" src="${_escapeHtml(favUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : URL_CARD_ICON

  const titleText = (m && typeof m.title === 'string' && m.title.trim()) ? m.title.trim() : title
  const descText  = (m && typeof m.description === 'string') ? m.description.trim() : ''
  const descHtml  = descText
    ? `<span class="kuro-url-card__desc">${_escapeHtml(descText)}</span>` : ''

  const imgUrl = m ? _safeImgUrl(m.image) : ''
  const thumb  = imgUrl
    ? `<img class="kuro-url-card__thumb" src="${_escapeHtml(imgUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''

  return `<span class="kuro-url-card__icon">${icon}</span>` +
    `<span class="kuro-url-card__body">` +
      `<span class="kuro-url-card__title">${_escapeHtml(titleText)}</span>` +
      descHtml +
      `<span class="kuro-url-card__url">${_escapeHtml(sub)}</span>` +
    `</span>` +
    thumb +
    `<span class="kuro-url-card__arrow">↗</span>`
}

/**
 * URL カードの「読込みエラー」内側マークアップ。対象ページが 404/到達不可と
 * 確定したとき、カード内側をこれに差し替える（呼び手は `kuro-url-card--error`
 * クラスを付与）。エディタ側の 2 段階表示（onFetchUrlMeta が {error:'target'} を
 * 返した場合）と公開ページのクライアント enrich が同一マークアップを出すための
 * 単一の正。`_urlCardInner` と同じ骨格でタイトルだけ固定文言にする。
 */
export function _urlCardErrorInner(slug, url) {
  const isHttp = /^https?:\/\//i.test(slug)
  const sub = isHttp ? slug : url
  return `<span class="kuro-url-card__icon">${URL_CARD_ICON}</span>` +
    `<span class="kuro-url-card__body">` +
      `<span class="kuro-url-card__title">読込みエラー</span>` +
      `<span class="kuro-url-card__url">${_escapeHtml(sub)}</span>` +
    `</span>` +
    `<span class="kuro-url-card__arrow">↗</span>`
}

/**
 * メディア（img/vid/aud）の src ロード失敗プレースホルダ（.kuro-media-broken）の
 * マークアップ。エディタ（wysiwyg の error イベントハンドラ）と公開ページ（同等の
 * error リスナ）が同一の壊れ表示を出すための単一の正。CSS は content.css に置き、
 * 公開・編集の双方に配られる。src はテキストとして安全にエスケープする。
 */
export function buildBrokenMedia(src) {
  return `<div class="kuro-media-broken" contenteditable="false">` +
    `<span class="kuro-media-broken__icon">🔗</span>` +
    `<span class="kuro-media-broken__label">メディアを読込できません</span>` +
    `<span class="kuro-media-broken__url">${_escapeHtml(src)}</span>` +
    `</div>`
}

/**
 * Build the URL card anchor for [[slug|]] — the "explicitly no title" form.
 * contenteditable=false so the card behaves as one atomic object while editing
 * (deleted in one Backspace, no caret inside).
 */
export function _buildUrlCard(slug, url) {
  const ext = slug.startsWith('http')
  return `<a href="${url}"${ext ? ' target="_blank" rel="noopener"' : ''} class="kuro-url-card" contenteditable="false" data-kuro-wiki="${encodeURIComponent('[[' + slug + '|]]')}">${_urlCardInner(slug, url)}</a>`
}

/** Shared [[...]] token regex — single-pass, order card > wiki > hyper. */
export const LINK_TOKEN_RE = /\[\[\[([^\]]+)\]\]\]|\[\[([^\]|]+)\|([^\]]*)\]\]|\[\[([^\]]+)\]\]/g

/**
 * Classify one [[...]] token into a host-agnostic descriptor. This is the
 * DRIFT-PRONE judgment (media detection, embed detection, param parsing,
 * link/card priority) that MUST agree between the editor and the public build —
 * so both share this one function. Markup emission is each host's own concern.
 * @param {{card?:string, wikiSlug?:string, wikiLabel?:string, hyper?:string}} groups
 *   Regex capture groups from LINK_TOKEN_RE.
 * @param {(slug:string)=>string} [resolver]
 * @param {Set<string>|null} [supportedKinds] host's supported media kinds
 *   (null = all). A media token whose kind is not in the set is returned with
 *   `unsupported: true` so the host can render a placeholder instead of a
 *   broken player. Use normalizeMediaKinds() to build the Set.
 * @returns {{kind:string,[k:string]:any}} descriptor (kind: card|urlcard|iframe|media|wikilink|hyperlink|text)
 */
export function classifyLink(groups, resolver = defaultResolver, supportedKinds = null) {
  const { card, wikiSlug, wikiLabel, hyper } = groups
  const unsupported = (kind) => !!supportedKinds && !supportedKinds.has(kind)
  if (card !== undefined) {
    return { kind: 'card', raw: card, url: resolver(card) }
  }
  if (wikiSlug !== undefined) {
    const url = resolver(wikiSlug)
    if (wikiLabel === '') return { kind: 'urlcard', slug: wikiSlug, url }
    const embedUrl = resolveEmbedUrl(url)
    if (embedUrl) {
      const { size, align } = parseMediaParams(wikiLabel)
      return { kind: 'iframe', slug: wikiSlug, url, embedUrl, size, align }
    }
    const isMedia = MEDIA_ID_RE.test(wikiSlug)
      || MEDIA_EXT_RE.test(url)
      || (wikiSlug.startsWith('http') && _looksLikeMediaParams(wikiLabel))
    if (isMedia) {
      const { size, align, link } = parseMediaParams(wikiLabel)
      const mediaKind = mediaKindFromSlug(wikiSlug, url)
      return { kind: 'media', slug: wikiSlug, url, size, align, link, mediaKind, unsupported: unsupported(mediaKind) }
    }
    return { kind: 'wikilink', slug: wikiSlug, url, label: wikiLabel, isExternal: wikiSlug.startsWith('http') }
  }
  if (hyper !== undefined) {
    const url = resolver(hyper)
    const embedUrl = resolveEmbedUrl(url)
    if (embedUrl) return { kind: 'iframe', slug: hyper, url, embedUrl, size: null, align: null }
    const isMedia = MEDIA_ID_RE.test(hyper) || MEDIA_EXT_RE.test(url)
    if (isMedia) {
      const mediaKind = mediaKindFromSlug(hyper, url)
      return { kind: 'media', slug: hyper, url, size: null, align: null, link: null, mediaKind, unsupported: unsupported(mediaKind) }
    }
    return { kind: 'hyperlink', slug: hyper, url, isExternal: hyper.startsWith('http') }
  }
  return { kind: 'text' }
}

/**
 * Convert [[...]] special link syntax in raw text/HTML to EDITOR markup
 * (round-trip attrs data-kuro-* so getContent() can restore the token).
 * Judgment is delegated to classifyLink(); this only emits markup.
 * @param {string} text
 * @param {(slug: string) => string} [resolver]
 * @param {Set<string>|null} [supportedKinds] host's supported media kinds
 *   (null = all). Unsupported-kind media renders a neutral placeholder that
 *   still round-trips its token (data-kuro-media) and is selectable/deletable.
 * @returns {string}
 */
export function renderSpecialLinks(text, resolver = defaultResolver, supportedKinds = null) {
  return text.replace(LINK_TOKEN_RE, (match, card, wikiSlug, wikiLabel, hyper) => {
    const d = classifyLink({ card, wikiSlug, wikiLabel, hyper }, resolver, supportedKinds)
    switch (d.kind) {
      case 'card':
        return `<a href="${d.url}" target="_blank" rel="noopener" class="kuro-card-link" data-kuro-card="${encodeURIComponent('[[[' + d.raw + ']]]')}">${d.raw}</a>`
      case 'urlcard':
        return _buildUrlCard(d.slug, d.url)
      case 'iframe': {
        const enc = buildMediaAttr(d.slug, d.size, d.align)
        return _buildIframeFigure(d.embedUrl, enc, d.size, d.align)
      }
      case 'media': {
        const enc = buildMediaAttr(d.slug, d.size, d.align, d.link)
        const sizeStyle = (d.size && d.size !== '100%') ? ` style="width:${d.size}"` : ''
        const alignClass = d.align ? ` kuro-media-wrap--${d.align}` : ''
        const hrefAttr = d.link ? ` data-kuro-href="${d.link}"` : ''
        const linkBtn = d.link ? `<a class="kuro-media-open-link" href="${d.link}" target="_blank" rel="noopener" contenteditable="false">↗ URLを新規タブで開く</a>` : ''
        if (d.unsupported) {
          // このホストが対応しない種別（例: 画像のみのアプリに動画/音声）。壊れた
          // プレーヤーではなく【リンクカード】へ落とす。data-kuro-media を保持するので
          // getContent() でトークンは失われず（保存フォーマットは対応ホストと同一）、
          // 対応ホストでは元どおり再生される。URL 指定（解決後が http(s)）ならクリック
          // で開けるカード、内部 ID など URL が無い場合は href なしのカード。
          // ⚠ kuro-url-card クラスは付けない — URL カードの編集 UI が data-kuro-wiki
          // 前提でトークンを [[slug|]] へ書き換え、メディアトークンを壊すため。専用
          // クラスにして見た目（ボックス）だけ url-card と共有する。
          const isHttp = /^https?:\/\//i.test(d.url)
          const linkUrl = d.link || (isHttp ? d.url : null)
          const attrs = linkUrl ? ` href="${linkUrl}" target="_blank" rel="noopener"` : ''
          return `<a class="kuro-media-fallback-card"${attrs} contenteditable="false" data-kuro-media="${enc}">${_urlCardInner(d.slug, d.slug)}</a>`
        }
        if (d.mediaKind === 'video') {
          return `<figure class="kuro-media-wrap kuro-media-wrap--video${alignClass}"${sizeStyle} data-kuro-media="${enc}"${hrefAttr}><video src="${d.url}" controls class="kuro-media kuro-media--video"></video>${linkBtn}</figure>`
        }
        if (d.mediaKind === 'audio') {
          return `<figure class="kuro-media-wrap kuro-media-wrap--audio${alignClass}"${sizeStyle} data-kuro-media="${enc}"${hrefAttr}><audio src="${d.url}" controls class="kuro-media kuro-media--audio"></audio>${linkBtn}</figure>`
        }
        return `<figure class="kuro-media-wrap${alignClass}"${sizeStyle} data-kuro-media="${enc}"${hrefAttr}><img src="${d.url}" alt="" class="kuro-media">${linkBtn}</figure>`
      }
      case 'wikilink':
        return `<a href="${d.url}" data-kuro-wiki="${encodeURIComponent('[[' + d.slug + '|' + d.label + ']]')}">${d.label}</a>`
      case 'hyperlink':
        return `<a href="${d.url}"${d.isExternal ? ' target="_blank" rel="noopener"' : ''} data-kuro-link="${encodeURIComponent('[[' + d.slug + ']]')}">${d.slug}</a>`
      default:
        return match
    }
  })
}

/**
 * Return true when `label` (the wikiLabel part of [[slug|label]]) looks like
 * media params rather than display text.
 *
 * Valid param tokens: integers followed by %, or the words left / right / center.
 * Multiple tokens are comma-separated; an optional link URL follows a second '|'.
 *
 * Examples that return true:
 *   "60%"         "right"        "60%,right"
 *   "center"      "50%,left"     "60%,right|https://example.com"
 *   "|https://example.com"                       (link-only)
 *
 * Examples that return false (treated as display text → wiki link):
 *   "続きを読む"   "Click here"   "My image"   "Learn more"
 *
 * The heuristic is strict: every comma-separated token before the optional '|'
 * must be EITHER a percentage integer OR one of the three alignment words.
 * This makes false positives extremely unlikely in real content.
 */
export function _looksLikeMediaParams(label) {
  if (!label) return false
  // Strip the link-URL part (everything from the first '|' onward)
  const paramsPart = label.indexOf('|') !== -1 ? label.slice(0, label.indexOf('|')) : label
  const trimmed = paramsPart.trim()
  // "|https://…" → empty params part = link-only → media params ✓
  if (trimmed === '') return true
  // All comma-separated tokens must be size% or align keyword
  return trimmed
    .split(',')
    .map(s => s.trim())
    .every(t => /^\d+%$/.test(t) || t === 'left' || t === 'right' || t === 'center')
}

/** Build a responsive 16:9 iframe figure element string. */
export function _buildIframeFigure(embedUrl, enc, size, align) {
  const sizeStyle  = (size && size !== '100%') ? ` style="width:${size}"` : ''
  const alignClass = align ? ` kuro-media-wrap--${align}` : ''
  return `<figure class="kuro-media-wrap kuro-media-wrap--iframe${alignClass}"${sizeStyle} data-kuro-media="${enc}"><div class="kuro-iframe-wrap"><iframe src="${embedUrl}" class="kuro-media kuro-media--iframe" allowfullscreen frameborder="0" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" title="埋め込み動画"></iframe></div></figure>`
}

/**
 * Parse the params portion of a media slug (the part after the first '|').
 * Format: "size,align|linkURL"  where the second '|' separates the link URL
 * from size/align so link URLs containing commas remain unambiguous.
 *
 * Examples:
 *   "60%,right"                      → { size:'60%', align:'right', link:null }
 *   "60%,right|https://example.com"  → { size:'60%', align:'right', link:'https://…' }
 *   "|https://example.com"           → { size:null, align:null, link:'https://…' }
 *
 * @param {string|null} params — raw param string (not URI-encoded)
 * @returns {{ size: string|null, align: 'left'|'center'|'right'|null, link: string|null }}
 */
export function parseMediaParams(params) {
  const result = { size: null, align: null, link: null }
  if (!params) return result

  // The link URL (if any) is separated from size/align by a '|'.
  // This allows link URLs to contain commas without ambiguity.
  let sizeAlignPart = params
  const pipeIdx = params.indexOf('|')
  if (pipeIdx !== -1) {
    result.link = params.slice(pipeIdx + 1).trim() || null
    sizeAlignPart = params.slice(0, pipeIdx)
  }

  for (const part of sizeAlignPart.split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^\d+%$/.test(part)) result.size = part
    else if (part === 'left' || part === 'right' || part === 'center') result.align = part
  }
  return result
}

/**
 * Build a `data-kuro-media` attribute value from slug + optional params.
 * Returns URI-encoded string ready to drop into an HTML attribute.
 *
 * Storage format (decoded):  "slug"  /  "slug|size,align"  /  "slug|size,align|linkURL"
 *
 * @param {string}      slug  — e.g. "mid-001" or "https://…/img.png"
 * @param {string|null} size  — e.g. "60%" or null
 * @param {string|null} align — e.g. "right" or null
 * @param {string|null} link  — click-through URL, or null
 * @returns {string} URI-encoded attribute value
 */
export function buildMediaAttr(slug, size = null, align = null, link = null) {
  const sizeAlign = [size, align].filter(Boolean).join(',')
  let params = sizeAlign
  if (link) params = (sizeAlign ? sizeAlign + '|' : '') + link
  return encodeURIComponent(params ? `${slug}|${params}` : slug)
}

/**
 * Convert a public video-service URL to its embed URL if the service is recognised.
 * Returns null when the URL is not a known embeddable service.
 *
 * Currently supported:
 *   - YouTube  watch?v=   / youtu.be/
 *   - Vimeo    vimeo.com/VIDEO_ID
 *
 * @param {string} url
 * @returns {string|null} embed URL, or null
 */
export function resolveEmbedUrl(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')

    // ── YouTube ────────────────────────────────────────────────────────────
    if (host === 'youtube.com') {
      const v = u.searchParams.get('v')
      if (v) return `https://www.youtube.com/embed/${v}`
      // /shorts/VIDEO_ID
      const shorts = u.pathname.match(/^\/shorts\/([^/]+)/)
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1)   // e.g. /dQw4w9WgXcQ → dQw4w9WgXcQ
      if (id) return `https://www.youtube.com/embed/${id}`
    }

    // ── Vimeo ──────────────────────────────────────────────────────────────
    if (host === 'vimeo.com') {
      const id = u.pathname.replace(/\D/g, '')   // keep only digits from /VIDEO_ID
      if (id) return `https://player.vimeo.com/video/${id}`
    }
  } catch {}
  return null
}
