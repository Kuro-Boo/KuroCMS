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
      // closing tag — unwind to the matching open element
      const idx = stack.map((s) => s.name).lastIndexOf(name)
      if (idx <= 0) { ok = false; continue }
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

/** true when the node subtree renders nothing but (optional) line breaks. */
function isBlankContent(children) {
  for (const c of children) {
    if (c.type === 'text') {
      // &nbsp; counts as content; plain whitespace does not
      if (c.raw.trim() !== '' && !/^(?:\s|<!--[\s\S]*?-->)*$/.test(c.raw)) return false
    } else if (c.type === 'el') {
      if (c.name === 'br') continue
      return false
    }
  }
  return true
}

/** true when any direct child is a block element. */
function hasBlockChild(node) {
  return node.children.some((c) => c.type === 'el' && BLOCK_TAGS.has(c.name))
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
 * Rewrite one element list in place, returning the replacement list.
 * @param {Array} children
 * @param {boolean} topLevel  true for the document's own top-level run
 */
function transformChildren(children, topLevel) {
  const out = []
  for (const node of children) {
    if (node.type !== 'el') { out.push(node); continue }

    // Opaque subtree (code / pre) — copy through untouched.
    if (OPAQUE_TAGS.has(node.name)) { out.push(node); continue }

    node.children = transformChildren(node.children, false)

    // R1 — <b> is execCommand's spelling of bold; the corpus uses <strong>.
    if (node.name === 'b') node.name = 'strong'

    // R2 — a span that only says "font-weight: bold" is a <strong> in disguise.
    if (isBoldOnlySpan(node)) {
      node.name = 'strong'
      node.attrs = identityAttrsOnly(node.attrs)
    }

    if (node.name === 'div' || node.name === 'p') {
      // R4 — an empty block. At the top level it is a blank PARAGRAPH; nested
      // inside another block it cannot be one, so it degrades to a line break.
      if (isBlankContent(node.children)) {
        if (topLevel) {
          node.name = 'p'
          node.children = [{ type: 'el', name: 'br', attrs: '', children: [], void: true }]
          out.push(node)
        } else {
          out.push({ type: 'el', name: 'br', attrs: '', children: [], void: true })
        }
        continue
      }
      // R3 — a <div> is either a paragraph (rename) or a bare wrapper around
      // blocks (unwrap). Only attribute-less wrappers are unwrapped: a div with
      // a style/class is carrying layout we must not discard.
      if (node.name === 'div') {
        if (hasBlockChild(node)) {
          if (hasOnlyIdentityAttrs(node.attrs)) { out.push(...node.children); continue }
        } else {
          node.name = 'p'
        }
      }
    }
    out.push(node)
  }
  return out
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Normalize content HTML to KuroEditor's canonical shape.
 *
 *   <b>/bold-only <span>  → <strong>
 *   <div> paragraph       → <p>
 *   <div> block wrapper   → unwrapped (only when it carries no styling)
 *   empty block           → <p><br></p> at top level, <br> when nested
 *
 * Malformed input is returned unchanged.
 * @param {string} html
 * @returns {string}
 */
export function normalizeContentHtml(html) {
  if (typeof html !== 'string' || html === '') return html ?? ''
  const { root, ok } = parseTree(html)
  if (!ok) return html
  root.children = transformChildren(root.children, true)
  return serialize(root)
}

/**
 * Report what {@link normalizeContentHtml} would change, without changing it.
 * Used by the maintenance screen to show a preview count per rule.
 * @param {string} html
 * @returns {{ bTags:number, boldSpans:number, divBlocks:number, emptyBlocks:number, changed:boolean }}
 */
export function inspectContentHtml(html) {
  const stats = { bTags: 0, boldSpans: 0, divBlocks: 0, emptyBlocks: 0, changed: false }
  if (typeof html !== 'string' || html === '') return stats
  const { root, ok } = parseTree(html)
  if (!ok) return stats
  const walk = (children, topLevel) => {
    for (const node of children) {
      if (node.type !== 'el' || OPAQUE_TAGS.has(node.name)) continue
      if (node.name === 'b') stats.bTags++
      else if (isBoldOnlySpan(node)) stats.boldSpans++
      else if (node.name === 'div' || node.name === 'p') {
        if (isBlankContent(node.children)) { if (node.name === 'div' || !topLevel) stats.emptyBlocks++ }
        else if (node.name === 'div') stats.divBlocks++
      }
      walk(node.children, false)
    }
  }
  walk(root.children, true)
  stats.changed = normalizeContentHtml(html) !== html
  return stats
}
