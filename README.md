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

## 状态

当前处于 **M0 设计阶段**：调研与方案已完成，尚未开始编码。

```
M0 骨架 + 迈金/OTM + MyWhoosh + Strava 三平台打通
  → M1 任务编排 / 去重 / 日志 / Web 控制台
    → M2 Webhook 实时化 + 增量游标
      → M3 扩展平台（iGPSPORT / 行者 / Outbase / Garmin / Intervals.icu …）
```

## 参考项目

本项目的平台接口实现大量借鉴了社区项目
[Anathleticbicyclist/sports-data-sync-multiplatform](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform)（MIT），
该参考项目是一个 **Android App**，其 API 适配层是本项目的主要信息来源。详见
[调研报告](docs/01-research.md#二参考项目逆向分析)。

## 免责声明

FitBridge 为个人数据迁移/备份工具。部分平台（迈金/顽鹿 OTM、MyWhoosh、Outbase 等）**未提供面向第三方的
公开 API**，本项目通过分析其官方 Web/App 客户端的接口协议进行适配。

- 使用前请自行确认是否违反目标平台的服务条款与当地法律法规
- 项目作者不对账号风控、数据丢失、平台接口变更导致的不可用承担责任
- 请遵守各平台的请求频率限制，避免触发风控

## License

MIT
