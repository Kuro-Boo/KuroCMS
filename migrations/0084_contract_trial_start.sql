-- 無料期間を始めた時刻(仕様 cms-pricing「契約のタブ」・2026-10-27)。
-- 受付(install.entamy.com)が毎時、Entamy ID の試用の記録(started_at)から引いて書く。
-- 設定の「契約」タブが、無料期間の棒の左端に使う。
--
-- restore: 不要 — 受付が毎時書き直す行(0077 と同じ)。
ALTER TABLE contract_info ADD COLUMN trial_started_at INTEGER;
