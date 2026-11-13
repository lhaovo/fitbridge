# 调研报告

> 调研时间：2026-11　|　调研范围：参考项目源码、目标平台接口现状、平台方开发者政策

---

## 一、目标与边界

FitBridge 要解决的问题：用户的运动数据散落在多个平台（迈金/顽鹿 OTM、MyWhoosh、Strava、iGPSPORT、
行者、Outbase、Garmin、Wahoo、Intervals.icu …），缺少一个统一的**导入 / 导出 / 迁移 / 备份**通道。

调研需要回答四个问题：

1. **参考项目做了什么，能复用什么？**（技术可行性）
2. **各平台到底有没有官方 API？**（合规性与稳定性）
3. **做成什么形态？**（App / Web / 桌面 Agent）
4. **2026 年有什么政策变化会影响方案？**（风险）

---

## 二、参考项目逆向分析

**仓库**：[Anathleticbicyclist/sports-data-sync-multiplatform](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform)
**定位**：Android App（Kotlin），包名 `com.jichi.ob.dev`，版本线 v9.x。
**规模**：API 适配层约 12.8k 行 Kotlin，覆盖 20+ 平台。

### 2.1 目录结构（API 层）

```
app/src/main/java/com/jichi/ob/
├── api/                    # 平台适配器（每个平台一个文件）
│   ├── MageneApi.kt         # 迈金 / 顽鹿 OTM
│   ├── MyWhooshApi.kt       # MyWhoosh
│   ├── IgpsportApi.kt       # iGPSPORT
│   ├── XingzheApi.kt        # 行者
│   ├── OutbaseApi.kt        # Outbase
│   ├── GarminApi.kt / GarminOAuthHelper.kt / GarminWellnessSync.kt
│   ├── CorosApi.kt / WahooApi.kt / WahooOAuth2Service.kt
│   ├── IntervalsIcuApi.kt / KomootApi.kt / SuuntoApi.kt
│   ├── BlackbirdApi.kt / BrytonApi.kt / GiantApi.kt / CodoonApi.kt
│   ├── KeepApi.kt / ZeppApi.kt / ZwiftApi.kt / TwoBuluApi.kt
│   ├── DevOAuth2Api.kt      # Strava / Polar / Fitbit / Withings / TrainingPeaks 通用 OAuth2
│   ├── UploadEngine.kt      # 统一上传引擎（797 行）
│   └── FitBuilder.kt / FitDeviceFaker.kt
├── model/
│   ├── Activity.kt          # DataSource 枚举(29) + UploadSupport 枚举 + FileKind
│   └── SyncTask.kt          # 同步任务模型
├── util/
│   ├── ActivityCache.kt     # 同步记忆（去重，上限 10000 条）
│   ├── FitGcj02Fixer.kt     # GCJ-02 → WGS-84 转换 + CRC-16/ARC 重算
│   ├── FitTimeFixer.kt / GpxTimeFixer.kt
│   ├── PrefsManager.kt      # 本地凭据存储
│   └── WebBridge.kt         # WebView + JS 桥兜底
└── assets/
    ├── bridge.html / gpx2fit.js / magene_fix.js
```

### 2.2 核心设计（值得直接借鉴的部分）

**a) 双枚举能力矩阵** — `DataSource` 定义平台，`UploadSupport` 独立标注每个平台的「能否作为上传目标」及
备注。这是很聪明的解耦：新增平台只需在两个枚举各加一行，不必改引擎逻辑。

**b) 统一上传引擎** — `UploadEngine.kt` 用 `when (target)` 分发到各平台上传实现。上传前统一做
「文件类型校验 → 必要时 GPX→FIT 转换 → 目标平台字段适配」。

**c) 同步记忆（去重）** — `ActivityCache.kt` 用「平台 + 源活动 ID」作为去重键，缓存上限 10000 条，
避免重复上传。这是幂等性的基础。

**d) GCJ-02 坐标修正** — `FitGcj02Fixer.kt`（243 行）解包 FIT → 遍历 `record` 消息的 GPS 经纬度 →
GCJ-02 反算 WGS-84 → 回写 → 重算 CRC。**这是本项目最有价值的一段复用**。

**e) 时区修正** — `FitTimeFixer.kt` / `GpxTimeFixer.kt`。

**f) OAuth2 通用适配** — `DevOAuth2Api.kt`（258 行）用一份配置描述（authUrl / tokenUrl / apiBase /
uploadUrl / scope）就适配 Strava、Polar、Fitbit、Withings、TrainingPeaks 五个平台。

**g) FIT 依赖** — `com.garmin:fit:21.176.0`（解析/编码 FIT）+ `io.jenetics:jpx:3.1.0`（GPX）。

### 2.3 参考项目踩坑清单（重要论据）

这些是真实用户反馈的缺陷，**直接决定了本项目的架构必须解决的问题**：

| 问题 | 现象 | 本项目的应对 |
|------|------|--------------|
| **时区错误** | 行者 FIT 的 `local_timestamp` 偷懒复制 UTC 值 → 导入后显示慢 8 小时 | 中间模型强制记录 `timezoneOffset`；上传前统一校正；提供「原始时间 / 校正时间」双写 |
| **坐标系偏移** | 迈金 FIT 为 GCJ-02 → 导入 Strava/Wahoo 偏移约 450m | 规范化层做 GCJ-02→WGS-84 转换（复用 FitGcj02Fixer），并在 UI 上标注每个来源的坐标系 |
| **平台解析严格度差异** | 迈金/黑鸟解析严格（要求标准 FIT）；行者/Outbase 宽松能「洗数据」 | 上传前做 **FIT 合规性校验 + 修复**（CRC、时间戳溢出、非法 ASCII、data_size） |
| **账号风控** | 佳明频繁登录触发 429 / 验证码，冷却数小时至一天 | 全局令牌桶限流 + 每平台最小登录间隔 + 熔断 + 人工介入告警 |
| **Token 配额** | Wahoo 每用户最多 10 枚未撤销 token | 凭证引用计数 + 复用优先 + 用完提示撤销 |
| **过期 WebView 状态** | iGPSPORT WebView 残留过期 localStorage → 403 | Web 兜底登录放到独立会话存储 + 主动清理 + 失效检测 |
| **MFA 不支持** | 佳明两步验证无法自动化 | 明确标记该平台「需人工授权」，走设备码/OAuth 官方路径 |
| **FIT 时间戳溢出** | 部分 FIT 时间戳接近 2^32 → Wahoo 解析失败 | 上传前扫描 `timestamp` 字段，溢出则重写为合法 32 位值 |
| **WebView 兜底依赖** | Outbase/Keep/TwoBulu 等无 API，只能 WebView + JS 桥 | Web 兜底做成**独立 Worker + 浏览器池**，与主服务解耦部署 |

### 2.4 不可照搬的部分

- **Android 依赖**：WebView、WorkManager、SharedPreferences、本地文件路径 → 换成本地 Docker volume
- **硬编码时区档位**：参考项目按「平台 + 来源」硬编码偏移（如 +8h），应改为**运行时推断 + 用户可覆盖**
- **本地单体存储**：SharedPreferences 存凭证、活动列表缓存在内存 → 服务端需要真正的数据库 + 加密密钥管理
- **UI 逻辑与同步耦合**：参考项目同步逻辑在 Activity/Service 里 → 本项目必须把同步引擎做成**纯后端服务**，UI 只做编排

### 2.5 结论

参考项目证明了「多平台同步」在技术上完全可行，且提供了**最有价值的部分——各平台的接口协议细节**。
但它是一个**单机 Android App**：

- 凭证与活动缓存都在设备本地 → 多设备、无人值守的定时同步做不了
- 平台适配代码与 UI 强耦合 → 难以扩展与测试
- 无 API 边界 → 无法多用户、无法被其他系统集成

→ **本项目应当做 Web 服务端形态**，把参考项目的 API 适配层迁移为服务端插件。

---

## 三、目标平台生态现状

### 3.1 能力矩阵

| 平台 | 官方 API | 可下载 | 可上传 | 认证方式 | 备注 |
|------|---------|--------|--------|---------|------|
| **迈金 / 顽鹿 OTM** | ❌ 无公开开放 API | ✅ | ✅ | 账号密码 → JWT | 逆向 `otm.onelap.cn` 私有接口；上传仅接受 FIT |
| **MyWhoosh** | ❌ 无公开上传 API | ✅ | ❌ | 账号密码 → AccessToken | 逆向 `service14.mywhoosh.com`；社区有 `mywhoosh-community/mywhoosh-api` 可参考 |
| **Strava** | ✅ 官方 API | ✅ | ✅ | OAuth2 | 2026 政策收紧，见 §4 |
| **Intervals.icu** | ✅ 官方开放 API | ✅ | ✅ | OAuth2 / API Key | 支持 `external_id` 幂等去重，最规范 |
| **iGPSPORT** | ✅ 官方第三方上传 API | ✅ | ✅ | OAuth2 | 本地文件格式规范度较差 |
| **行者** | ✅ 官方开放 API | ✅ | ✅ | OAuth2 | 解析宽松，可作「清洗中转」 |
| **Outbase** | ❌ 聚合平台 | ❌ 仅上传 | ✅ | WebView | 兼容性最好，可作兜底目标 |
| **Garmin Connect** | ⚠️ 需合作资质 | ✅ | ✅ | OAuth2 + MFA | 参考项目用「FIT 设备伪装」绕过设备绑定 |
| **Wahoo** | ⚠️ 需 partner | ✅ | ✅ | OAuth2 | 每用户最多 10 枚 token |
| **COROS** | ✅ Open API | ✅ | ✅ | OAuth2 | OSS 直传 + `fit/import` |
| **Suunto Cloud** | ✅ 官方 API | ✅ | ✅ | OAuth2 / AppKey | 规范度高 |
| **Komoot** | ❌ 内部 API | ✅ | ✅ | WebView | |
| **黑鸟单车** | ⚠️ 官方上传通道 | ✅ | ✅ | 账号密码 | 仅接受 FIT，解析严格 |
| **Keep / 咕咚 / Zepp / Zwift / TwoBulu** | ❌ | 部分 ✅ | ❌ | WebView | 无上传 API，只能作下载源 |

### 3.2 关键生态变化

- **迈金官方已下线其直连 Strava 的通道**（2026-03 起逐步停止）→ 用户被迫寻找第三方同步工具，**本项目需求真实存在且在增长**
- **迈金/顽鹿无第三方开放 API** → 必须逆向，且需长期跟随其 Web 端改版
- **MyWhoosh 社区有自建 API 项目**（`mywhoosh-community/mywhoosh-api`）→ 可交叉验证接口
- **官方开放 API 最靠谱的三家**：Intervals.icu、Suunto Cloud、COROS → 建议作为「高可靠目标」优先接

### 3.3 已逆向出的关键接口细节（可直接落地）

#### 迈金 / 顽鹿 OTM

Base：`https://otm.onelap.cn`

| 用途 | 方法 | 路径 | 关键点 |
|------|------|------|--------|
| 登录 | POST | `/api/login` | body `{account, password: MD5(password)}`；响应 `data[0].token`(JWT) + `refresh_token` |
| 刷新 token | POST | `/api/token` | body `{token, from:"web", to:"web"}` |
| 活动列表 | POST | `/api/otm/ride_record/list` | body `{page, limit}`；header `Authorization: <token>`；分页 `data.pagination.has_more` |
| 活动详情 | GET | `/api/otm/ride_record/analysis/{id}` | `data.ridingRecord.durl`（七牛直链，WGS-84）或 `.fitUrl`（GCJ-02） |
| FIT 内容 | GET | `/api/otm/ride_record/analysis/fit_content/{base64(fitUrl)}` | |
| **上传** | POST | `/api/otm/ride_record/upload/fit` | multipart 字段名必须是 **`jilu0`**（网页 JS 是 `jilu`，程序化上传需 `jilu0`）；需 `Authorization` + `Origin`/`Referer`；成功条件 `code==200 && data.success_count>=1`；**异步入库约 15–20s** |

注意：上传仅接受 **FIT**。GPX 必须先转 FIT，且需要完整的 `file_id / session / lap / activity / record` 消息流
（官方 `gpx2fit.js` 不够）。

#### MyWhoosh

| 用途 | 方法 | URL | 关键点 |
|------|------|-----|--------|
| 登录 | POST | `https://services.mywhoosh.com/http-service/api/login` | body `{Username, Password, Platform:"Android", Action:1001, CorrelationId, DeviceId, Authorization:""}` → `Success/AccessToken/WhooshId/RefreshToken` |
| 活动列表 | POST | `https://service14.mywhoosh.com/v2/rider/profile/activities` | Bearer；body `{page, limit:50, sortDate:"DESC"}` |
| 下载文件 | POST | `https://service14.mywhoosh.com/v2/rider/profile/activities/download-activity-file` | body `{key:WhooshId, fileId:activityFileId}` → S3 预签名 URL → GET |

#### Strava

| 用途 | 方法 | URL | 关键点 |
|------|------|-----|--------|
| 授权 | GET | `https://www.strava.com/oauth/authorize` | scope `activity:read_all,activity:write`；redirect_uri 必须与注册时一致 |
| Token | POST | `https://www.strava.com/oauth/token` | `grant_type=authorization_code`，client_id/secret |
| 活动列表 | GET | `https://www.strava.com/api/v3/athlete/activities` | `per_page=200&page=N` |
| 上传 | POST | `https://www.strava.com/api/v3/uploads` | multipart：`data_type`(fit/gpx/tcx) + `name` + `file` |
| Webhook 订阅 | POST | `https://www.strava.com/api/v3/push_subscriptions` | **每个 app 只能有一个订阅**；回调 `hub.challenge` + `hub.verify_token` 验证 |

---

## 四、2026 平台政策约束（影响架构的关键项）

### 4.1 Strava 开发者计划调整（2026-06-01 公布，2026-09-01 生效）

| 变化 | 影响 |
|------|------|
| 创建 API 应用需要**有效的 Strava 订阅** | 新用户接入 Strava 目标前必须已有订阅账号；自托管场景需每人配置自己的 client_id/secret |
| 标准层默认 **1 个 athlete**，可自助升级到 10（>10 需审核） | 单实例多用户共享一个 Strava app 会受限 → **凭证必须按用户独立存储** |
| 限流：整体 200 req/15min + 2000/day；非上传端点 100/15min + 1000/day | 需要令牌桶限流 + 队列调度，200/day 对大规模同步是硬约束 |
| **API 政策 5.16：禁止路由/中转 Strava 数据**（pass-through / intermediary / aggregator） | ⚠️ **对「以 Strava 为源的同步工具」是实质性合规风险** → 必须做法律边界声明，且默认把 Strava 仅作为「目标」，源仅在用户自有账号闭环内使用 |
| **API 政策 5.3：禁止把 API 数据喂给 AI/LLM context window**（仅允许通过 Strava 官方 MCP） | ⚠️ Web 控制台的「AI 分析/摘要」功能**不能**消费 Strava 活动数据 → 需按数据来源做能力门控 |
| 缓存上限 7 天 | 中间缓存层需按来源做 TTL 策略，Strava 数据不得长期落库 |
| 删除请求 48 小时内必须传播 | 需要「删除同步」通道（用户删 Strava 活动后，本地也删） |
| 2027-01-04 起新 base URL `https://api-v3.strava.com`；2027-06-01 起 token 只走 header，`/oauth/deauthorize` 退役改 `/oauth/revoke` | 需把 base URL / 认证方式做成配置项，提前适配 |

### 4.2 其他平台

- **Wahoo**：每用户最多 10 枚未撤销 OAuth token → 需 token 复用策略
- **Garmin Connect**：需要合作资质才能拿到生产 API；MFA 无法自动化 → 建议第一版不做
- **迈金/顽鹿**：无公开 API，接口变更无通知 → 必须有「接口健康探针」和降级告警

### 4.3 合规红线（产品设计层面）

1. **凭证不出服务端**：浏览器永远拿不到 access_token / refresh_token / 账号密码
2. **不做数据中转商**：本工具定位为「用户对自己数据的个人同步」，不做 A 用户的数据流向 B 用户的场景
3. **不把运动数据喂给大模型**（至少 Strava 来源强制拦截）
4. **频率自律**：全局限流 + 每平台独立配额，宁可慢也不要触发风控导致用户账号受损
5. **明示免责**：连接平台时弹出「该平台使用非官方接口，可能违反其条款」的确认

---

## 五、形态选型

| 形态 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **A. 纯本地桌面 Agent + 本地 Web UI** | 凭证不出本机；无合规风险 | 用户必须开机；无人值守差；跨设备同步难 | ❌ 备选 |
| **B. 纯前端 Web（浏览器直连平台）** | 无服务端、部署最简单 | CORS 基本全灭；token 存浏览器风险高；无法定时任务 | ❌ 不可行 |
| **C. 自托管 Web 服务（Docker Compose）** | 凭证在用户自己的服务器；可定时任务；数据自控；用户量少时合规压力小 | 需要用户有服务器或 NAS | ✅ **主推** |
| **D. 多租户 SaaS** | 开箱即用 | 平台条款下多租户风险显著（5.16 中转条款）；需处理用户数据隔离 | ⚠️ 后续可选，默认关闭跨用户共享 |

**选型结论：以 C 为主推形态，代码结构预留 D（多租户隔离从第一天就做，`user_id` 全链路贯穿）。**

形态 C 的部署形态：

```
docker compose up -d
  ├── fitbridge-server   (API + 同步引擎 + Webhook)
  ├── fitbridge-web      (静态前端，可选合并进 server)
  ├── fitbridge-postgres (数据 + 凭证密文)
  ├── fitbridge-redis    (队列 + 限流 + 缓存)
  └── fitbridge-worker   (同步执行 + WebView 兜底浏览器)
```

---

## 六、调研结论汇总

1. **技术可行**：参考项目已验证 20+ 平台的接口协议，核心难点（FIT 解析、GCJ-02、时区、上传字段）都有成熟解法可借鉴
2. **形态明确**：**自托管 Web 服务**，参考项目是 Android App，其 UI 层不可复用，但 API 层高度可复用
3. **平台现实**：只有少数平台有官方 API；国内主力平台全是逆向 → 必须建设「适配器健康度监控 + 快速降级」能力
4. **合规重点**：Strava 2026 政策是最大变量（订阅门槛 + 5.16 中转禁令 + 5.3 AI 禁令），方案必须显式规避
5. **差异化机会**：参考项目只做「设备本地同步」，没有服务端、没有多用户、没有编排、没有可观测性 —— 这正是 FitBridge 的价值

