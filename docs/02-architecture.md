# 总体架构

---

## 一、一句话概括

> **插件式平台适配器 + 队列驱动的同步引擎 + 自托管 Web 控制台**

核心思想：把所有平台差异**收敛到 Adapter 边界内**，引擎只面对统一的中间模型与统一的文件契约。
新增一个平台 = 新增一个目录 + 一份 manifest，**不改引擎任何一行代码**。

---

## 二、系统架构图

```
                        ┌─────────────────────────────────────────────┐
   浏览器               │                 FitBridge Server             │
  ┌──────────┐          │                                             │
  │  Web UI  │◀────────┤  ┌────────────┐    ┌─────────────────────┐  │
  │ (React)  │  REST   │  │  REST API  │    │   OAuth 回调/管理    │  │
  └──────────┘  /api   │  │ (Fastify)  │    │  (平台账号连接)     │  │
        │               │  └─────┬──────┘    └──────────┬──────────┘  │
        │ SSE/WebSocket │        │                      │             │
        ▼               │        ▼                      ▼             │
  ┌──────────┐          │  ┌─────────────┐      ┌──────────────┐    │
  │ 实时日志  │◀────────┤  │ Sync API   │      │ Credential   │    │
  └──────────┘          │  │ 任务编排    │      │ Service      │    │
                       │  └─────┬───────┘      │ (信封加密)    │    │
                       │        │              └──────┬───────┘    │
                       │        ▼                     │            │
                       │  ┌──────────────────────────────────────┐   │
                       │  │        Sync Engine (核心)            │   │
                       │  │  ┌────────┐ ┌────────┐ ┌─────────┐ │   │
                       │  │  │Discover│→│Fetch   │→│Normalize│ │   │
                       │  │  │ 发现源  │ │ 下载文件│ │时区/坐标  │ │   │
                       │  │  └────────┘ └────────┘ └─────────┘ │   │
                       │  │  ┌────────┐ ┌────────┐ ┌─────────┐ │   │
                       │  │  │Dedupe  │→│Fan-out │→│Upload  │ │   │
                       │  │  │ 幂等去重│ │ 分发   │ │ 多目标  │ │   │
                       │  │  └────────┘ └────────┘ └─────────┘ │   │
                       │  │  ┌──────────────────────────────┐  │   │
                       │  │  │ Policy: 限流/退避/熔断/重试  │  │   │
                       │  │  └──────────────────────────────┘  │   │
                       │  └───────────────┬──────────────────┘   │
                       │                  │ 任务队列 (Redis/BullMQ) │
                       └──────────────────┼──────────────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
            │ Adapter:OTM  │    │ Adapter:MyWhoosh│   │ Adapter:Strava│
            │ (迈金/顽鹿)  │    │               │    │  (OAuth2)     │
            └───────┬───────┘    └───────┬───────┘    └───────┬───────┘
                    │                    │                    │
                    ▼                    ▼                    ▼
            ┌────────────────────────────────────────────────────────┐
            │           外部平台 API (官方 / 逆向 / Web 兜底)         │
            └────────────────────────────────────────────────────────┘

     ┌───────────────┐        ┌────────────────┐        ┌────────────────┐
     │   PostgreSQL  │        │     Redis      │        │  Object Store  │
     │ 业务数据+密文  │        │ 队列/限流/缓存  │        │ (S3/MinIO/本地卷)│
     └───────────────┘        └────────────────┘        └────────────────┘
     活动/任务/凭证密文/日志      幂等锁/退避状态          FIT/GPX 原始文件
```

### 关键横切能力

| 能力 | 实现 | 落点 |
|------|------|------|
| 认证/多用户 | JWT session + `user_id` 全链路隔离 | API 层 |
| 凭证保管 | 信封加密（AES-256-GCM + KMS/环境主密钥） | Credential Service |
| 速率控制 | 每平台令牌桶 + 每用户配额 + 全局并发上限 | Policy 层 |
| 失败处理 | 指数退避 + 抖动 + 最大重试 + 死信队列 | Policy 层 |
| 可观测性 | 结构化日志（pino）+ Prometheus 指标 + SSE 实时推送 | 贯穿 |
| 幂等 | `(platform, source_activity_id)` 唯一键 + 目标侧 external_id | DB + Adapter |
| 文件存储 | 内容寻址 blob（SHA-256）+ 元数据表 | Object Store |

---

## 二点五、单用户 + 纯自托管（决策 D2 / D3）

本项目的形态已锁定为**单用户、纯自托管**，因此架构上做了如下简化：

| 简化项 | 说明 |
|--------|------|
| 认证 | 单管理员账号，密码来自 `FITBRIDGE_PASSWORD`，未设置则首次启动随机生成并打印到日志 |
| 注册/找回/用户管理 | **不做**。重置密码走 CLI |
| 多租户隔离 | **不做 RLS**，但所有表保留 `user_id` 字段（未来放开多用户零改造） |
| 配额/计费 | **不做** |
| 暴露面 | 默认只监听 `127.0.0.1`，对外由用户自己的反向代理负责 |
| 存储 | Postgres（元数据+密文） + Redis（队列/限流） + S3/MinIO（文件），**不做云端备份** |

**数据存储策略**（详细论证见 [06-decisions.md](06-decisions.md#二核心问题有没有必要把所有数据本地存一份)）：

```
第 1 层  活动元数据   → Postgres 全量常驻（账本：幂等/增量/浏览/统计）
第 2 层  原始文件     → 对象存储，用到才存，默认保留 90 天，到期清理 blob 保留元数据
第 3 层  派生文件     → 不长期存，按需生成 + 7 天 TTL 缓存

存储倍率 ≈ 1× 原始文件大小。绝不做「平台全量镜像」——那会白白消耗限流配额。
```

---

## 三、模块划分

```
fitbridge/
├── apps/
│   ├── server/                 # Fastify API + 静态前端托管
│   ├── worker/                 # 同步执行进程（可水平扩展）
│   └── web/                    # React 控制台
├── packages/
│   ├── core/                   # 领域模型 + 同步引擎（平台无关）
│   │   ├── domain/             # Activity / ActivityFile / SyncTask / SyncRun
│   │   ├── engine/             # Discover→Fetch→Normalize→Dedupe→Fanout→Upload
│   │   ├── policy/             # 限流 / 退避 / 熔断 / 并发控制
│   │   └── ports/              # PlatformAdapter / FileStore / CredentialStore 接口
│   ├── adapters/               # ★ 平台适配器（插件）
│   │   ├── otm/                # 迈金 / 顽鹿 OTM
│   │   ├── mywhoosh/           # MyWhoosh
│   │   ├── strava/             # Strava
│   │   ├── igpsport/           # M3+
│   │   ├── outbase/
│   │   └── ...
│   ├── fitkit/                 # FIT/GPX 工具库（解析/构建/CRC/GCJ-02/时区）
│   └── contracts/              # zod schema + OpenAPI 生成
├── migrations/                 # 数据库迁移
├── deploy/
│   ├── docker-compose.yml
│   └── Dockerfile
└── docs/
```

### 3.1 平台无关的核心（packages/core）

核心引擎**不允许 import 任何平台代码**。它只依赖 `ports/` 下的抽象：

```ts
interface PlatformAdapter {
  readonly manifest: PlatformManifest;

  // 认证
  auth(req: AuthRequest): Promise<AuthResult>;
  refresh?(cred: Credential): Promise<Credential>;
  validate(cred: Credential): Promise<boolean>;

  // 读
  listActivities(cred: Credential, cursor?: Cursor): Promise<Paged<RemoteActivity>>;
  downloadFile(cred: Credential, activity: RemoteActivity): Promise<FilePayload>;

  // 写（manifest.capabilities.upload === true 时才存在）
  uploadFile?(cred: Credential, file: NormalizedFile, hint: UploadHint): Promise<UploadResult>;

  // 平台特有能力（如删除、评论）
  capabilities: PlatformCapabilities;
}
```

### 3.2 平台适配器（packages/adapters/*）

每个适配器目录结构统一：

```
adapters/otm/
├── manifest.ts        # 能力声明（下载/上传/坐标系/限流/风险等级）
├── auth.ts            # 登录 / token 刷新 / 有效性校验
├── client.ts          # HTTP 客户端（重试/限流/UA/Origin 伪装）
├── activities.ts      # 活动列表 / 详情
├── files.ts           # 下载（durl / fit_content）
├── upload.ts          # 上传（jilu0 multipart）
├── normalize.ts       # 平台数据 → 统一模型
├── fixtures/          # 录制的响应样本（离线回归测试用）
└── __tests__/
```

`manifest.ts` 是**能力矩阵的声明式来源**，Web 控制台直接由它渲染，用户能清楚看到每个平台的
「官方 / 逆向」「可下载 / 可上传」「坐标系」「限流」等属性：

```ts
export const otmManifest: PlatformManifest = {
  id: 'otm',
  displayName: '迈金 / 顽鹿 OTM',
  authType: 'password',
  access: 'reverse-engineered',        // UI 显示风险提示
  capabilities: {
    download: true,
    upload: true,
    uploadFormats: ['fit'],             // 仅 FIT
    deleteRemote: false,
  },
  coordinateSystem: 'gcj02',           // 规范化层据此自动转换
  rateLimit: { requestsPerMinute: 20, minLoginIntervalSec: 300 },
  uploadAsync: true,                    // 迈金异步入库 15-20s，需轮询确认
  riskLevel: 'medium',
};
```

### 3.3 fitkit（FIT/GPX 工具库）

直接对应参考项目里最有价值的三个文件，加上工程化封装：

| 模块 | 能力 | 来源 |
|------|------|------|
| `fit/parse` | FIT 二进制解析（message definitions / data records） | 需实现或移植 Garmin FIT SDK 的核心解码逻辑 |
| `fit/build` | FIT 构建（file_id→session→lap→activity→record 完整消息流） | 参考 `FitBuilder.kt` + `FitDeviceFaker.kt` |
| `fit/crc` | CRC-16/ARC 计算与校验 | 参考 `FitGcj02Fixer.kt` 内实现 |
| `fit/gcj02` | GCJ-02 → WGS-84 反算（含中国边界判断） | 参考 `FitGcj02Fixer.kt` |
| `fit/compliance` | 合规性扫描与修复：时间戳溢出 2^32、非法 ASCII、data_size、CRC | 提炼参考项目已知问题 |
| `gpx/parse` | GPX 解析（对应 `io.jenetics:jpx`） | GPX → Activity 转换 |
| `gpx/to-fit` | GPX → FIT 转换（保功率/心率/踏频） | 参考 `assets/gpx2fit.js` + `FitBuilder` |
| `time/zone` | 时区推断（平台时间戳 → IANA 时区） | 参考 `FitTimeFixer` / `GpxTimeFixer` |

**FIT 技术选型**：

- 方案 A：Java/Node 调用 `com.garmin:fit`（Garmin 官方 FIT SDK）—— 兼容性最好，但需 JVM 侧车
- 方案 B：TypeScript 原生 FIT 库 —— 纯 TS，部署简单，但字段覆盖与容错不如官方 SDK
- 方案 C：Rust/Python（`fitdecode` / `python-fitparse`）—— 成熟，但要跨语言

→ **建议：核心走 TypeScript 实现（可测试、可移植），保留一个 Java sidecar 用于「疑难文件兜底解析」**。
第一版直接用 TS 生态的 `fit-file-parser` + 自研 decoder，配套一组来自参考项目的**真实样本文件做回归测试**。

---

## 四、技术选型与取舍

### 4.1 后端语言

| 选项 | 优势 | 劣势 | 评分 |
|------|------|------|------|
| **TypeScript / Node** | 前后端同构；生态有 `fit-file-parser`、`bullmq`、`fastify`；OAuth/JSON 为主的工作负载性能足够 | FIT 精细解析弱于 Java SDK；CPU 密集（CRC/坐标转换）需注意 | ★★★★★ |
| **Python / FastAPI** | `python-fitparse`、`fitdecode`、数据处理库强；GPS/地理计算库好 | 异步 IO 生态弱于 Node；类型系统弱；前端要另写 TS | ★★★★ |
| **Java / Spring Boot** | 官方 `com.garmin:fit` SDK 原生可用；企业级生态 | 重；开发效率低；偏离「Web 控制台」的技术画像 | ★★★ |
| **Go / Rust** | 单二进制、并发好 | FIT/GPX 生态薄、开发速度慢 | ★★ |

**结论：TypeScript (Node 20+)**。理由：① 参考项目是 Kotlin，FIT 相关知识可平移；② 前后端同语言降低 Web
控制台开发成本；③ 该项目 90% 的工作是 HTTP + JSON + 文件流，Node 完全够用；④ 唯一短板是 FIT 精细解析，
用「TS 实现 + 样本回归测试 + Java sidecar 兜底」补齐。

### 4.2 Web 框架

- **Fastify**（推荐）：schema-first 校验（JSON Schema → 自动 OpenAPI）、插件生态好、性能优于 Express
- NestJS：适合超大型团队，本项目规模不需要它的重量级 DI
- Next.js 作为 BFF：会与 Fastify 职责重叠，除非要做 SSR/SEO（内部控制台不需要）

**结论：后端 Fastify + TypeBox/Zod；前端 React + Vite + TanStack Query + shadcn/ui。**

### 4.3 存储

| 组件 | 选型 | 理由 |
|------|------|------|
| 主数据库 | **PostgreSQL 16** | 事务 + JSONB + 唯一约束（幂等键）+ `SKIP LOCKED`（队列抢占）全都需要 |
| 队列/缓存 | **Redis 7** | BullMQ 队列、令牌桶限流、SSE 事件总线、分布式锁 |
| 文件存储 | **S3 兼容**（MinIO 自托管 / 阿里云 OSS / 本地卷适配） | FIT 文件体积大（几 MB～几十 MB），不该进 DB |
| 凭证密钥 | **KMS / age / SOPS** 或环境变量主密钥 | 信封加密，主密钥不入库 |

**结论：PostgreSQL + Redis + S3 兼容对象存储。** 本地一键起：`docker compose up -d`。

### 4.4 任务队列

- **BullMQ**（推荐）：Redis 原生，延迟任务/重试/并发控制成熟，有 dashboard
- Temporal：工作流能力更强（长流程补偿），但引入额外服务和较高学习成本 —— 可作为第二阶段升级项
- pg-boss：纯 Postgres，依赖更少，但生态弱于 BullMQ

**结论：BullMQ。** 同步任务是典型的「可重试、可延迟、扇出」工作负载，BullMQ 刚好覆盖。

### 4.5 Web 兜底（WebView）

部分平台（Outbase / Keep / TwoBulu / Komoot）无 API，只能自动化浏览器登录 + 抓包。

- 方案 A：Playwright（Node 原生，最容易集成）
- 方案 B：Chromium + CDP 手工控制（更轻，但抽象成本高）

**结论：Playwright，独立 `fitbridge-worker-browser` 容器，浏览器 profile 持久化卷，
与主服务解耦（浏览器崩溃不影响 API）。**

---

## 五、同步引擎流程

```
┌─ SyncTask 触发（手动 / 定时 / Webhook）─────────────────────────────┐
│                                                                    │
│  1. Policy Gate                                                   │
│     ├─ 检查 task 是否启用 / 是否在允许的时间窗                        │
│     ├─ 检查该 (platform, credential) 的令牌桶余量                     │
│     ├─ 检查该平台是否处于熔断状态（连续失败 N 次 → 熔断 M 分钟）       │
│     └─ 不通过 → 延迟重排队（不消耗配额）                             │
│                                                                    │
│  2. Discover（每个 source 平台）                                     │
│     ├─ listActivities(cursor)  ← 增量：基于 sync_state.last_cursor    │
│     ├─ 拉取详情（按需，懒加载）                                     │
│     └─ 产出候选活动列表                                             │
│                                                                    │
│  3. Dedupe（幂等）                                                  │
│     ├─ 键 = (user_id, source_platform, source_activity_id)           │
│     ├─ 命中已同步记录 → 跳过（除非强制重传）                           │
│     └─ 未命中 → 入队                                                │
│                                                                    │
│  4. Fetch + Normalize                                              │
│     ├─ downloadFile → Blob（内容寻址存储）                            │
│     ├─ 格式识别：FIT / GPX / TCX                                     │
│     ├─ 时区校正（按平台 manifest + 用户覆盖）                          │
│     ├─ 坐标校正（GCJ-02 → WGS-84）                                   │
│     ├─ FIT 合规性扫描与修复                                          │
│     └─ 产出 NormalizedActivity + NormalizedFile                     │
│                                                                    │
│  5. Fan-out（每个 target 平台）                                     │
│     ├─ 目标是否支持该格式？→ 必要时 GPX→FIT 转换                      │
│     ├─ 构造 UploadHint（活动名、时间、运动类型）                        │
│     └─ 调用 adapter.uploadFile()                                     │
│                                                                    │
│  6. Verify（可选）                                                 │
│     ├─ 迈金等异步平台 → 轮询活动列表确认入库（15-20s）                │
│     └─ 记录 remote_activity_id                                       │
│                                                                    │
│  7. Record                                                        │
│     ├─ 写 SyncItem 结果（成功/跳过/失败 + 错误码 + 目标响应 ID）       │
│     ├─ 更新 sync_state.last_cursor / last_sync_at                    │
│     └─ 推送 SSE 事件到 Web 控制台                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 5.1 幂等与去重设计（三层）

| 层级 | 机制 | 作用 |
|------|------|------|
| L1 来源去重 | DB 唯一索引 `(user_id, source_platform, source_activity_id)` | 同一条源活动不重复处理 |
| L2 目标幂等 | 目标平台自身的幂等键（Intervals.icu 用 `external_id`；其他平台用「同时间+同距离+同文件名」指纹） | 任务重跑不会产生重复活动 |
| L3 目标侧探测 | 上传前可选查询目标平台最近活动列表做「软存在检查」 | 兜底防止 L2 失效的平台产生副本 |

`external_id` 约定（跨平台通用）：`{source_short_code}{source_activity_id}`，例如 `mg12345678`。
参考项目已有此实践（Intervals.icu）。

### 5.2 增量同步

每个 `(user, source_platform)` 维护 `sync_state`：

```
last_cursor       TEXT    -- 平台分页游标或最后拉取的活动 ID / 时间戳
last_sync_at      TIMESTAMPTZ
last_success_at   TIMESTAMPTZ
lookback_window   INTERVAL -- 回看窗口，兜底平台乱序/延迟入库（默认 24h）
```

**增量策略**：以 `last_success_at - lookback_window` 为起点拉取，与 DB 已有记录做去重。
不用「只看最新 N 条」是因为很多平台会延迟入库或乱序（迈金异步入库 15-20s，跨设备可能更长）。

### 5.3 限流与退避策略

```
令牌桶（每 platform + credential 维度）
  ├─ Strava:  非上传 100/15min，上传 200/15min，日 2000
  ├─ OTM:     20/min，登录最小间隔 5min
  ├─ MyWhoosh: 30/min
  └─ 默认:    30/min

退避：base 30s × 2^attempt + jitter(±20%)，上限 30min
重试：可重试错误（429/5xx/网络）→ 重试；不可重试（401/400 校验错）→ 直接失败并告警
熔断：连续 N=5 次同类失败 → 熔断 M=30min，期间任务排队不执行
```

### 5.4 错误分类（决定重试策略）

| 类别 | 示例 | 策略 |
|------|------|------|
| `AUTH_EXPIRED` | token 401 | 尝试 refresh → 失败则标记账号需重连，暂停该平台任务 |
| `RATE_LIMITED` | 429 / 验证码 | 退避重试，命中风控则熔断 + 通知用户 |
| `VALIDATION_FAILED` | FIT 不合法、上传被拒 | 不重试；记录详细原因，提供「修复后重试」按钮 |
| `TRANSIENT` | 网络错误、5xx | 退避重试 |
| `NOT_FOUND` | 活动已删除 | 标记 tombstone，跳过 |
| `FORBIDDEN` | 403 / 权限 | 不重试，告警 |

---

## 六、Web 控制台设计

### 6.1 页面结构

```
┌──────────────────────────────────────────────────────────────────┐
│  FitBridge            [连接账号] [同步任务] [活动] [日志] [设置]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① 仪表盘 Dashboard                                             │
│     · 平台连接状态卡片（已连接/待重连/异常）                        │
│     · 24h 同步统计（成功/跳过/失败/字节数）                        │
│     · 最近同步任务列表 + 实时进度                                  │
│     · 告警横幅（账号风控、接口变更、token 即将过期）                 │
│                                                                  │
│  ② 平台账号 Connections                                         │
│     · 按平台分组卡片（来自 manifest 渲染）                          │
│     · 显示能力标签：官方API / 逆向 / 仅下载 / 仅上传                │
│     · 连接流程：OAuth 跳转 / 账号密码表单 / 二维码（国内平台）        │
│     · 凭证状态、最后校验时间、token 过期时间、撤销按钮                │
│     · 逆向平台额外弹「使用非官方接口，可能违反平台条款」确认          │
│                                                                  │
│  ③ 同步任务 Tasks                                                │
│     · 新建任务：来源(多选) × 目标(多选) × 过滤条件 × 调度             │
│     · 策略配置：增量开关、去重策略、坐标/时区转换开关、                │
│                 单次条数上限、重试策略、失败目标是否跳过               │
│     · 任务卡片：状态、下次运行时间、最近结果分布                     │
│     · 手动触发 / 暂停 / 恢复 / 复制 / 删除                          │
│                                                                  │
│  ④ 活动浏览 Activities                                            │
│     · 跨平台统一列表（时间/距离/时长/类型/来源/已同步目标）             │
│     · 过滤：日期范围、运动类型、来源平台、是否已同步                  │
│     · 详情：轨迹图、图表（速度/心率/功率/踏频）、文件预览              │
│     · 操作：手动同步到某目标 / 重试 / 删除本地副本                    │
│     · 对比：两个平台的同一条活动（数据差异高亮）                       │
│                                                                  │
│  ⑤ 运行日志 Logs                                                  │
│     · 实时 SSE 流 + 历史查询                                       │
│     · 结构化字段：level/platform/task/activity/errorCode              │
│     · 一键「复制为诊断包」（脱敏，不含凭证）                          │
│                                                                  │
│  ⑥ 设置 Settings                                                 │
│     · 全局默认：时区、坐标转换、限流强度、存储保留期                    │
│     · 通知渠道：Webhook / 邮件 / Telegram                            │
│     · 数据管理：导出全部活动、删除账号、撤销全部 token                 │
│     · 管理员：多用户开关、审计日志（自托管单人可隐藏）                   │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 实时化：Webhook + 轮询兜底

```
┌─ 数据获取策略（混合模式）───────────────────────────────────┐
│                                                            │
│  Webhook 实时（优先）                                        │
│   ├─ Strava: POST /api/v3/push_subscriptions                │
│   │   ⚠️ 每个 app 只能有一个订阅 → 用共享 app 订阅 +        │
│   │      按事件里的 owner_id 分发到对应用户                   │
│   │   ⚠️ 事件是 thin pointer（object_id/owner_id/            │
│   │      aspect_type），必须回查 API 拿详情                 │
│   │   ⚠️ 验证流程：GET hub.challenge 回显 + 校验             │
│   │      hub.verify_token                                   │
│   └─ 其他平台：暂无 webhook                                  │
│                                                            │
│  轮询兜底（必选）                                            │
│   ├─ 高频任务：15 min（用户自定义）                          │
│   ├─ 普通任务：30~60 min                                     │
│   └─ 低频/受限平台：2~6 h（避免风控）                        │
│                                                            │
│  Webhook 事件 → 入队「按 activity id 拉取并同步」任务        │
│  → 天然幂等（去重键生效）                                    │
└────────────────────────────────────────────────────────────┘
```

### 6.3 安全设计

| 风险 | 对策 |
|------|------|
| 凭证泄露 | 信封加密存储；API 永不返回 token/密码（只返回 masked + 状态）；前端无敏感字段 |
| 凭证解密时机 | 只在 worker 内存中、按需解密、用完立即清理；不做内存缓存 |
| 多用户越权 | 所有查询强制带 `user_id`；Postgres RLS（Row Level Security）作为第二道防线 |
| SSRF | Adapter 允许访问的域名白名单；下载链接（七牛直链/S3 预签名）需校验 host |
| 恶意文件 | 上传文件 magic number 校验、大小限制、FIT/GPX 解析沙箱 |
| CSRF | OAuth state 参数 + SameSite Cookie + CSRF token |
| 审计 | 记录「谁在何时对哪个平台做了什么」，不记录 token 内容 |
| 密钥管理 | 主密钥来自环境变量 / KMS / age 加密文件；提供 `fitbridge key rotate` 命令 |

---

## 七、目录级实现顺序（与路线图对齐）

```
Step 1  packages/fitkit        FIT 解析 / 构建 / CRC / GCJ-02 / 时区  ← 一切的地基
Step 2  packages/core/ports    PlatformAdapter 契约 + PlatformManifest
Step 3  packages/core/domain   Activity / File / Task / Run 数据模型
Step 4  packages/core/engine   同步引擎 + Policy + Dedupe
Step 5  packages/adapters/otm  迈金/OTM（登录/列表/详情/下载/上传/GCJ-02）
Step 6  apps/server            Fastify API + Postgres + Redis + BullMQ + SSE
Step 7  apps/web               React 控制台 v1（连接账号 / 任务 / 日志）
Step 8  packages/adapters/{mywhoosh,strava}
Step 9  packages/adapters/*    扩展平台 + Webhook + 通知
```

