// KuroCMS admin list pager. Concatenated by scripts/build-admin.js (no imports/
// exports — declarations are global within the combined admin bundle).
//
// Strapi-style pager HTML: an "entries per page" select + windowed page nav.
// Shared by the article list, the import lists and the media screens so every
// list that splits into pages looks and behaves the same (.listPager / .pagerBtn
// CSS lives in admin-shell.ts). Callers listen for clicks on `.pagerBtn[data-page]`
// and for `change` on the select whose id is `sizeSelectId`.

const PAGER_SIZE_OPTS = [10, 20, 50, 100];

function pagerPages(totalPages: number, current: number): number[] {
  const count = Math.min(4, totalPages);
  let start = Math.max(1, current - Math.floor((count - 1) / 2));
  let end = start + count - 1;
  if (end > totalPages) {
    end = totalPages;
    start = Math.max(1, end - count + 1);
  }
  const out: number[] = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
}

function listPagerHtml(
  sizeSelectId: string,
  total: number,
  page: number,
  size: number,
): string {
  const pages = Math.max(1, Math.ceil(total / size));
  const sizeOpts = PAGER_SIZE_OPTS.map(function (n) {
    return (
      "<option value='" +
      n +
      "'" +
      (n === size ? " selected" : "") +
      ">" +
      n +
      "</option>"
    );
  }).join("");
  let nums = "";
  let last = 0;
  pagerPages(pages, page).forEach(function (n) {
    if (n - last > 1) nums += "<span class='pagerEllipsis'>…</span>";
    nums +=
      "<button type='button' class='pagerBtn" +
      (n === page ? " active" : "") +
      "' data-page='" +
      n +
      "'" +
      (n === page ? " disabled" : "") +
      ">" +
      n +
      "</button>";
    last = n;
  });
  return (
    "<div class='listPager'>" +
    "<label class='pageSizeWrap'>" +
    "<select id='" +
    escapeHtml(sizeSelectId) +
    "'>" +
    sizeOpts +
    "</select>" +
    escapeHtml(t("entriesPerPage")) +
    "</label>" +
    "<div class='pagerNav'>" +
    "<button type='button' class='pagerBtn' data-page='" +
    (page - 1) +
    "'" +
    (page <= 1 ? " disabled" : "") +
    ">&#8249;</button>" +
    nums +
    "<button type='button' class='pagerBtn' data-page='" +
    (page + 1) +
    "'" +
    (page >= pages ? " disabled" : "") +
    ">&#8250;</button>" +
    "</div>" +
    "</div>"
  );
}
