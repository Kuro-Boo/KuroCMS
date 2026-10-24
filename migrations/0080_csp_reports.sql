-- 公開サイトの CSP の違反の報告を数える（cms-cms-security「CSP」・2026-10-24）。
--
-- 報告はサイト自身の口（{publicBase}/_csp）で受け、指示（directive）と出どころ（ホスト名か
-- inline などの種類）と、報告だけか止めたかの別だけにして数える（ページの URL・読者の IP は残さない
-- —— 顧客導入の約束）。**初めて見た組の時だけ** Entamy Defects へ csp_violation を送る。
-- 誰でも送れる口なので、組の数には上限を置く（csp-report.ts）。
--
-- restore: 不要 — 数えた報告で、古いバックアップから戻っても次の報告で数え直される。バックアップに載せない。
CREATE TABLE IF NOT EXISTS csp_reports (
  directive   TEXT NOT NULL,
  blocked     TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('report', 'enforce')),
  count       INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (directive, blocked, disposition)
);
