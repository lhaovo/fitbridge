# 决策记录（D1）与本地存储策略

> 本文档记录 2026-11-13 的最终决策，**优先级高于其他文档中的备选方案**。

---

## 一、已锁定的决策

| ID | 决策 | 影响 |
|----|------|------|
| **D1** | **只复用参考项目的「可复用逻辑」** | 复用：平台接口协议细节、GCJ-02 转换算法、CRC 算法、去重键设计、OAuth2 模板思路。不复用：Android UI / WebView / WorkManager / SharedPreferences / 硬编码时区档位。参考项目代码仅作**算法与协议参考**，不 fork、不逐行移植。 |
| **D2** | **单用户设计** | 无注册/找回/用户管理页；一个管理员账号；`user_id` 字段仍保留在所有表（未来多用户零改造）；不做 RLS、不做配额。 |
| **D3** | **纯自托管部署** | 只提供 Docker Compose 形态，不做官方托管 SaaS，不做桌面 Agent 分发。数据、凭证、文件全部在用户自己的机器上。 |
| **D4** | **首批平台 = 迈金/顽鹿OTM + MyWhoosh** | 两者都是下载源；迈金同时具备上传能力 → M0 可打通「MyWhoosh → 迈金」的真实纵向切片。Strava / Intervals.icu 等推到 M2。 |
| **D5** | **FIT 路线从简单的来** | 基于 `fit-file-parser`（MIT，v6.2.7，活跃维护）做 **只读解析**；GPX→FIT 构建、FIT 修复、设备伪装等全部推迟。接口先留桩。 |
| **D6** | **单体 + SQLite + 本地文件，不用 Docker** | 去掉 Postgres / Redis / MinIO 三个外部服务：数据库用 Node 内置的 `node:sqlite`；队列暂用进程内；文件存本地磁盘（内容寻址）；整个 FitBridge 状态 = 一个数据目录。`FileStore` 接口留好，将来要 S3/多用户再换实现。 |

### D2 的具体简化

| 项 | 方案 |
|----|------|
| 账号 | 首个实例自动创建管理员账号；密码来自 `FITBRIDGE_PASSWORD` 环境变量，未设置则**首次启动随机生成并打印到日志**（仅打印一次） |
| 登录 | 单表单登录 → HttpOnly Cookie（session）；无 OAuth 登录、无注册页、无找回页 |
| 重置密码 | CLI：`docker compose exec server node dist/cli/reset-password.js` |
| API 鉴权 | `Authorization: Bearer <session>` 或 Cookie；写操作要求 CSRF token |
| 未来多用户 | 表结构已带 `user_id`；届时只需放开注册 + 加 RLS，引擎不动 |

### D3 的具体形态

```
docker compose up -d
  fitbridge-server   :8080   API + 静态前端
  fitbridge-worker   -       同步执行
  fitbridge-postgres :5432   业务数据 + 凭证密文
  fitbridge-redis    :6379   队列 + 限流
  fitbridge-minio    :9000   FIT/GPX 文件（可用本地卷替代）
```

- 默认只监听 `127.0.0.1`；对外暴露由用户自己的反向代理负责
- 提供 `scripts/backup.sh`（pg_dump + blob 目录打包）与 `scripts/restore.sh`
- 提供 `scripts/upgrade.sh`（拉新镜像 + 迁移 + 保留数据卷）

---

## 二、核心问题：有没有必要把所有数据本地存一份？

**结论：元数据全量常驻，文件「用到才存 + 按保留期清理」，不做全量镜像。**

分三层看：

### 第 1 层 · 活动元数据 —— **必须全量存**（这是「账本」）

每个平台的每条活动都记一条：来源平台、来源 ID、名称、时间、距离、时长、运动类型、指标、文件引用、已同步目标、修正标记。

| 为什么必须 | 说明 |
|------------|------|
| 幂等去重的唯一依据 | 没有本地账本，每次同步都要全量重拉平台列表，直接撞限流（迈金/佳明最怕这个） |
| 增量同步的游标 | `sync_states` 需要知道上次拉到哪了 |
| Web 控制台的浏览/筛选/统计 | 「统一运动库」本身就是产品核心价值 |
| 源平台数据被删后的可见性 | 本地还能告诉用户「你曾在平台 X 有这条活动，现已消失」 |

**成本**：一条约 1–2 KB → 1000 条约 2 MB。可以忽略。

### 第 2 层 · 原始文件 —— **用到才存 + TTL 保留**

| 什么时候存 | 活动被某个任务处理时（下载完成立即落盘，内容寻址） |
|------------|--------------------------------------------|
| **为什么不能预先全量下** | 用户可能有几千条历史活动 × 5–20 MB = 几十 GB；而且其中大半永远不会被同步出去。预先全量下载会**白白消耗平台限流配额**，这正是迈金/佳明触发风控的头号原因 |
| **为什么不能完全不存** | ① 源平台可能删活动、文件直链会过期；② 之后想同步到新平台时需要原文件，重新下载会再次撞限流甚至直接失败；③ 源平台接口挂了/被封时本地还有救 |
| **保留期** | 默认 **90 天**，可配置（30 / 90 / 365 / 永久）。到期清理 blob，**保留元数据**，该活动在 UI 上标记为「文件已清理（可重新拉取）」 |

### 第 3 层 · 规范化/派生文件 —— **不长期存，按需生成 + 短 TTL 缓存**

| 产物 | 策略 |
|------|------|
| GCJ-02→WGS-84 转换后的 FIT | 生成后写入派生缓存，TTL 7 天 |
| GPX→FIT 转换结果 | 同上 |

**理由**：转换逻辑是确定性的，同一原始文件投给多个目标平台时结果一致，缓存即可，没必要长期占空间。
这让存储倍率保持 **1× 原始**，而不是 2×。

### 存储容量估算

| 场景 | 计算 | 结果 |
|------|------|------|
| 单条骑行 FIT（含功率/心率/踏频） | 1–10 MB | — |
| 一人一年（300 条 × 5 MB） | | ≈ 1.5 GB |
| 90 天保留期稳态 | 90/365 × 1.5 GB | ≈ 400 MB |
| 10 个用户（未来） | | ≈ 4 GB |

单用户自托管，MinIO 或本地卷完全够用。

### 明确「不做」的事

| 不做 | 原因 |
|------|------|
| ❌ 平台全量镜像功能 | 用户容易误解这是备份工具；且会消耗限流配额。改为提供**显式的「导出全部」动作**（ZIP：原始文件 + CSV）作为备份手段 |
| ❌ 明文凭证 / 账号密码落库 | 一律信封加密 |
| ❌ 云端备份 / 云端同步 | 纯自托管，数据不出用户机器 |
| ❌ 无限期保留文件 | 默认 90 天上限，避免磁盘被悄悄吃满 |

### 权威性约定（写进 UI）

> **平台是权威（source of truth），本地是「账本 + 缓存」。**
> 本地数据被删 → 可从平台重新拉（只要平台还在、没被限流）。
> 平台数据被删 → 本地保留账本并标记「源端已删除」，由用户决定是否清理。

---

## 三、D4 带来的 M0 范围调整

### 3.1 M0 目标重新定义

> **M0 = 打通「MyWhoosh → 迈金/OTM」一条真实纵向切片，同时把两个源平台的全部活动汇集成一个本地统一运动库。**

这条切片同时验证了：下载 → 格式识别 → 时区/坐标规范化 → FIT 构建 → 上传 → 幂等 → 日志 → Web 展示。

```
MyWhoosh(源) ──下载──▶ 解析/规范化 ──GPX→FIT(if needed)──▶ 迈金OTM(目标) 上传
迈金OTM(源) ──下载──▶ GCJ-02→WGS-84 修正 ──▶ 本地统一运动库
```

### 3.2 平台能力在 M0 的形态

| 平台 | 认证 | 下载 | 上传 | M0 备注 |
|------|------|------|------|---------|
| 迈金 / 顽鹿 OTM | 账号密码 → JWT + refresh_token | ✅ 列表/详情/fit_content | ✅ `jilu0` multipart，异步入库 15–20s | 下载优先；上传用于「MyWhoosh→迈金」 |
| MyWhoosh | 账号密码 → AccessToken + WhooshId | ✅ 列表 + S3 预签名下载 | ❌ 无上传 API | 纯源 |

### 3.3 M0 里程碑（收敛版）

| # | 交付物 | 验收 |
|---|--------|------|
| 0.1 | Monorepo（pnpm workspace + Turborepo）、Docker Compose（server/worker/postgres/redis/minio） | `docker compose up -d` 全绿 |
| 0.2 | `packages/fitkit`：**只读**解析（基于 fit-file-parser）+ 活动摘要提取 + 坐标/时区识别 | 真实样本解析出时间/距离/时长/轨迹点/心率/功率/踏频 |
| 0.3 | `packages/core`：领域模型 + `PlatformAdapter` 契约 + `PlatformManifest` + 存储策略常量 | 契约测试通过 |
| 0.4 | Postgres schema（按「三层存储」落地）+ 迁移 | 迁移可正向/回滚 |
| 0.5 | 服务端骨架：单用户认证（env 密码/首次生成）、凭证信封加密、健康检查 | 库里搜不到明文 token |
| 0.6 | Adapter `otm`：登录 / 刷新 / 列表 / 详情 / 下载 / 上传 | 真实账号跑通下载 |
| 0.7 | Adapter `mywhoosh`：登录 / 列表 / 下载 | 真实账号跑通下载 |
| 0.8 | 同步引擎：Discover→Fetch→Normalize→Dedupe→Fanout→Upload（下载路径优先） | 自动任务能跑 |
| 0.9 | Web 控制台 v1：平台连接 + 活动库（列表/详情/轨迹图）+ 手动同步 + SSE 日志 | 不用命令行完成一次同步 |
| 0.10 | 导出全部（ZIP）+ 备份脚本 + 部署文档 | 新用户 10 分钟内跑起来 |

### 3.4 M0 明确**不做**

| 不做 | 推后到 |
|------|--------|
| GPX→FIT 完整构建 | M0 只在 MyWhoosh 文件是 GPX 时才需要；若实测全是 FIT 则直接推后到 M1 |
| FIT 合规修复（CRC/时间戳溢出/非法 ASCII） | M1 |
| FIT 设备伪装（Garmin 系） | M3 |
| Strava / Intervals.icu / iGPSPORT 等 | M2 |
| 多用户 / 用户管理 / 审计 | M2（仅预留字段） |
| Web 兜底（Playwright） | M2 |
| AI 摘要类功能 | 不做（Strava 政策 5.3 的护栏） |

---

## 四、D5 的具体落地（FIT 简单路线）

### 4.1 选型

| 库 | 版本 | 许可 | 状态 | 用途 |
|----|------|------|------|------|
| **`fit-file-parser`** | 6.2.7 | MIT | 2026-10 仍在更新 | ★ **M0 主力**：解析 + 编码 + CRC 校验；127 message / 1462 field / 200 type profile；支持 developer field；ESM/CJS + TS 声明 |
| `@garmin/fitsdk` | 21.221.0 | Garmin 官方 | 官方维护 | 升级路径：疑难文件兜底解析/交叉校验（与参考项目用的 Java `com.garmin:fit:21.176.0` 同版本系） |

`fit-file-parser` 的关键能力正好覆盖我们的痛点：

- `new FitParser({ force: false })` → **开启 CRC 校验**（参考项目里 CRC 重算是手写的，这里直接用库的）
- `parseAsync(buffer)` → 拿到 `records / sessions / laps` 结构化数据
- `parseFilesAsync(buffer)` → 处理拼接的多个 FIT 文件
- `includeUnmappedMessages` / `raw_messages` → 遇到未知字段不丢数据
- **编码能力** → M1 做 GPX→FIT 构建时可直接用，不必自己实现 FIT 二进制写入

### 4.2 M0 只实现 `readFit()`

```
packages/fitkit/
├── src/
│   ├── index.ts
│   ├── read.ts        # ★ M0 实现：parse → FitSummary
│   ├── summary.ts     # FitSummary 类型（活动摘要 + 轨迹 + 指标）
│   ├── geo.ts         # GCJ-02 ⇄ WGS-84 转换（纯函数，M0 用于「识别+标注」即可）
│   ├── build.ts       # stub：GPX→FIT（M1）
│   ├── repair.ts      # stub：FIT 合规修复（M1）
│   └── compliance.ts  # stub：合规扫描（M1）
└── __tests__/
```

**M0 的 `readFit()` 输出**（FitSummary）：

```ts
interface FitSummary {
  fileId?: string;
  sportType?: string;
  startTime?: Date;              // UTC
  endTime?: Date;
  timestampRange?: { start: number; end: number };  // FIT epoch (1989-12-31)
  totalDistanceM?: number;       // 米
  totalElapsedSec?: number;
  totalTimerSec?: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  elevationGainM?: number;
  track: Array<{ lat: number; lon: number; alt?: number; t: number }>;
  hasPower: boolean;
  hasHeartRate: boolean;
  hasCadence: boolean;
  crcValid: boolean;
  warnings: string[];            // 'crc-invalid' | 'timestamp-overflow' | ...
}
```

### 4.3 「简单路线」的边界（提前说清，避免范围蔓延）

| 做 | 不做 |
|----|------|
| 解析出活动摘要与轨迹 | 不追求 100% 字段还原（能取到多少取多少） |
| 用库做 CRC 校验并记录 `crcValid` | 不自己写 FIT 二进制解析器 |
| 识别坐标系并做 GCJ-02→WGS-84 转换（改坐标后重新编码） | 不做完整的 FIT 合规修复链（时间戳溢出、非法 ASCII、data_size） |
| 用库做「改坐标后重新编码」（M1 需要时） | 不做设备指纹伪装 |
| 依赖库处理未知字段不丢数据 | 不自建 FIT profile（用库内置的 127 message profile） |

### 4.4 升级路径（写进代码注释）

```
M0  fit-file-parser 解析          ──┐
                                    ├─► 若某平台文件解析率 < 95%
M2  @garmin/fitsdk 兜底解析      ──┘    → 引入官方 SDK 作为二级解析器
```

fitkit 对外只暴露 `readFit()` 契约，内部实现可替换，解析器切换不影响引擎。

---

## 五、被决策否决的备选（记录以免反复讨论）

| 议题 | 被否决 | 原因 |
|------|--------|------|
| 多租户 SaaS | D3 | 合规压力（Strava 5.16）、运维成本、当前无需求 |
| 纯前端 Web（浏览器直连平台） | — | CORS + token 风险 + 无法定时任务 |
| 桌面 Agent | D3 | 分发与跨平台成本高，纯自托管更简单 |
| 自研 FIT 解析器 | D5 | `fit-file-parser` 已够用；官方 SDK 留作兜底 |
| 全量镜像所有平台历史 | — | 消耗限流配额、存储浪费 |
| 无限期保留文件 | — | 磁盘风险 |
| 第一版就做 Strava | D4 | 需用户自填 client_id，门槛高；M2 再做 |



---

## 六、D6 详解：单体 + SQLite + 本地文件

### 为什么砍掉三个外部服务

| 原方案 | 现状 | 理由 |
|--------|------|------|
| PostgreSQL | **SQLite**（`node:sqlite`，Node 内置） | 单用户场景引入独立数据库服务没有收益；SQLite 单文件、零安装、事务/唯一约束/JSON1 都有 |
| Redis + BullMQ | 进程内队列（M0 先不用） | 队列的唯一用途是跑同步任务，单进程不需要；真需要时再引入 |
| MinIO / S3 | **本地文件系统**（内容寻址） | FIT 文件是二进制大对象不适合进 DB，但单用户自托管用本地磁盘完全够；要远程/多用户再换 S3 实现 |

**结果**：从「5 个容器」降到「1 个进程 + 1 个目录」。

### 数据目录布局

```
data/
├── fitbridge.db      SQLite（业务数据 + 凭证密文）WAL 模式
├── fitbridge.db-wal
├── fitbridge.db-shm
├── blobs/            FIT/GPX 原文件（内容寻址 sha256/ab/cd/<hash>）
└── master.key        凭证加密主密钥（0600，自动生成）
```

**备份 = 打包这个目录**（`scripts/backup.sh`）。
主密钥丢了，已保存的平台凭证就解不开 —— 所以备份时别漏它。

### SQLite 方言差异（已在 db.ts 层消化）

| Postgres | SQLite | 处理方式 |
|----------|--------|---------|
| `gen_random_uuid()` | 无 | 应用层 `randomUUID()` |
| `JSONB` | `TEXT` + `json_valid()` 约束 | 存 JSON 字符串 |
| `TEXT[]` | `TEXT`（JSON 数组） | 同上 |
| `TIMESTAMPTZ` | `TEXT`（ISO-8601 UTC） | 应用层统一格式 |
| `BYTEA` | `BLOB` | 直接对应 |
| `RETURNING id` | `lastInsertRowid` | `db.run()` 返回值 |

上层接口（`query` / `one` / `run` / `transaction`）保持不变，将来换 Postgres 只改 `lib/db.ts` 一个文件。

### 运行时要求

`node:sqlite` 需要 **Node >= 22.5**（本项目已在 `engines` 声明）。
打包器/测试运行器可能还不认识它是内置模块，因此 `db.ts` 用 `createRequire` 动态加载。
