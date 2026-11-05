-- CSP の違反の報告を、頁の種類(公開の頁・管理画面)ごとに数える(課題 dffbd3ff・2026-11-05)。
--
-- 0080 の csp_reports は組(指示・出どころ・報告だけか止めたか)だけで、管理画面の違反と公開の頁の違反が
-- 混ざっていた。管理画面の CSP を強制に上げてよいかを、管理画面の違反だけで決めるために分ける。
-- 管理画面は報告先に ?p=admin を付けて送る(site-csp.ts の adminCspHeaders)。0080 の表はもう書かない。
--
-- restore: 不要 — 数えた報告で、古いバックアップから戻っても次の報告で数え直される。バックアップに載せない。
CREATE TABLE IF NOT EXISTS csp_page_reports (
  page        TEXT NOT NULL CHECK (page IN ('site', 'admin')),
  directive   TEXT NOT NULL,
  blocked     TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('report', 'enforce')),
  count       INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (page, directive, blocked, disposition)
);
