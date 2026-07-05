-- X (Twitter) auto-post credentials (OAuth 1.0a user context) + link mode.
-- x_link_in_reply: 1 = send the article URL as a reply to the parent tweet
--                      (two tweets; cheaper on X API pricing — default),
--                  0 = include the URL in the post body (single tweet).
ALTER TABLE site_settings ADD COLUMN x_api_key TEXT;
ALTER TABLE site_settings ADD COLUMN x_api_secret TEXT;
ALTER TABLE site_settings ADD COLUMN x_access_token TEXT;
ALTER TABLE site_settings ADD COLUMN x_access_secret TEXT;
ALTER TABLE site_settings ADD COLUMN x_link_in_reply INTEGER NOT NULL DEFAULT 1;
