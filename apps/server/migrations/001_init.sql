-- FitBridge 初始 schema（SQLite 方言）
--
-- 决策 D2/D3：单用户 + 纯自托管
--   · 保留 user_id 字段，未来放开多用户零改造
--   · JSON 字段用 TEXT + json_valid 约束（SQLite JSON1 内置）
--   · 时间戳统一 TEXT ISO-8601 UTC
--   · 二进制凭证密文用 BLOB

PRAGMA foreign_keys = ON;

-- ── 用户 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'admin',
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  coord_policy   TEXT NOT NULL DEFAULT 'auto',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── 凭证（只存密文） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS credentials (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id        TEXT NOT NULL,
  label              TEXT,
  auth_type          TEXT NOT NULL,
  secret_cipher      BLOB NOT NULL,
  secret_iv          BLOB NOT NULL,
  secret_tag         BLOB NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,
  meta               TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  status             TEXT NOT NULL DEFAULT 'active',
  last_validated_at  TEXT,
  expires_at         TEXT,
  error_code         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_user_platform_label_idx
  ON credentials (user_id, platform_id, label);

-- ── L1 活动账本（全量常驻） ──────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_platform      TEXT NOT NULL,
  source_activity_id   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  sport_type           TEXT NOT NULL,
  start_time           TEXT,
  local_start_time     TEXT,
  timezone_offset_min  INTEGER NOT NULL DEFAULT 0,
  timezone_source      TEXT NOT NULL DEFAULT 'unknown',
  duration_sec         INTEGER NOT NULL DEFAULT 0,
  distance_m           REAL NOT NULL DEFAULT 0,
  elevation_gain_m     REAL,
  moving_time_sec      INTEGER,
  metrics              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics)),
  coord_original       TEXT NOT NULL DEFAULT 'unknown',
  coord_final          TEXT NOT NULL DEFAULT 'wgs84',
  flags                TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(flags)),
  sync_state           TEXT NOT NULL DEFAULT 'pending',
  last_synced_at       TEXT,
  raw                  TEXT CHECK (raw IS NULL OR json_valid(raw)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- ★ L1 幂等键
  UNIQUE (user_id, source_platform, source_activity_id)
);
CREATE INDEX IF NOT EXISTS activities_user_time_idx
  ON activities (user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS activities_user_platform_time_idx
  ON activities (user_id, source_platform, start_time DESC);

-- ── L2/L3 文件 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_files (
  id                 TEXT PRIMARY KEY,
  activity_id        TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  original_kind      TEXT,
  blob_key           TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  coord_system       TEXT NOT NULL DEFAULT 'wgs84',
  tz_offset_min      INTEGER,
  derived            INTEGER NOT NULL DEFAULT 0,
  expired_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS activity_files_activity_idx
  ON activity_files (activity_id);

-- ── 同步任务 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_tasks (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  source_platforms  TEXT NOT NULL CHECK (json_valid(source_platforms)),
  target_platforms  TEXT NOT NULL CHECK (json_valid(target_platforms)),
  filters           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters)),
  policy            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy)),
  schedule          TEXT CHECK (schedule IS NULL OR json_valid(schedule)),
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  next_run_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT REFERENCES sync_tasks(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  stats          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats)),
  error          TEXT CHECK (error IS NULL OR json_valid(error))
);

CREATE TABLE IF NOT EXISTS sync_items (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  activity_id      TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  source_platform  TEXT NOT NULL,
  target_platform  TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  remote_id        TEXT,
  external_id      TEXT,
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_items_idem_idx
  ON sync_items (activity_id, target_platform, external_id);

CREATE TABLE IF NOT EXISTS sync_states (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id     TEXT NOT NULL,
  credential_id   TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  last_cursor     TEXT,
  last_sync_at    TEXT,
  last_success_at TEXT,
  lookback_sec    INTEGER NOT NULL DEFAULT 86400,
  PRIMARY KEY (user_id, platform_id)
);

CREATE TABLE IF NOT EXISTS platform_health (
  platform_id     TEXT NOT NULL,
  credential_id   TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'closed',
  failure_count   INTEGER NOT NULL DEFAULT 0,
  opened_until    TEXT,
  last_error      TEXT CHECK (last_error IS NULL OR json_valid(last_error)),
  PRIMARY KEY (platform_id, credential_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  level       TEXT NOT NULL,
  category    TEXT NOT NULL,
  platform_id TEXT,
  task_id     TEXT,
  run_id      TEXT,
  activity_id TEXT,
  message     TEXT NOT NULL,
  data        TEXT CHECK (data IS NULL OR json_valid(data)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_user_id_idx ON events (user_id, id DESC);

-- ── 单用户模式的默认用户 ────────────────────────────────
INSERT INTO users (id, email, password_hash, role, timezone)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@local',
  'env-managed',
  'admin',
  'UTC'
)
ON CONFLICT(id) DO NOTHING;
