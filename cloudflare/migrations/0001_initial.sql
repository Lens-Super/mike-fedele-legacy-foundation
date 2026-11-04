PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY NOT NULL,
  contributor_name TEXT NOT NULL CHECK(length(contributor_name) BETWEEN 1 AND 120),
  contributor_email TEXT NOT NULL CHECK(length(contributor_email) BETWEEN 3 AND 254),
  title TEXT CHECK(title IS NULL OR length(title) <= 160),
  story TEXT NOT NULL CHECK(length(story) BETWEEN 1 AND 20000),
  permission_granted INTEGER NOT NULL CHECK(permission_granted = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  CHECK(status <> 'approved' OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS memory_photos (
  id TEXT PRIMARY KEY NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL CHECK(length(original_name) <= 160),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_limits (
  ip_hash TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK(window_type IN ('hour','day')),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(ip_hash, window_type, window_start)
);

CREATE TABLE IF NOT EXISTS storage_quota (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  bytes_used INTEGER NOT NULL DEFAULT 0 CHECK(bytes_used >= 0)
);
INSERT OR IGNORE INTO storage_quota (id, bytes_used) VALUES (1, 0);

CREATE INDEX IF NOT EXISTS memories_public_order ON memories(status, published_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_photos_memory ON memory_photos(memory_id, created_at);
