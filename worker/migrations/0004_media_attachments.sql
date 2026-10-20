ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE attachments ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE attachments ADD COLUMN store_key TEXT;
ALTER TABLE attachments ADD COLUMN upload_id TEXT;
UPDATE attachments SET size = length(data) WHERE size = 0;
