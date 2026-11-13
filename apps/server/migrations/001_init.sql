-- FitBridge 初始 schema（决策 D2/D3：单用户自托管，但保留 user_id 以便未来放开多用户）

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'admin',
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  coord_policy   TEXT NOT NULL DEFAULT 'auto',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 凭证：只存密文
CREATE TABLE IF NOT EXISTS credentials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id        TEXT NOT NULL,
  label              TEXT,
  auth_type          TEXT NOT NULL,
  secret_cipher      BYTEA NOT NULL,
  secret_iv          BYTEA NOT NULL,
  secret_tag         BYTEA NOT NULL,
  key_version        INT  NOT NULL DEFAULT 1,
  meta               JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'active',
  last_validated_at  TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  error_code         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform_id, label)
);

-- L1 元数据：活动账本（全量常驻）
CREATE TABLE IF NOT EXISTS activities (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_platform      TEXT NOT NULL,
  source_activity_id   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  sport_type           TEXT NOT NULL,
  start_time           TIMESTAMPTZ,
  local_start_time     TIMESTAMPTZ,
  timezone_offset_min  INT NOT NULL DEFAULT 0,
  timezone_source      TEXT NOT NULL DEFAULT 'unknown',
  duration_sec         INT NOT NULL DEFAULT 0,
  distance_m           DOUBLE PRECISION NOT NULL DEFAULT 0,
  elevation_gain_m     DOUBLE PRECISION,
  moving_time_sec      INT,
  metrics              JSONB NOT NULL DEFAULT '{}',
  coord_original       TEXT NOT NULL DEFAULT 'unknown',
  coord_final          TEXT NOT NULL DEFAULT 'wgs84',
  flags                JSONB NOT NULL DEFAULT '{}',
  sync_state           TEXT NOT NULL DEFAULT 'pending',
  last_synced_at       TIMESTAMPTZ,
  raw                  JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ★ L1 幂等键
  UNIQUE (user_id, source_platform, source_activity_id)
);
CREATE INDEX IF NOT EXISTS activities_user_time_idx
  ON activities (user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS activities_user_platform_time_idx
  ON activities (user_id, source_platform, start_time DESC);

-- L2/L3 文件
CREATE TABLE IF NOT EXISTS activity_files (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id        UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  original_kind      TEXT,
  blob_key           TEXT NOT NULL,
  byte_size          BIGINT NOT NULL,
  sha256             TEXT NOT NULL,
  coord_system       TEXT NOT NULL DEFAULT 'wgs84',
  tz_offset_min      INT,
  derived            BOOLEAN NOT NULL DEFAULT FALSE,
  expired_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_files_activity_idx
  ON activity_files (activity_id);

CREATE TABLE IF NOT EXISTS sync_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  source_platforms  TEXT[] NOT NULL,
  target_platforms  TEXT[] NOT NULL,
  filters           JSONB NOT NULL DEFAULT '{}',
  policy            JSONB NOT NULL DEFAULT '{}',
  schedule          JSONB,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID REFERENCES sync_tasks(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  stats          JSONB NOT NULL DEFAULT '{}',
  error          JSONB
);

CREATE TABLE IF NOT EXISTS sync_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  activity_id      UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  source_platform  TEXT NOT NULL,
  target_platform  TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempt_count    INT NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  remote_id        TEXT,
  external_id      TEXT,
  duration_ms      INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_items_idem_idx
  ON sync_items (activity_id, target_platform, external_id);

CREATE TABLE IF NOT EXISTS sync_states (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id     TEXT NOT NULL,
  credential_id   UUID REFERENCES credentials(id) ON DELETE SET NULL,
  last_cursor     TEXT,
  last_sync_at    TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  lookback_sec    INT NOT NULL DEFAULT 86400,
  PRIMARY KEY (user_id, platform_id)
);

CREATE TABLE IF NOT EXISTS platform_health (
  platform_id     TEXT NOT NULL,
  credential_id   UUID NOT NULL,
  state           TEXT NOT NULL DEFAULT 'closed',
  failure_count   INT NOT NULL DEFAULT 0,
  opened_until    TIMESTAMPTZ,
  last_error      JSONB,
  PRIMARY KEY (platform_id, credential_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  level       TEXT NOT NULL,
  category    TEXT NOT NULL,
  platform_id TEXT,
  task_id     UUID,
  run_id      UUID,
  activity_id UUID,
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_user_id_idx ON events (user_id, id DESC);


-- 单用户模式的默认用户（M0 只有一个账号，登录密码来自环境变量）
INSERT INTO users (id, email, password_hash, role, timezone)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@local',
  'env-managed',
  'admin',
  'UTC'
)
ON CONFLICT (id) DO NOTHING;
