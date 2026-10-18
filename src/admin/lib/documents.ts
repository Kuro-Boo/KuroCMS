// KuroCMS admin: read the whole article list. Concatenated by
// scripts/build-admin.js (no imports/exports — globals in the admin bundle).
//
// GET /api/documents returns at most 1000 rows per call plus `next_offset`
// (null on the last page). Read pages until it is null, so a site with more
// than 1000 articles still shows every one. ⚠ Before 2026-10-18 the admin read
// one call and the 1001st article never appeared in the list.

async function fetchAllDocuments(query: string): Promise<Dynamic[]> {
  const out: Dynamic[] = [];
  let offset = 0;
  for (;;) {
    const data = await api(
      "/api/documents?" +
        (query ? query + "&" : "") +
        "limit=1000&offset=" +
        offset,
    );
    out.push(...(data.documents || []));
    const next = data.next_offset;
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  return out;
}
