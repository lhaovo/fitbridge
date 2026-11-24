# 平台适配器规格

---

## 一、适配器契约

### 1.1 PlatformManifest

```ts
export interface PlatformManifest {
  id: string;                    // 'otm' | 'mywhoosh' | 'strava' | ...
  displayName: string;
  shortCode: string;            // 'mg' | 'mw' | 'st'（参与 external_id 拼接）
  vendor: string;
  homepage: string;

  authType: 'oauth2' | 'password' | 'password+otp' | 'webview';
  access: 'official' | 'partner' | 'reverse-engineered' | 'webview-scrape';

  capabilities: {
    download: boolean;
    upload: boolean;
    uploadFormats: Array<'fit' | 'gpx' | 'tcx'>;
    deleteRemote: boolean;
    webhook: boolean;
    incremental: boolean;       // 平台是否支持游标/时间戳增量
  };

  coordinateSystem: 'wgs84' | 'gcj02' | 'bd09' | 'unknown';
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay?: number;
    minLoginIntervalSec?: number;   // 登录最小间隔，防风控
    uploadBatchSize?: number;       // 单次最多上传多少条
  };

  uploadAsync: boolean;         // 上传后是否需要轮询确认
  uploadVerifyDelaySec?: number; // 迈金 15-20s

  riskLevel: 'low' | 'medium' | 'high';
  notes?: string;                 // 展示给用户的注意事项
  docsUrl?: string;              // 官方文档链接（若为逆向则指向 issue 讨论）
}
```

### 1.2 PlatformAdapter

```ts
export interface PlatformAdapter {
  readonly manifest: PlatformManifest;

  // ── 认证 ────────────────────────────────────────────────
  auth(input: AuthInput): Promise<AuthOutput>;
  validate(cred: Credential): Promise<CredentialHealth>;
  refresh?(cred: Credential): Promise<Credential>;

  // ── 读取 ────────────────────────────────────────────────
  listActivities(cred: Credential, opts: ListOptions): Promise<Paged<RemoteActivity>>;
  getActivityDetail?(cred: Credential, id: string): Promise<RemoteActivityDetail>;
  downloadFile(cred: Credential, activity: RemoteActivity): Promise<FilePayload>;

  // ── 写入（capabilities.upload === true）────────────────────
  uploadFile?(cred: Credential, file: NormalizedFile, hint: UploadHint): Promise<UploadResult>;
  deleteRemote?(cred: Credential, remoteId: string): Promise<void>;

  // ── Webhook ─────────────────────────────────────────────
  parseWebhook?(payload: unknown): ParsedWebhookEvent | null;
}

// ── 通用类型 ──────────────────────────────────────────────
interface RemoteActivity {
  remoteId: string;
  name?: string;
  sportType?: string;           // 平台原始运动类型
  startTime: string;            // ISO8601
  timezoneOffset?: number;      // 分钟；平台提供则用
  distanceMeters?: number;
  durationSec?: number;
  elevationGainMeters?: number;
  avgHeartRate?: number;
  avgPower?: number;
  avgCadence?: number;
  raw?: unknown;                // 原始响应，供 normalize 使用
}

interface FilePayload {
  content: Buffer | Readable;
  contentType: string;          // 'application/octet-stream' | 'application/gpx+xml'
  filename: string;
  sourceKind: 'fit' | 'gpx' | 'tcx';
  coordinateSystem?: 'wgs84' | 'gcj02';  // 文件级覆盖，优先级高于 manifest
}

interface UploadHint {
  name: string;
  startTime: string;            // 已校正的本地时间 + 时区偏移
  sportType: string;            // 归一化后的类型
  externalId: string;           // '{shortCode}{remoteId}'，用于目标侧幂等
}

interface UploadResult {
  remoteId?: string;
  status: 'accepted' | 'pending' | 'rejected';
  raw?: unknown;
}

interface CredentialHealth {
  ok: boolean;
  reason?: string;
  expiresAt?: string;
  checkedAt: string;
}
```

### 1.3 适配器测试约定

每个适配器必须提供：

1. `fixtures/` —— 录制的真实 HTTP 响应样本（脱敏）
2. 契约测试（共用一套）：`manifest` 字段完整性、上传返回结构、错误映射
3. 端到端测试（可选，需 `FITBRIDGE_E2E=1` + 真实账号）：登录 → 列表 → 下载 → 上传 → 验证

---

## 二、迈金 / 顽鹿 OTM（`otm`）

| 项 | 值 |
|----|----|
| Base URL | `https://otm.onelap.cn` |
| 认证 | 账号密码 → JWT (`token`) + `refresh_token` |
| 访问类型 | **逆向**（无公开开放 API） |
| 坐标系 | GCJ-02（`durl` 直链的 FIT 为 WGS-84，`fit_content` 为 GCJ-02） |
| 上传 | ✅ 仅 FIT，异步入库 15-20s |
| 风险等级 | 中（登录频繁可能触发风控；接口随 Web 端改版变化） |

### 2.1 接口清单

| 用途 | 方法 | 路径 | 请求 | 响应要点 |
|------|------|------|------|-----------|
| 登录 | POST | `/api/login` | `{account, password: MD5(password)}` | `data[0].token`、`data[0].refresh_token` |
| 刷新 | POST | `/api/token` | `{token, from:'web', to:'web'}` | 新 token |
| 校验 | POST | `/api/otm/ride_record/list` | `{page:1, limit:1}` + `Authorization: <token>` | `code == 200` 即有效 |
| 列表 | POST | `/api/otm/ride_record/list` | `{page, limit}` + `Authorization` | `data.list[]`、`data.pagination.has_more` |
| 详情 | GET | `/api/otm/ride_record/analysis/{id}` | `Authorization` | `data.ridingRecord.durl` / `.fitUrl` |
| FIT 内容 | GET | `/api/otm/ride_record/analysis/fit_content/{base64(fitUrl)}` | `Authorization` | FIT 二进制 |
| **上传** | POST | `/api/otm/ride_record/upload/fit` | multipart，字段名 **`jilu0`** | `code==200 && data.success_count>=1` |

### 2.2 实现要点

**上传 multipart 字段名必须是 `jilu0`**（官方网页 JS 用的是 `jilu`，程序化上传需 `jilu0`）——这是参考项目踩过的坑。

```http
POST /api/otm/ride_record/upload/fit HTTP/1.1
Host: otm.onelap.cn
Authorization: <token>
Origin: https://otm.onelap.cn
Referer: https://otm.onelap.cn/
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="jilu0"; filename="ride.fit"
Content-Type: application/octet-stream

<FIT bytes>
--boundary--
```

**文件选择策略**：

| 来源 | 优先取 | 坐标系 | 说明 |
|------|--------|--------|------|
| `durl` | 七牛直链（通常 `*.fit`） | WGS-84 | 优先，无需坐标转换 |
| `fitUrl` → `fit_content` | base64 编码后拼接路径 | GCJ-02 | 需 GCJ-02→WGS-84 转换 |

manifest 声明 `coordinateSystem: 'gcj02'`，但**文件级覆盖优先**（`FilePayload.coordinateSystem`），
避免对已经是 WGS-84 的 `durl` 文件做二次转换（这会导致约 450m 的反向偏移）。

> 参考项目对「七牛云直链」和「fit_content」提供了三个独立开关（建议关/建议开/本地转换），
> 说明**这两个来源的坐标系在同一平台内并不一致**。本项目用「文件级坐标系探测 + 采样点验证」统一处理：
> 读取首批坐标点，与已知地标比对，判断是否已偏移。

**上传成功判定**：`code == 200 && data.success_count >= 1`。因为是异步入库，成功返回后 15-20s 才能在活动列表看到。
`uploadAsync: true` + `uploadVerifyDelaySec: 20`，引擎在 Verify 阶段轮询列表确认。

**GPX 上传**：迈金只接受 FIT，必须先 `gpx/to-fit`，且需要完整的
`file_id → session → lap → activity → record` 消息流。仅用官方 `gpx2fit.js` 产出的文件会被拒绝。

**登录风控**：参考项目提到「迈金重启后需重新登录」。因此：
- token 持久化 + `refresh_token` 自动续期
- 登录最小间隔（建议 5 分钟）
- 登录失败不立即重试（退避到 30 分钟）

---

## 三、MyWhoosh（`mywhoosh`）

| 项 | 值 |
|----|----|
| 登录 host | `https://services.mywhoosh.com` |
| API host | `https://service14.mywhoosh.com` |
| 认证 | 账号密码 → `AccessToken` + `RefreshToken` + `WhooshId` |
| 访问类型 | **逆向**（无公开上传 API） |
| 下载 | ✅ |
| 上传 | ❌ **仅作数据源** |
| 风险等级 | 中 |

### 3.1 接口清单

| 用途 | 方法 | URL | 请求 | 响应要点 |
|------|------|-----|------|-----------|
| 登录 | POST | `https://services.mywhoosh.com/http-service/api/login` | `{Username, Password, Platform:'Android', Action:1001, CorrelationId, DeviceId, Authorization:''}` | `Success`、`AccessToken`、`WhooshId`、`RefreshToken` |
| 活动列表 | POST | `https://service14.mywhoosh.com/v2/rider/profile/activities` | Bearer + `{page, limit:50, sortDate:'DESC'}` | 活动列表 + `activityFileId` |
| 下载文件 | POST | `https://service14.mywhoosh.com/v2/rider/profile/activities/download-activity-file` | Bearer + `{key: WhooshId, fileId: activityFileId}` | S3 预签名 URL |
| 下载 | GET | 返回的 S3 URL | — | FIT/GPX 二进制 |

### 3.2 实现要点

- `CorrelationId` 与 `DeviceId` 可生成 UUID / 稳定设备指纹（参考项目用固定值）
- `Platform: 'Android'` 需与 `DeviceId` 保持一致，避免被判定为异常客户端
- 下载分两步：先 POST 换取预签名 URL，再 GET。预签名 URL 有时效，**必须立即使用**，不能缓存到下次运行
- MyWhoosh 的活动文件可能是 FIT（功率数据完整）或 GPX（仅轨迹），需按 magic number 识别
- **作为源时**：MyWhoosh 只能下载，因此 `capabilities.upload = false`，UI 上该平台不出现在「目标」选择器

---

## 四、Strava（`strava`）

| 项 | 值 |
|----|----|
| OAuth 授权 | `https://www.strava.com/oauth/authorize` |
| Token | `https://www.strava.com/oauth/token` |
| API Base | `https://www.strava.com/api/v3`（2027-01-04 起 `https://api-v3.strava.com`） |
| 认证 | OAuth2 authorization_code |
| 访问类型 | **官方**（但 2026 政策收紧，见调研报告 §4.1） |
| scope | `activity:read_all,activity:write` |
| 上传 | ✅ FIT / GPX / TCX，同步 |
| 风险等级 | 低（技术）/ 高（政策） |

### 4.1 接口清单

| 用途 | 方法 | 路径 | 关键点 |
|------|------|------|--------|
| 授权 | GET | `/oauth/authorize` | `client_id`, `response_type=code`, `redirect_uri`, `scope` |
| Token | POST | `/oauth/token` | `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri` |
| 刷新 | POST | `/oauth/token` | `grant_type=refresh_token`, `refresh_token` |
| 活动列表 | GET | `/athlete/activities` | `per_page=200&page=N` |
| 活动详情 | GET | `/activities/{id}` | |
| 下载 | GET | `/activities/{id}` → `map` / `series` | GPX/TCX/FIT 流 |
| 上传 | POST | `/uploads` | multipart: `data_type`(fit/gpx/tcx) + `name` + `file` |
| Webhook 订阅 | POST | `/push_subscriptions` | `callback_url`, `application_id`, `scope=read,write` |
| Webhook 校验 | GET | 订阅回调 URL | 回显 `hub.challenge` + 校验 `hub.verify_token` |
| 撤销授权 | POST | `/oauth/deauthorize` | ⚠️ 2027-06-01 起改 `/oauth/revoke` |

### 4.2 实现要点

**self-hosted 模式下 client_id/secret 的处理**：

2026-09 起创建 API 应用需要有效 Strava 订阅，且标准层默认只允许 1 个 athlete。
因此架构上必须支持：

```
凭据层级：
  system_credential (平台级, 可选)   ← 管理员配置的自有 Strava App
  user_credential   (用户级, 默认)   ← 用户填自己的 client_id/secret
```

- 用户级优先；用户未配置时回落到系统级
- 系统级凭证**每个 app 只能建 1 个 push subscription** → 所有用户共享一个订阅，
  收到事件后按 `owner_id` 路由到对应用户

**Webhook 事件是 thin pointer**，只含 `object_id` / `owner_id` / `aspect_type` / `subscription_id` /
`event_time` / `updates`。必须用 `object_id` 回查 `/activities/{id}` 拿详情。

**限流（2026 标准层）**：

| 类别 | 15 分钟 | 每日 |
|------|---------|------|
| 整体 | 200 | 2000 |
| 非上传端点 | 100 | 1000 |
| 升级后 | 翻倍 | 翻倍 |

→ 令牌桶按「上传 / 非上传」两桶分别限。

**合规护栏（产品级硬约束）**：

| 政策 | 护栏实现 |
|------|----------|
| 5.16 禁止路由/中转 Strava 数据 | ① 默认不开启「多用户共享账号」；② 每个用户的 Strava 数据只在其自己的任务内流转；③ 服务条款页明确声明定位为「个人数据同步工具」；④ 记录审计日志证明无跨用户数据流 |
| 5.3 禁止把 API 数据喂给 AI/LLM | 活动详情接口返回给前端的 payload **打上 `source=strava` 标记**；若未来接入 AI 摘要功能，必须在服务端拦截 Strava 来源数据（不只是前端隐藏） |
| 缓存上限 7 天 | Strava 来源的原始响应缓存 TTL = 7 天（硬上限）；本地规范化副本不受此限（属用户自身数据） |
| 删除请求 48h 内传播 | 提供「删除同步」：用户在 Strava 删活动 → webhook 收到 `delete` 事件 → 本地 tombstone |
| 每 app 单 subscription | 共享订阅 + owner_id 路由 |

---

## 五、扩展平台接入清单（M3+）

每个平台按此清单接入，顺序建议：

| 平台 | 官方性 | 难度 | 价值 | 建议顺序 |
|------|--------|------|------|---------|
| Intervals.icu | 官方 | 低（已有 OAuth2 模板） | 高（规范、支持 external_id 幂等） | 1 |
| iGPSPORT | 官方上传 API | 中 | 高（国内用户多） | 2 |
| 行者 | 官方开放 API | 中 | 中（可作「清洗中转」） | 3 |
| Outbase | 逆向/WebView | 中 | 中（兼容性最好，可作兜底目标） | 4 |
| Suunto | 官方 Cloud API | 低 | 中 | 5 |
| Garmin | 需合作资质 | 高（MFA + 设备伪装） | 中 | 暂缓 |
| Wahoo | 需 partner | 高 | 中 | 暂缓 |
| COROS | 官方 Open API | 中 | 中 | 6 |
| Komoot / 黑鸟 / Keep / 咕咚 / Zepp / Zwift / TwoBulu | 逆向/WebView | 中-高 | 低-中 | 按需 |

### 5.1 「官方 OAuth2 模板」平台

参考项目用一份配置描述适配了 5 个平台。本项目把这个模式标准化：

```ts
// packages/adapters/_oauth2-template
const config: OAuth2PlatformConfig = {
  id: 'intervals-icu',
  authUrl: 'https://intervals.icu/oauth/authorize',
  tokenUrl: 'https://intervals.icu/api/v1/oauth2/token',
  apiBase: 'https://intervals.icu/api/v1',
  uploadUrl: 'https://intervals.icu/api/v1/activity/{external_id}',
  scope: 'activity:read activity:write',
  listPath: '/activities',
  uploadMethod: 'json-with-url',  // 或 'multipart'
  externalIdField: 'external_id',
};
```

覆盖：Intervals.icu、Polar、Fitbit、Withings、TrainingPeaks、Suunto。

### 5.2 WebView 兜底平台

```
adapters/_webview-template/
├── manifest.ts        # access: 'webview-scrape', riskLevel: 'high'
├── session.ts         # Playwright context 管理 + profile 持久化
├── flows/
│   ├── login.ts       # 登录流程（可能含短信/滑块 → 需用户手动完成）
│   ├── list.ts        # 列表抓取
│   └── download.ts    # 文件抓取
└── bridge.ts          # 注入 JS 读取页面数据（参考项目的 bridge.html / gpx2fit.js 思路）
```

要点：
- 浏览器 profile 持久化到卷，避免每次重新登录触发风控
- 登录若需要短信/验证码 → **UI 上引导用户手动完成**（提供「打开远程浏览器」链接），这比自动绕过更安全也更稳定
- 参考项目的 `WebBridge.kt` + `assets/bridge.html` + `assets/gpx2fit.js` 是很好的实现模板

---

## 六、通用 HTTP 客户端约定

所有适配器共用一个带策略的 HTTP 客户端：

```ts
createPlatformClient({
  platformId: 'otm',
  baseUrl: 'https://otm.onelap.cn',
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 ...',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  timeoutMs: 30_000,
  retry: { maxAttempts: 3, backoff: 'exponential-jitter' },
  rateLimitBucket: 'otm:cred-123',
  circuitBreaker: { threshold: 5, cooldownMs: 30 * 60_000 },
  hooks: [redactSecrets, mapPlatformErrors, recordLatencyMetric],
});
```

必须内建的能力：

- **密钥脱敏**：请求/响应日志自动抹掉 `Authorization`、`password`、`token`、`Cookie`
- **错误映射**：HTTP 状态 + 平台错误码 → 统一 `PlatformError{code, retryable, message}`
- **域名白名单**：下载 URL（重定向后）必须落在允许的 host 列表，防 SSRF
- **熔断**：连续失败自动短路，保护用户账号不被风控



---

## 六、⚠️ 实测字段名（2026-11-24 真实账号验证）

> 这一节记录**真实接口返回的字段名**，与直觉差别很大。
> 写在这里是因为：字段名猜错时不会报错，只会静默变成 undefined，
> 导致「距离/时长/心率全是空的」这种极难排查的问题。

### 迈金 / 顽鹿 OTM

`POST /api/otm/ride_record/list` → `data.list[]`，真实字段：

| 真实字段 | 类型 | 说明 | ★ 易踩的坑 |
|----------|------|------|------------|
| `id` | string | 活动 ID | |
| `name` | string | 活动名 | **实测常为 `null`** → 需自己兜底 |
| `distance_km` | number | 距离，**公里** | 不是米！误当米会差 1000 倍 |
| `time_seconds` | number | 时长（秒） | 不是 `ridingTime` |
| `time_formatted` | string | "2:35:30" 展示串 | |
| `start_riding_time` | string | "2026-11-21 13:03:35" | **本地时间、无时区** → 按 UTC+8 补齐 |
| `created_at` | string | "1970-01-01 08:00:00" | 常是 1970，无用 |
| `avg_speed_kmh` | number | 平均速度 km/h | |
| `avg_heart_bpm` | number | 平均心率 | 不是 `avgHeartRate` |
| `avg_power_w` | number | 平均功率 | 不是 `avgPower` |
| `load_tss` | number | 训练压力 | |
| `elevation_gain` | number | 爬升 | |

详情 `GET /api/otm/ride_record/analysis/{id}` → `data.ridingRecord`：
`durl`（七牛直链，**WGS-84**）、`fitUrl`（走 fit_content，**GCJ-02**）。
★ 同一个平台两个下载通道坐标系不同，必须按文件级标注，不能只看 manifest。

### MyWhoosh

`POST /v2/rider/profile/activities` → `data.results[]`，真实字段：

| 真实字段 | 类型 | 说明 | ★ 易踩的坑 |
|----------|------|------|------------|
| `id` | string | 活动 ID | |
| `title` | string | 活动名 | **没有 `name` 字段** |
| `routeName` | string | 路线名 | |
| `sportType` | string | 'cycling' | |
| `distance` | number | 距离，**公里** | 不是 `distanceKm` |
| `rideDuration` | string | "02:35:30.000" | 需自己解析 |
| `date` | number | unix **秒** | 不是字符串！直接用会得到 "1795237415.0" |
| `startDatetime` | string | ISO | ★ **优先用这个** |
| `createdAt` | string | ISO | |
| `heartrate` / `watt` / `elevation` | number | 心率/功率/爬升 | |
| `activityFileId` | string | 下载必需 | |

**下载路径**（★ 极易写错）：

@@@
✅ POST https://service14.mywhoosh.com/v2/rider/profile/download-activity-file
❌ POST https://service14.mywhoosh.com/v2/rider/profile/activities/download-activity-file   → 404
@@@

### 增量策略：不能用页码游标

两个平台的列表都是**时间倒序**（`sortDate: "DESC"` / 迈金按时间倒排），所以增量应该：

@@@
since = 上次成功同步时间 - 回看窗口(lookbackHours)
适配器内部循环翻页，一旦遇到早于 since 的活动就停止翻页
@@@

**为什么不能用页码游标**：页码的含义会随 `limit` 变化而漂移。
实测踩过：上次 `limit=10` 记下 `cursor=2`，这次 `limit=20` 从第 2 页开始 → **一条都没拉到**。
本地幂等键（user + platform + activityId）才是最终保障。

### 引擎侧的两个坑

1. **直接调 `adapter.getActivityDetail` 会丢掉列表项的 `raw`**
   → 必须走 pipeline 的 `detail()`（合并列表项与详情）。
   丢了 `raw` 就会丢 `activityFileId`，导致下载全部失败。

2. **适配器抛异常必须带 HTTP 状态码**
   → 用 `PlatformHttpError`。否则 "401 Unauthorized" 会被判成 unknown，
   token 过期就不会触发自动重登。
