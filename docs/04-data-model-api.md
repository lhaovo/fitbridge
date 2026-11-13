# 数据模型与 API 设计

---

## 一、领域模型

### 1.1 统一活动模型（核心）

```ts
interface Activity {
  id: string;                    // uuid
  userId: string;

  // 来源身份（幂等键的一部分）
  sourcePlatform: string;        // 'otm' | 'mywhoosh' | 'strava'
  sourceActivityId: string;      // 平台内唯一 ID

  // 规范化后的活动内容
  name: string;
  sportType: SportType;          // 归一化枚举
  startTime: string;             // ISO8601 UTC
  localStartTime: string;        // ISO8601 带本地偏移
  timezoneOffsetMin: number;     // 来源时区偏移（分钟）
  timezoneSource: 'platform' | 'inferred' | 'user' | 'utc-fallback';

  durationSec: number;
  distanceMeters: number;
  elevationGainMeters?: number;
  movingTimeSec?: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  avgHrMax?: number;
  calories?: number;

  // 数据质量标记（关键：让用户知道数据被改过）
  coordinateSystemOriginal: 'wgs84' | 'gcj02' | 'bd09' | 'unknown';
  coordinateSystemFinal: 'wgs84';
  timezoneAdjusted: boolean;
  coordinatesAdjusted: boolean;
  fitComplianceRepairs: string[]; // 施加过的修复，如 ['crc','timestamp-overflow']

  // 同步状态
  syncState: 'pending' | 'synced' | 'partial' | 'failed';
  lastSyncedAt?: string;

  createdAt: string;
  updatedAt: string;
}
```

### 1.2 SportType 归一化枚举

各平台运动类型命名各异，需要统一映射：

```ts
enum SportType {
  RIDE = 'ride',          // 骑行（公路/山地/ gravel 同属）
  RUN = 'run',
  SWIM = 'swim',
  HIKING = 'hiking',
  SKI = 'ski',
  STRENGTH = 'strength',
  ROWING = 'rowing',
  OTHER = 'other',
}
```

映射表放在 `packages/core/domain/sport-map.ts`，每个平台适配器提供 `mapSportType(raw): SportType`，
未识别的落到 `OTHER` 并保留原始值到 `rawSportType` 字段（**不丢信息**）。

### 1.3 文件模型

```ts
interface ActivityFile {
  id: string;
  activityId: string;
  kind: 'fit' | 'gpx' | 'tcx' | 'converted-fit';  // converted 表示由 GPX 转换而来
  originalKind?: 'fit' | 'gpx' | 'tcx';
  blobKey: string;               // 对象存储 key（内容寻址）
  byteSize: number;
  sha256: string;
  coordinateSystem: 'wgs84' | 'gcj02';
  timezoneOffsetMin?: number;
  createdAt: string;
}
```

内容寻址：`blobKey = sha256/{sha[0:2]}/{sha[2:4]}/{sha}`，天然去重 + 完整性校验。

---

## 二、数据库设计（PostgreSQL）

```sql
-- ── 用户 ────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
  timezone      TEXT NOT NULL DEFAULT 'UTC',       -- IANA
  coord_policy  TEXT NOT NULL DEFAULT 'auto',      -- 'auto' | 'always' | 'never'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 平台凭证（加密） ─────────────────────────────────────
CREATE TABLE credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id    TEXT NOT NULL,
  label          TEXT,
  auth_type      TEXT NOT NULL,
  secret_cipher  BYTEA NOT NULL,          -- AES-256-GCM 密文
  secret_iv      BYTEA NOT NULL,
  secret_tag     BYTEA NOT NULL,
  key_version    INT  NOT NULL DEFAULT 1,
  meta          JSONB NOT NULL DEFAULT '{}', -- 非敏感元数据（whooshId 等）
  status         TEXT NOT NULL DEFAULT 'active', -- active|expired|revoked|error
  last_validated_at TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  error_code     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform_id, label)
);
-- 凭证永远不返回给客户端：API 只返回 status / masked 摘要

-- ── 活动 ────────────────────────────────────────────────
CREATE TABLE activities (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_platform      TEXT NOT NULL,
  source_activity_id   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  sport_type           TEXT NOT NULL,
  start_time           TIMESTAMPTZ NOT NULL,
  local_start_time     TIMESTAMPTZ NOT NULL,
  timezone_offset_min  INT NOT NULL DEFAULT 0,
  timezone_source      TEXT NOT NULL DEFAULT 'inferred',
  duration_sec         INT NOT NULL DEFAULT 0,
  distance_m           DOUBLE PRECISION NOT NULL DEFAULT 0,
  elevation_gain_m     DOUBLE PRECISION,
  moving_time_sec      INT,
  metrics              JSONB NOT NULL DEFAULT '{}',  -- hr/power/cadence/speed 等
  coord_original       TEXT NOT NULL DEFAULT 'unknown',
  coord_final          TEXT NOT NULL DEFAULT 'wgs84',
  flags                JSONB NOT NULL DEFAULT '{}',  -- tz_adjusted/coord_adjusted/repairs
  sync_state           TEXT NOT NULL DEFAULT 'pending',
  last_synced_at       TIMESTAMPTZ,
  raw                  JSONB,                        -- 平台原始响应（可按需裁剪）
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ★ L1 幂等键
  UNIQUE (user_id, source_platform, source_activity_id)
);
CREATE INDEX ON activities (user_id, start_time DESC);
CREATE INDEX ON activities (user_id, source_platform, start_time DESC);

-- ── 活动文件 ────────────────────────────────────────────
CREATE TABLE activity_files (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id        UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  original_kind      TEXT,
  blob_key           TEXT NOT NULL,
  byte_size          BIGINT NOT NULL,
  sha256             TEXT NOT NULL,
  coord_system       TEXT NOT NULL DEFAULT 'wgs84',
  tz_offset_min      INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_files (activity_id);

-- ── 同步任务 ────────────────────────────────────────────
CREATE TABLE sync_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  source_platforms  TEXT[] NOT NULL,
  target_platforms  TEXT[] NOT NULL,
  filters           JSONB NOT NULL DEFAULT '{}',  -- 日期范围/运动类型/关键词
  policy            JSONB NOT NULL DEFAULT '{}',  -- 去重/坐标/时区/限流/重试/批量
  schedule          JSONB,                      -- {type:'cron', expr:'...'}|{type:'interval', minutes:30}
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 同步运行 ────────────────────────────────────────────
CREATE TABLE sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID REFERENCES sync_tasks(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL,       -- manual|schedule|webhook|api
  status         TEXT NOT NULL,       -- pending|running|success|partial|failed|cancelled
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  stats          JSONB NOT NULL DEFAULT '{}',
  error          JSONB
);

-- ── 同步明细（每条活动 × 每个目标） ──────────────────────
CREATE TABLE sync_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  activity_id    UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  source_platform TEXT NOT NULL,
  target_platform TEXT NOT NULL,
  status         TEXT NOT NULL,       -- pending|success|skipped|failed
  attempt_count  INT NOT NULL DEFAULT 0,
  error_code     TEXT,
  error_message  TEXT,
  remote_id      TEXT,                -- 目标平台活动 ID
  external_id    TEXT,                -- 幂等键 '{shortCode}{sourceId}'
  duration_ms    INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON sync_items (activity_id, target_platform, external_id);

-- ── 增量状态 ────────────────────────────────────────────
CREATE TABLE sync_states (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id     TEXT NOT NULL,
  credential_id   UUID REFERENCES credentials(id) ON DELETE SET NULL,
  last_cursor     TEXT,
  last_sync_at    TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  lookback_sec    INT NOT NULL DEFAULT 86400,
  PRIMARY KEY (user_id, platform_id)
);

-- ── 平台熔断状态 ────────────────────────────────────────
CREATE TABLE platform_health (
  platform_id     TEXT NOT NULL,
  credential_id   UUID NOT NULL,
  state           TEXT NOT NULL DEFAULT 'closed',  -- closed|open|half-open
  failure_count   INT NOT NULL DEFAULT 0,
  opened_until    TIMESTAMPTZ,
  last_error      JSONB,
  PRIMARY KEY (platform_id, credential_id)
);

-- ── 事件日志（供 SSE 回放） ──────────────────────────────
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  level       TEXT NOT NULL,       -- info|warn|error
  category    TEXT NOT NULL,       -- sync|auth|platform|system
  platform_id TEXT,
  task_id     UUID,
  run_id      UUID,
  activity_id UUID,
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON events (user_id, id DESC);
```

### 2.1 多用户隔离

- 应用层：所有 repository 方法强制第一个参数 `userId`
- 数据库层（可选加强）：开启 RLS

```sql
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON activities
  USING (user_id = current_setting('app.user_id')::uuid);
```

---

## 三、REST API 设计

Base：`/api/v1`

### 3.1 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/register` | 注册 |
| POST | `/auth/login` | 登录，返回 HttpOnly Cookie（access + refresh） |
| POST | `/auth/logout` | |
| GET | `/auth/me` | 当前用户 + 设置 |
| PATCH | `/auth/me` | 修改时区/坐标策略/通知偏好 |

### 3.2 平台与连接

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/platforms` | **所有平台 manifest 列表**（前端据此渲染能力矩阵） |
| GET | `/platforms/:id` | 单个平台详情（含 manifest + 授权说明） |
| POST | `/connections/:platformId/auth` | 发起认证 → 返回 `{mode:'oauth2', authorizeUrl}` 或 `{mode:'form'}` |
| GET | `/connections/:platformId/callback` | OAuth 回调（仅 OAuth2） |
| POST | `/connections/:platformId/credentials` | 提交账号密码（仅 password 类） |
| GET | `/connections` | 已连接列表（不含任何凭证内容） |
| GET | `/connections/:id` | 状态详情（masked） |
| POST | `/connections/:id/validate` | 主动校验有效性 |
| DELETE | `/connections/:id` | 删除凭证（+ 平台侧 revoke） |
| POST | `/connections/:id/revoke` | 平台侧撤销 token（Wahoo/Strava 等） |

`GET /platforms` 响应示例：

```json
[
  {
    "id": "otm",
    "displayName": "迈金 / 顽鹿 OTM",
    "shortCode": "mg",
    "access": "reverse-engineered",
    "authType": "password",
    "capabilities": { "download": true, "upload": true, "uploadFormats": ["fit"] },
    "coordinateSystem": "gcj02",
    "riskLevel": "medium",
    "notes": "上传仅接受 FIT；上传后约 15-20 秒异步入库。"
  }
]
```

### 3.3 同步任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tasks` | 任务列表（含最近一次统计） |
| POST | `/tasks` | 新建任务 |
| GET | `/tasks/:id` | 任务详情 |
| PATCH | `/tasks/:id` | 修改 |
| DELETE | `/tasks/:id` | 删除 |
| POST | `/tasks/:id/run` | 手动触发（可指定 `dryRun` 只预览将同步什么） |
| POST | `/tasks/:id/pause` | 暂停 |
| POST | `/tasks/:id/resume` | 恢复 |
| GET | `/tasks/:id/runs` | 历史运行记录 |
| GET | `/runs/:id` | 运行详情 + 逐条明细 |
| POST | `/runs/:id/cancel` | 取消运行 |

新建任务请求体：

```json
{
  "name": "迈金 → Strava + Intervals",
  "sourcePlatforms": ["otm", "mywhoosh"],
  "targetPlatforms": ["strava", "intervals-icu"],
  "filters": {
    "since": "2026-10-01",
    "until": null,
    "sportTypes": ["ride"],
    "keyword": null
  },
  "policy": {
    "incremental": true,
    "lookbackHours": 24,
    "maxItemsPerRun": 100,
    "dedupe": "content",
    "convertCoordinates": "auto",
    "adjustTimezone": "auto",
    "timezoneOverride": null,
    "retry": { "maxAttempts": 3, "backoff": "exponential" },
    "skipFailedTargets": true,
    "forceResync": false
  },
  "schedule": { "type": "interval", "minutes": 30 }
}
```

### 3.4 活动

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/activities` | 跨平台统一列表，支持过滤/分页/排序 |
| GET | `/activities/:id` | 详情（含指标 + flags + 已同步目标） |
| GET | `/activities/:id/file` | 下载原始文件（FIT/GPX） |
| GET | `/activities/:id/track` | 轨迹点（简化后的 polyline + 采样图表序列） |
| POST | `/activities/:id/sync` | 手动同步到指定目标平台 |
| DELETE | `/activities/:id` | 删除本地副本 |
| GET | `/activities/compare` | 对比两个来源的同一活动 |

### 3.5 日志与实时

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/events` | 历史事件（分页 + 过滤） |
| GET | `/events/stream` | **SSE** 实时事件流（带 `Last-Event-ID` 断点续传） |
| GET | `/metrics` | Prometheus 指标（自托管可选暴露） |

SSE 事件示例：

```
event: sync.progress
data: {"runId":"...","taskId":"...","activityId":"...","target":"strava","status":"success","bytes":1048576}

event: platform.warning
data: {"platform":"otm","code":"RATE_LIMITED","message":"触发平台限流，已退避 5 分钟"}
```

### 3.6 Webhook（入站）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/webhooks/strava` | Strava push subscription 回调（challenge 校验 + 事件入队） |
| POST | `/webhooks/:platform` | 预留其他平台 |

### 3.7 出站通知

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/notifications/channels` | 通知渠道列表 |
| POST | `/notifications/channels` | 添加（Webhook URL / Telegram / 邮件） |
| DELETE | `/notifications/channels/:id` | 删除 |

---

## 四、任务编排语义（关键约定）

### 4.1 多来源 × 多目标的扇出

```
Task { sources: [S1, S2], targets: [T1, T2] }

执行：
  for each source S:
    activities = Discover(S)                  # 增量
    for each activity a in activities:
      if Dedupe(a): continue                   # L1
      a = Fetch(a); a = Normalize(a)           # 时区/坐标/FIT 修复
      for each target T:
        if not T.supports(a.format): a' = Convert(a, T.requiredFormat)
        Upload(T, a')
        Verify(T, a')                         # 异步平台需轮询
```

**扇出策略**：目标之间互相独立，一个目标失败不影响其他目标（`skipFailedTargets` 策略）。

### 4.2 幂等键

```
external_id = {source_short_code}{source_activity_id}
  例：otm 来源活动 12345 → 'mg12345'
```

- 目标支持 external_id（如 Intervals.icu）→ 直接写入，实现真正的幂等
- 目标不支持 → 用「同文件名 + 同起始时间 + 同距离」指纹 + L3 探测兜底

### 4.3 dryRun 预览

`POST /tasks/:id/run` 带 `dryRun: true` 时，引擎完整执行 Discover + Dedupe + Normalize，
但跳过 Upload，返回「将同步 N 条、跳过 M 条、目标 X 拒绝 Y 条（原因）」。
这是很有价值的功能——用户在真正写入前能预览影响面。

---

## 五、错误响应规范

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "目标平台拒绝该 FIT 文件：数据记录缺少 activity 消息",
    "retryable": false,
    "details": { "target": "otm", "hint": "尝试开启 FIT 合规性修复" },
    "requestId": "01JC..."
  }
}
```

统一错误码：`AUTH_EXPIRED` / `RATE_LIMITED` / `VALIDATION_FAILED` / `TRANSIENT` /
`NOT_FOUND` / `FORBIDDEN` / `PLATFORM_CHANGED` / `CONFIG_ERROR` / `INTERNAL`。

