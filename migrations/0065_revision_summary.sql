-- リビジョンは title / body_html / seo_json / hashtag_json は保存していたが
-- summary（要約）だけ落としていた。要約も保存対象のフィールドである以上、
-- AI や誤操作に消されたら履歴から戻せないと復旧が片手落ちになる。あわせて
-- 履歴一覧の 2 行目に出す説明文としても使う。
-- 既存行は NULL のまま＝記録前（一覧では本文の冒頭で代替表示する）。
ALTER TABLE document_translation_revisions ADD COLUMN summary TEXT;
