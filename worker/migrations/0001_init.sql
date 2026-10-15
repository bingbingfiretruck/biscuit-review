CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  fps             INTEGER NOT NULL DEFAULT 30,
  owner_token     TEXT NOT NULL UNIQUE,
  editor_token    TEXT NOT NULL UNIQUE,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  video_name     TEXT NOT NULL,
  video_size     INTEGER NOT NULL,
  video_duration REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'collecting',
  closed_at      TEXT,
  approved_at    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE feedback (
  id               TEXT PRIMARY KEY,
  version_id       TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  timecode         REAL,
  text             TEXT NOT NULL DEFAULT '',
  annotation       TEXT,
  annotation_thumb TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  editor_note      TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX feedback_version_idx ON feedback(version_id, seq);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX attachments_feedback_idx ON attachments(feedback_id);
