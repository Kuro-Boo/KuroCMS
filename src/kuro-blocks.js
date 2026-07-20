// ═══════════════════════════════════════════════════════════════════════════════
// KuroEditor — shared block utilities (DOM-INDEPENDENT, dependency-free)
// ═══════════════════════════════════════════════════════════════════════════════
//
// 共同編集・多端末同期・AI 更新が共通で使うブロック単位の純関数。
//   - ブラウザの DOM に依存しない（Cloudflare Worker / node / 同期サーバーで動く）
//   - 外部依存ゼロ（このファイルは copy でそのまま dist/kuro-blocks.js になる）
//
// editor.js はここから import して再 export する（後方互換）。KuroCMS の Worker・
// Plan B の DO サーバー・KuroNotes の同期層はこのモジュールを唯一の実装として使う
// （仕様書 §4.10 / §10.7 F0：正規表現で HTML を処理しない・共有 tokenizer 一本化）。

// ── block id ─────────────────────────────────────────────────────────────────

/**
 * A block id is safe when it is a short token of [A-Za-z0-9_-] (covers UUIDs
 * from crypto.randomUUID and simple ids like "keep-1"). Anything else — quotes,
 * brackets, whitespace, over-long — is rejected so it can be re-minted at a
 * trusted boundary; such an id would otherwise break a `[data-bid="…"]` selector
 * and the sync wire format when external / pasted / MCP content supplies it.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidBid(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/** Default id factory — crypto.randomUUID when available, else a time+random token. */
export function defaultBidFactory() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

// ── internal-attribute stripping (public build output) ─────────────────────────

const INTERNAL_ATTR_RE = /\s+data-(?:bid|cbid)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

/**
 * Remove KuroEditor's internal block-identity attributes (data-bid / data-cbid)
 * from serialized HTML. Structure-aware (NOT a single whole-string regex): scans
 * tag boundaries while ignoring quoted attribute values, so a literal '>' inside
 * an attribute (e.g. title="1 > 0") never confuses the boundary and the internal
 * attributes are always reached. Byte-preserving for everything else. DOM-free.
 * @param {string} html
 * @returns {string}
 */
export function stripInternalIds(html) {
  if (typeof html !== 'string') return html
  if (!/\bdata-(?:bid|cbid)\b/.test(html)) return html // common case: untouched
  let out = ''
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { out += html.slice(i); break }
    out += html.slice(i, lt) // text before '<' — escaped &lt;… is untouched

    // comments may contain '>' — copy verbatim
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      const stop = end === -1 ? n : end + 3
      out += html.slice(lt, stop)
      i = stop
      continue
    }

    // find the tag's real '>' ignoring quoted regions
    let j = lt + 1
    let quote = ''
    while (j < n) {
      const ch = html[j]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    const tagEnd = j < n ? j + 1 : n
    out += html.slice(lt, tagEnd).replace(INTERNAL_ATTR_RE, '')
    i = tagEnd
  }
  return out
}

/**
 * Legacy alias — strips data-bid (now data-cbid too) from build/publish output.
 * Kept as a named export for backward compatibility.
 * @param {string} html
 * @returns {string}
 */
export function stripBlockIds(html) {
  return stripInternalIds(html)
}

// ── top-level block splitting / parsing ────────────────────────────────────────

/** HTML void elements — no closing tag, never affect nesting depth. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Split an HTML string into its top-level segments (blocks / text runs)
 * WITHOUT a DOM — a quote-aware, depth-counting tag scanner, so it runs
 * identically in browsers and server runtimes (Cloudflare Workers etc.).
 *
 * Input is expected to be serialized (well-formed) HTML such as getContent()
 * output; that is NOT enforced — when the scan detects malformed nesting the
 * result carries ok:false so callers can refuse to act on it.
 *
 * @param {string} html
 * @returns {{ segments: Array<{ html: string, bid: string|null }>, ok: boolean }}
 */
export function splitTopLevelBlocks(html) {
  const segments = []
  let ok = true
  const n = html.length
  let i = 0
  let segStart = 0
  let depth = 0
  let openTag = '' // opening tag of the current top-level block (bid source)

  const pushSeg = (end) => {
    if (end > segStart) {
      const m = openTag.match(/\sdata-bid="([^"]*)"/)
      segments.push({ html: html.slice(segStart, end), bid: m ? m[1] : null })
    }
    segStart = end
    openTag = ''
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (depth === 0 && lt > segStart) pushSeg(lt)

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) { ok = false; break }
      i = end + 3
      if (depth === 0) pushSeg(i)
      continue
    }

    let j = lt + 1
    let quote = null
    while (j < n) {
      const ch = html[j]
      if (quote) { if (ch === quote) quote = null }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    if (j >= n) { ok = false; break } // unterminated tag
    const tag = html.slice(lt, j + 1)
    i = j + 1

    const nameMatch = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)
    if (!nameMatch) continue // stray '<' — keep as text
    const name = nameMatch[1].toLowerCase()

    if (tag[1] === '/') {
      if (depth === 0) { ok = false; continue } // stray closing tag
      depth--
      if (depth === 0) pushSeg(i)
    } else if (VOID_TAGS.has(name) || tag.endsWith('/>')) {
      if (depth === 0) { openTag = tag; pushSeg(i) }
    } else {
      if (depth === 0) openTag = tag
      depth++
    }
  }
  if (depth !== 0) ok = false
  if (segStart < n) pushSeg(n) // trailing text or unclosed remainder
  return { segments, ok }
}

/**
 * Parse serialized HTML into an array of top-level blocks. Whitespace-only runs
 * between blocks are dropped. Returns [] when the HTML is malformed.
 * @param {string} html
 * @returns {Array<{ html: string, bid: string|null }>}
 */
export function parseBlocks(html) {
  const { segments, ok } = splitTopLevelBlocks(html ?? '')
  if (!ok) return []
  return segments.filter((s) => !(s.bid === null && s.html.trim() === ''))
}

/**
 * Insert/replace data-bid on a block's opening tag. `bid` MUST already be valid
 * (caller mints via isValidBid/idFactory), so no escaping is needed.
 * Returns the html unchanged when it does not start with a taggable element.
 */
function setBidOnOpeningTag(blockHtml, bid) {
  const lt = blockHtml.indexOf('<')
  if (lt === -1 || !/^<[a-zA-Z]/.test(blockHtml.slice(lt))) return blockHtml
  // end of opening tag (quote-aware)
  let j = lt + 1
  let quote = ''
  while (j < blockHtml.length) {
    const ch = blockHtml[j]
    if (quote) { if (ch === quote) quote = '' }
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') break
    j++
  }
  const selfClose = blockHtml[j - 1] === '/'
  const tagInner = blockHtml.slice(lt, selfClose ? j - 1 : j)
  const withoutBid = tagInner.replace(/\s+data-bid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
  const rebuilt = `${withoutBid} data-bid="${bid}"${selfClose ? '/' : ''}>`
  return blockHtml.slice(0, lt) + rebuilt + blockHtml.slice(j + 1)
}

/**
 * Ensure every top-level block carries a unique, valid data-bid. Missing,
 * malformed, or duplicated ids are re-minted via `idFactory`. Used at trusted
 * ingest boundaries (server REST/AI, host save) — transport/MCP layers never
 * call this. Refuses (returns input unchanged) on malformed HTML.
 * @param {string} html
 * @param {() => string} [idFactory]
 * @returns {string}
 */
export function normalizeBlockIds(html, idFactory = defaultBidFactory) {
  const { segments, ok } = splitTopLevelBlocks(html ?? '')
  if (!ok) return html ?? ''
  const seen = new Set()
  const out = []
  for (const seg of segments) {
    if (seg.bid === null && seg.html.trim() === '') { out.push(seg.html); continue }
    let bid = seg.bid
    if (!isValidBid(bid) || seen.has(bid)) bid = idFactory()
    seen.add(bid)
    out.push(bid === seg.bid ? seg.html : setBidOnOpeningTag(seg.html, bid))
  }
  return out.join('')
}

// ── 3-way merge ────────────────────────────────────────────────────────────────

/**
 * 3-way merge of two edits of the same document, block by block.
 *
 *   base   — the common ancestor (the body as it was loaded)
 *   local  — the edit at hand (e.g. what is in the editor now)
 *   remote — the other side's latest (e.g. an AI's REST/MCP edit on the server)
 *
 * Matching uses data-bid where present; blocks WITHOUT an id (e.g. raw HTML a
 * client added over REST) fall back to content equality, so identical id-less
 * duplicates cannot be tracked precisely. Inter-block whitespace is dropped.
 *
 * The mechanism never decides a winner: when both sides changed the same block
 * differently the local version is kept in `html` and the full triple is
 * reported in `conflicts` — resolution UX is the host's responsibility.
 *
 * Inputs are EXPECTED to be KuroEditor-generated HTML but this is not a hard
 * precondition: when block splitting fails the function refuses to merge,
 * returns `local` unchanged and says so in `warnings` (+ console.warn).
 *
 * @param {string} baseHtml
 * @param {string} localHtml
 * @param {string} remoteHtml
 * @returns {{
 *   html: string,
 *   conflicts: Array<{ bid: string|null, base: string|null, local: string|null, remote: string|null }>,
 *   warnings: string[],
 * }}
 */
export function mergeBlocks(baseHtml, localHtml, remoteHtml) {
  const warnings = []
  const conflicts = []
  const base   = splitTopLevelBlocks(baseHtml ?? '')
  const local  = splitTopLevelBlocks(localHtml ?? '')
  const remote = splitTopLevelBlocks(remoteHtml ?? '')

  if (!base.ok || !local.ok || !remote.ok) {
    const which = [!base.ok && 'base', !local.ok && 'local', !remote.ok && 'remote']
      .filter(Boolean).join(', ')
    const msg = `mergeBlocks: ブロック分割に失敗 (${which}) — 入力が整形済み (KuroEditor 生成) HTML でない可能性があります。マージせず local を返します。`
    console.warn(msg)
    return { html: localHtml, conflicts, warnings: [msg] }
  }

  const keyOf = (seg) => seg.bid !== null ? `b:${seg.bid}` : `c:${seg.html}`
  const toMap = (split, label) => {
    const map = new Map()
    for (const seg of split.segments) {
      if (seg.bid === null && seg.html.trim() === '') continue
      const key = keyOf(seg)
      if (map.has(key)) {
        if (seg.bid !== null) {
          warnings.push(`mergeBlocks: ${label} に重複した data-bid "${seg.bid}" — 最初の出現のみ照合に使用します。`)
        }
        continue
      }
      map.set(key, seg)
    }
    return map
  }
  const bMap = toMap(base, 'base')
  const lMap = toMap(local, 'local')
  const rMap = toMap(remote, 'remote')

  const pick = new Map()
  const allKeys = new Set([...bMap.keys(), ...lMap.keys(), ...rMap.keys()])
  for (const key of allKeys) {
    const b = bMap.get(key)?.html ?? null
    const l = lMap.get(key)?.html ?? null
    const r = rMap.get(key)?.html ?? null
    const bid = (bMap.get(key) ?? lMap.get(key) ?? rMap.get(key)).bid

    if (b !== null && l !== null && r !== null) {
      const changedL = l !== b
      const changedR = r !== b
      if (!changedR) pick.set(key, l)
      else if (!changedL) pick.set(key, r)
      else if (l === r) pick.set(key, l)
      else {
        pick.set(key, l)
        conflicts.push({ bid, base: b, local: l, remote: r })
      }
    } else if (b !== null && l !== null && r === null) {
      if (l === b) pick.set(key, null)
      else { pick.set(key, l); conflicts.push({ bid, base: b, local: l, remote: null }) }
    } else if (b !== null && l === null && r !== null) {
      if (r === b) pick.set(key, null)
      else { pick.set(key, r); conflicts.push({ bid, base: b, local: null, remote: r }) }
    } else if (b !== null) {
      pick.set(key, null)
    } else if (l !== null && r !== null) {
      if (l === r) pick.set(key, l)
      else { pick.set(key, l); conflicts.push({ bid, base: null, local: l, remote: r }) }
    } else {
      pick.set(key, l ?? r)
    }
  }

  const outOrder = []
  const inOut = new Set()
  for (const seg of local.segments) {
    const key = keyOf(seg)
    if (pick.get(key) != null && !inOut.has(key)) {
      outOrder.push(key)
      inOut.add(key)
    }
  }
  let anchor = -1
  for (const seg of remote.segments) {
    const key = keyOf(seg)
    if (inOut.has(key)) { anchor = outOrder.indexOf(key); continue }
    if (pick.get(key) != null) {
      outOrder.splice(anchor + 1, 0, key)
      inOut.add(key)
      anchor += 1
    }
  }

  return { html: outOrder.map((key) => pick.get(key)).join(''), conflicts, warnings }
}

/**
 * Single-block 3-way merge (W3 の確定時マージ・キャレット離脱時マージ用)。
 * base/local/remote は「その 1 ブロックの html」。全て同じ bid を指す前提。
 *   - local が base のまま → remote を採用（相手だけ編集）
 *   - remote が base のまま → local を採用（自分だけ編集）
 *   - local === remote → どちらでも同じ
 *   - 3 者相違 → 分岐。local を html に採り、remote を conflict に載せる（消さない）
 * @param {string} base
 * @param {string} local
 * @param {string} remote
 * @returns {{ html: string, conflict: null | { base: string, local: string, remote: string } }}
 */
export function mergeBlock(base, local, remote) {
  if (local === remote) return { html: local, conflict: null }
  if (local === base) return { html: remote, conflict: null }   // remote-only change
  if (remote === base) return { html: local, conflict: null }   // local-only change
  return { html: local, conflict: { base, local, remote } }     // diverged — keep local, report
}

/**
 * Deterministic auto-resolution for hosts without a conflict UI (KuroNotes 案C・
 * オフライン復帰): keep the local block, and re-insert each remote-side conflict
 * value as a NEW block (fresh bid) right after it, so no edit is silently lost.
 * @param {{ html: string, conflicts: Array<{ bid: string|null, remote: string|null }> }} result
 * @param {() => string} [idFactory]
 * @returns {string}
 */
export function resolveConflictsAsDuplicates(result, idFactory = defaultBidFactory) {
  if (!result || !result.conflicts || result.conflicts.length === 0) {
    return result?.html ?? ''
  }
  const blocks = parseBlocks(result.html)
  const byBid = new Map(blocks.map((b, idx) => [b.bid, idx]))
  const out = blocks.map((b) => b.html)
  // Insert conflict remotes after the matching kept block (or append if unmatched).
  // Walk conflicts in reverse so earlier splice indices stay valid.
  const insertions = []
  for (const c of result.conflicts) {
    // 複製が要るのは「local が保持された真の分岐」（両者とも編集）のみ。
    //  - remote == null（相手が削除・自分が編集）→ html は local を保持済み。複製不要
    //  - local == null（自分が削除・相手が編集）→ mergeBlocks が html に remote を
    //    復活済み。ここで挿入すると同じ内容が二重になる
    if (c.remote == null || c.local == null) continue
    const dup = setBidOnOpeningTag(c.remote, idFactory())
    const at = c.bid != null && byBid.has(c.bid) ? byBid.get(c.bid) + 1 : out.length
    insertions.push({ at, html: dup })
  }
  insertions.sort((a, b) => b.at - a.at)
  for (const ins of insertions) out.splice(ins.at, 0, ins.html)
  return out.join('')
}

/**
 * Deterministic order/blocks reconciliation after a remote apply (Plan B / Adapter).
 * Given a block order and a set of known bids, drop duplicates (first wins) and
 * orphans (bids not in `known`), then append any known bid missing from the order
 * in bid-ascending order. Pure — same input → same output on every replica.
 * @param {string[]} order
 * @param {Iterable<string>} known
 * @returns {string[]}
 */
export function reconcileOrder(order, known) {
  const knownSet = known instanceof Set ? known : new Set(known)
  const seen = new Set()
  const out = []
  for (const bid of order) {
    if (!knownSet.has(bid) || seen.has(bid)) continue
    seen.add(bid)
    out.push(bid)
  }
  const missing = [...knownSet].filter((bid) => !seen.has(bid)).sort()
  return out.concat(missing)
}

// ── keyed block diff (W2 事後リコンサイラ) ─────────────────────────────────────

/** Indices (into seq) forming a longest strictly-increasing subsequence. */
function lisIndices(seq) {
  const n = seq.length
  if (n === 0) return new Set()
  const tails = []          // tails[k] = seq-index of the smallest tail of an incr. subseq of length k+1
  const prev = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    if (lo === tails.length) tails.push(i)
    else tails[lo] = i
  }
  const res = new Set()
  let k = tails[tails.length - 1]
  while (k !== -1) { res.add(k); k = prev[k] }
  return res
}

/**
 * Keyed diff of two block lists (by bid) into an ordered BlockOp[] that
 * transforms `before` into `after` when applied left-to-right:
 *   { op:"delete", bid }
 *   { op:"insert", bid, html, afterBid }   // afterBid null = at the front
 *   { op:"move",   bid, afterBid }         // afterBid null = to the front
 *   { op:"update", bid, html }
 * Moves are minimised via LIS (only blocks that actually changed relative order
 * are moved). Both inputs MUST have non-null unique bids (blockIds on).
 *
 * @param {Array<{bid:string, html:string}>} before
 * @param {Array<{bid:string, html:string}>} after
 * @returns {Array<object>}
 */
export function diffBlocks(before, after) {
  const ops = []
  const beforeBids = before.map((b) => b.bid)
  const afterBids = after.map((b) => b.bid)
  const beforeSet = new Set(beforeBids)
  const afterSet = new Set(afterBids)
  const beforeHtml = new Map(before.map((b) => [b.bid, b.html]))
  const afterHtml = new Map(after.map((b) => [b.bid, b.html]))

  for (const bid of beforeBids) if (!afterSet.has(bid)) ops.push({ op: 'delete', bid })

  // Common bids in `after` order, mapped to their index in `before` → LIS = stayed put.
  const beforeIdx = new Map()
  beforeBids.forEach((bid, i) => { if (afterSet.has(bid)) beforeIdx.set(bid, i) })
  const commonInAfter = afterBids.filter((bid) => beforeSet.has(bid))
  const seq = commonInAfter.map((bid) => beforeIdx.get(bid))
  const lis = lisIndices(seq)
  const stable = new Set(commonInAfter.filter((_, i) => lis.has(i)))

  let prevBid = null
  for (const bid of afterBids) {
    if (!beforeSet.has(bid)) {
      ops.push({ op: 'insert', bid, html: afterHtml.get(bid), afterBid: prevBid })
    } else {
      if (!stable.has(bid)) ops.push({ op: 'move', bid, afterBid: prevBid })
      if (afterHtml.get(bid) !== beforeHtml.get(bid)) ops.push({ op: 'update', bid, html: afterHtml.get(bid) })
    }
    prevBid = bid
  }
  return ops
}

/**
 * Apply a BlockOp[] (from diffBlocks) to a block list, returning the new list.
 * Pure — used to verify a diff round-trips (before + diff == after) and by
 * non-DOM consumers (server/tests). afterBid null = front.
 * @param {Array<{bid:string, html:string}>} before
 * @param {Array<object>} ops
 * @returns {Array<{bid:string, html:string}>}
 */
export function applyBlockOps(before, ops) {
  let list = before.map((b) => ({ ...b }))
  const place = (block, afterBid) => {
    list = list.filter((b) => b.bid !== block.bid)
    if (afterBid == null) { list.unshift(block); return }
    const at = list.findIndex((b) => b.bid === afterBid)
    list.splice(at < 0 ? list.length : at + 1, 0, block)
  }
  for (const op of ops) {
    if (op.op === 'delete') list = list.filter((b) => b.bid !== op.bid)
    else if (op.op === 'insert') place({ bid: op.bid, html: op.html }, op.afterBid)
    else if (op.op === 'move') place(list.find((b) => b.bid === op.bid), op.afterBid)
    else if (op.op === 'update') {
      const b = list.find((x) => x.bid === op.bid)
      if (b) b.html = op.html
    }
  }
  return list
}
