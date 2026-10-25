-- 委託の契約の周期・契約日・払った期間の終わり(仕様 cms-pricing「契約形式のタブ」・ID 11.5・2026-10-25)。
-- 受付(install.entamy.com)が毎時、Entamy ID の直接課金の権利から引いて書く。設定の「契約形式」タブが出す。
--   subscription_period      month / year(契約が無ければ NULL)
--   subscription_started_at  契約を結んだ時刻
--   subscription_period_end  払った期間の終わり(次の更新日・解約したなら契約の終わる日)。
--                            subscription_until は更新の猶予を含むので、日付の表示には使わない。
--
-- restore: 不要 — 受付が毎時書き直す行(0077 と同じ)。
ALTER TABLE contract_info ADD COLUMN subscription_period TEXT;
ALTER TABLE contract_info ADD COLUMN subscription_started_at INTEGER;
ALTER TABLE contract_info ADD COLUMN subscription_period_end INTEGER;
