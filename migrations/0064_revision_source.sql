-- 「AI が人の書いた記事を勝手に上書きした」を見つけて戻せるようにするための
-- 出所記録。値は 'api'（PAT で REST）/ 'mcp'（AI クライアント）/ 'admin'（人が
-- 保存ボタン）/ 'autosave'（管理画面のタイマー保存）/ 'maintenance'（サーバー側
-- の一括処理）。API か人かは認証方式から決まるので詐称できない。
--
-- ⚠ 2 つの列は意味が違う。ここを取り違えると復旧時に逆の版を掴む:
--   document_translations.source            … 今の本文を「書いた」のは誰か
--   document_translation_revisions.source   … その版の本文を「書いた」のは誰か
--   document_translation_revisions.replaced_by … その版を「上書き（消した）」のは誰か
-- 復旧に要るのは source＝人間の版。replaced_by は加害者側の記録で、
-- 「source=admin かつ replaced_by=mcp」＝人の本文を AI が消した版、になる。
--
-- 既存行はすべて NULL のまま＝不明（後から判定する手段が無いので埋めない）。
ALTER TABLE document_translations ADD COLUMN source TEXT;
ALTER TABLE document_translation_revisions ADD COLUMN source TEXT;
ALTER TABLE document_translation_revisions ADD COLUMN replaced_by TEXT;
