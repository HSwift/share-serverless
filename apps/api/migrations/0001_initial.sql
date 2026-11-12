PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'deleted')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX files_created_idx ON files(created_at DESC, id DESC) WHERE status = 'ready';
CREATE INDEX files_cleanup_idx ON files(status, created_at);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX items_created_idx ON items(created_at DESC, id DESC);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX shares_created_idx ON shares(created_at DESC, id DESC);
