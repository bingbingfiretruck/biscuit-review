ALTER TABLE versions ADD COLUMN video_key TEXT;
ALTER TABLE versions ADD COLUMN video_mime TEXT;
ALTER TABLE versions ADD COLUMN video_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE versions ADD COLUMN upload_id TEXT;
