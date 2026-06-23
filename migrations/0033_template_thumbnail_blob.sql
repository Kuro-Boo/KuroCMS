-- template thumbnail を D1 に保存するためのカラム追加（base64 TEXT）
ALTER TABLE page_templates ADD COLUMN thumbnail_blob TEXT;
