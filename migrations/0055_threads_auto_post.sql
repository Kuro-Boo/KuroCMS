-- Threads (Meta) auto-post credentials.
-- threads_token   : long-lived Threads API access token (threads_basic +
--                   threads_content_publish permissions)
-- threads_user_id : Threads user id resolved from /me on first post and cached
ALTER TABLE site_settings ADD COLUMN threads_token TEXT;
ALTER TABLE site_settings ADD COLUMN threads_user_id TEXT;
