-- 委託の契約情報（仕様 cms-pricing「契約情報」・2026-10-20）。
--
-- 委託の KuroCMS は、自分の契約（いつ始めたか・無料期間がいつ終わるか）を知る道を持たない。
-- 受付（install.entamy.com）が毎時、Admin の導入の記録（契約日）と Entamy ID（無料期間・契約）を引いて
-- この 1 行を書く（ホスティング用アカウントの D1 へ直接）。設定の「契約情報」タブがこれを出す。
-- 自社の導入には行が無い（受付は書かない）。
--
-- 時刻はすべてミリ秒。
--   trial_ends_at        初めの無料期間の終わり
--   trial_extended_until キャンペーンで延ばした無料期間の終わり（延ばしていなければ NULL）
--   trial_final_at       最後の無料期間の終わり（上の 2 つの遅い方）
--   subscription         契約の状態（active / cancelled / none）
--   delete_at            契約が無いまま無料期間が終われば、この日にデータを消す（契約があれば NULL）
--   synced_at            受付が最後に書いた時刻
--
-- restore: 不要 — 受付が毎時書き直す行。バックアップに載せない（引っ越しでも写さない）。
CREATE TABLE IF NOT EXISTS contract_info (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  contract_at          INTEGER NOT NULL,
  trial_ends_at        INTEGER,
  trial_extended_until INTEGER,
  trial_extension_note TEXT,
  trial_final_at       INTEGER,
  subscription         TEXT NOT NULL DEFAULT 'none',
  subscription_until   INTEGER,
  delete_after_days    INTEGER NOT NULL DEFAULT 30,
  delete_at            INTEGER,
  synced_at            INTEGER NOT NULL
);
