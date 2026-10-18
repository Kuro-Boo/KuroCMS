-- 初期設定の Kuro License の同意をやめた（2026-10-17・運用者の判断）。
-- 公開しているソースのライセンスは GitHub（Kuro-Boo/KuroCMS）に載っていて、導入した人が
-- 同意するのは起動時の窓の利用規約・プライバシーポリシー。同意の記録の列は使い道が無いので消す
-- （残すとコードに読み手が居るように見え、誤解とバグの元になる）。
--
-- restore: 不要 — 列を消すだけ。古いバックアップに残っている値は、復元が「今の表に無い列は
--   落として続ける」ので取り込まれない。
ALTER TABLE site_settings DROP COLUMN license_accepted_at;
ALTER TABLE site_settings DROP COLUMN license_accepted_by;
ALTER TABLE site_settings DROP COLUMN license_name;
ALTER TABLE site_settings DROP COLUMN license_attribution_phrase;
