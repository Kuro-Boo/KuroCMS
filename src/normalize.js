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
 * Malformed input is returned unchanged.
 *
 * @param {string} html
 * @param {{ clipboardRepair?: boolean }} [opts]
 *   clipboardRepair — apply R6/R7/R8, the repairs for Chrome's clipboard
 *   serializer. Default true: every path that WRITES content wants them.
 *
 *   Pass false for a bulk sweep over ALREADY PUBLISHED content. Those articles
 *   went out with the damage baked in, and re-flowing them now would change how
 *   live pages look — to a reader, a page that suddenly renders differently is
 *   worse than a page whose HTML is not canonical. So the rules apply to new
 *   writes only, and an existing article heals when someone edits and saves it.
 *   (Decision recorded 2026-08-16; see KuroEditor/docs/貼り付け破壊の修正仕様.md)
 * @returns {string}
 */
export function normalizeContentHtml(html, opts = {}) {
  if (typeof html !== 'string' || html === '') return html ?? ''
  const { root, ok } = parseTree(html)
  if (!ok) return html
  root.children = transformChildren(root.children, true, opts.clipboardRepair !== false)
  return serialize(root)
}

/**
 * Report what {@link normalizeContentHtml} would change, without changing it.
 * Used by the maintenance screen to show a preview count per rule.
 * @param {string} html
 * @returns {{ bTags:number, boldSpans:number, divBlocks:number, emptyBlocks:number,
 *             blockDecor:number, nestedBlocks:number, changed:boolean }}
 */
export function inspectContentHtml(html, opts = {}) {
  const clipboardRepair = opts.clipboardRepair !== false
  const stats = {
    bTags: 0, boldSpans: 0, divBlocks: 0, emptyBlocks: 0,
    blockDecor: 0, nestedBlocks: 0, changed: false,
  }
  if (typeof html !== 'string' || html === '') return stats
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
