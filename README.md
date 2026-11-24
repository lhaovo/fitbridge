# FitBridge

> 多平台运动数据同步工具 + Web 控制台
>
> 让运动数据自由流动：迈金 / 顽鹿 OTM、MyWhoosh、Strava 等平台之间的 FIT / GPX 运动记录同步、增量同步与编排。

FitBridge 是一个**自托管优先**的多平台运动数据同步服务。它把各运动平台的私有/官方接口收敛到统一的
适配器（Adapter）之下，提供：

- **平台连接**：账号登录 / OAuth 授权，凭证加密存储在服务端，永不下发浏览器
- **同步编排**：N 个来源 × M 个目标的任务模型，支持增量、去重、幂等、限流退避、失败重试
- **数据规范化**：统一中间模型（Activity + FIT/GPX 文件），处理时区与坐标系（GCJ-02 → WGS-84）
- **Web 控制台**：仪表盘、账号管理、任务编排、活动浏览、运行日志、Webhook 事件流

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/01-research.md](docs/01-research.md) | 调研报告：参考项目逆向分析、平台生态现状、2026 平台政策约束 |
| [docs/02-architecture.md](docs/02-architecture.md) | 总体架构、模块划分、关键技术选型与取舍 |
| [docs/03-adapters.md](docs/03-adapters.md) | 平台适配器接口契约 + 首批平台接口规格（迈金 / MyWhoosh / Strava） |
| [docs/04-data-model-api.md](docs/04-data-model-api.md) | 数据模型、数据库设计、REST API、任务编排语义 |
| [docs/05-roadmap-risks.md](docs/05-roadmap-risks.md) | 里程碑路线图、风险登记表、待决策问题 |
| [docs/06-decisions.md](docs/06-decisions.md) | **最终决策记录 + 本地存储策略 + M0 范围（优先级最高）** |
| [docs/07-m0-progress.md](docs/07-m0-progress.md) | M0 进度、实测结论、本地开发指南 |
| [docs/08-activity-detail.md](docs/08-activity-detail.md) | **活动详情页**：轨迹图 / 指标曲线 / 跨平台叠加对比 + 这一轮挖出的真实数据 bug |

## 状态

**M0 编码阶段**。方案已定稿，见 [决策记录](docs/06-decisions.md)；进度见 [M0 进度](docs/07-m0-progress.md)。

已锁定的决策：单用户设计 / 纯自托管单体 / 首批平台 = 迈金·OTM + MyWhoosh /
FIT 路线用 `fit-file-parser` 走简单实现 / 参考项目只复用可复用逻辑 /
**SQLite + 本地文件，不用 Postgres / Redis / MinIO / Docker**。

```
M0  骨架 + fitkit(只读解析) + 迈金OTM + MyWhoosh + 本地统一运动库
    → M1  增量游标 / 去重 / FIT 修复 / GPX→FIT 构建 / 可视化
      → M2  Strava·Intervals.icu 等官方平台 + Webhook + Web 兜底
        → M3  更多平台 + 插件化开放
```

**M0 的验收场景**：在 Web 控制台里连接迈金与 MyWhoosh，把两个平台的运动记录汇成一个统一运动库，
并完成一次 **MyWhoosh → 迈金/OTM** 的真实上传同步。

### 当前已跑通

| 能力 | 状态 |
|------|------|
| FIT 只读解析（时间/距离/轨迹/心率/功率/踏频/时区） | OK 14 单测 |
| GCJ-02 <-> WGS-84 转换（迭代反算，cm 级精度） | OK |
| 迈金 OTM 适配器（登录/列表/详情/下载/上传 `jilu0`） | OK 8 回归测试（待真实账号验证） |
| MyWhoosh 适配器（登录/列表/下载） | OK 5 回归测试（待真实账号验证） |
| Postgres schema（11 表）+ 迁移器 | OK 实测通过 |
| 单用户认证 + 凭证信封加密（AES-256-GCM） | OK 实测通过，48/48 测试绿 |
| SQLite（Node 内置 node:sqlite）+ 本地 blob 存储 | OK 实测通过 |
| Web 控制台 v2（同步 / 活动库 / 本地库状态 / 平台矩阵 / 事件流） | OK 已可访问 |
| 同步引擎编排（活动库填充） | OK 真实账号跑通：迈金 33 + MyWhoosh 7 条，零失败 |
| **活动详情页**（轨迹图 / 指标曲线 / 跨平台叠加对比） | OK |

## 快速启动

```bash
pnpm install
pnpm build
pnpm start          # → http://127.0.0.1:8080
```

首次启动会自动：生成 `data/` 目录、创建 SQLite 库并跑迁移、生成管理员密码并打印到日志
（若未设置 `FITBRIDGE_PASSWORD`）。重置密码：`pnpm run reset-password`。

**整个 FitBridge 的状态 = `data/` 目录**，备份它即可：`./scripts/backup.sh`。

## 参考项目

本项目的平台接口协议大量借鉴了社区项目
[Anathleticbicyclist/sports-data-sync-multiplatform](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform)（MIT），
该参考项目是一个 **Android App**，其 API 适配层是本项目的主要信息来源。详见
[调研报告](docs/01-research.md#二参考项目逆向分析)。

**复用原则（决策 D1）**：只复用**可复用的逻辑**——平台接口协议细节、GCJ-02 转换算法、CRC 算法、
去重键设计、OAuth2 模板思路。**不复用**其 Android UI / WebView / WorkManager / SharedPreferences /
硬编码时区档位。参考项目代码仅作**算法与协议参考**，不 fork、不逐行移植。

## 免责声明

FitBridge 为个人数据迁移/备份工具。部分平台（迈金/顽鹿 OTM、MyWhoosh、Outbase 等）**未提供面向第三方的
公开 API**，本项目通过分析其官方 Web/App 客户端的接口协议进行适配。

- 使用前请自行确认是否违反目标平台的服务条款与当地法律法规
- 项目作者不对账号风控、数据丢失、平台接口变更导致的不可用承担责任
- 请遵守各平台的请求频率限制，避免触发风控

## License

MIT
