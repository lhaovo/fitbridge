# M0 进度与开发指南

> 更新：2026-11-13

---

## 一、当前完成度

| M0 条目 | 状态 | 说明 |
|---------|------|------|
| 0.1 Monorepo + 单体运行 | ✅ | pnpm workspace；**SQLite + 本地文件，无外部服务**（决策 D6） |
| 0.2 `packages/fitkit` 只读解析 | ✅ | 基于 fit-file-parser；14 个单测覆盖 |
| 0.3 `packages/core` 契约 + 领域模型 | ✅ | PlatformAdapter / PlatformManifest / Activity / StoragePolicy / 流水线 |
| 0.4 SQLite schema + 迁移 | ✅ | 11 张表 + 迁移器（启动自动跑，已实测） |
| 0.5 服务端骨架 + 单用户认证 + 凭证加密 | ✅ | 已实测；**含稳定 DeviceId + 加密存密码 + 自动重登** |
| 0.5b **风控防护** | ✅ | 失败分类 + 账号级冷却 + 登录节流 + 绝不自动重试（21 个单测） |
| 0.6 Adapter `otm` | ⚠️ 离线验证 | 协议实现完成 + 8 个回归测试（未用真实账号验证） |
| 0.7 Adapter `mywhoosh` | ⚠️ 离线验证 | 协议实现完成 + 5 个回归测试（未用真实账号验证） |
| 0.8 同步引擎 | ⬜ | Pipeline 的 Discover/Fetch/Normalize 已就位，**编排与落库未接** |
| 0.9 Web 控制台 | ✅ v1 | 登录 / 平台能力矩阵 / 连接账号 / 已连接列表（已截图验证） |
| 0.10 导出 + 备份 + 部署文档 | ⚠️ 部分 | backup/restore 已适配 SQLite；「导出全部」功能未做 |

**下一步（按风险从高到低）**：

1. **用真实账号验证两个适配器**（最高风险：逆向接口细节可能已变）
2. 同步引擎落地：发现 → 下载 → 落库（activity + activity_files）→ 去重账本
3. 文件保留期清理任务（L2 90 天 / L3 7 天）
4. Web 控制台 v2：活动库列表/详情 + 轨迹图
5. MyWhoosh → 迈金 的真实上传闭环

---

## 二、已验证的事实（实测结论）

这几条是动手过程中确认的，写下来避免以后重复踩：

| 结论 | 依据 |
|------|------|
| `fit-file-parser` v6.2.7 可直接用 | 解析 + 编码 + CRC 校验齐全，MIT，2026-10 仍在更新 |
| FIT 坐标以**半圆**为单位存储 | 1 度 = 2^31/180 个半圆；解码用 `raw * scConst` |
| FIT 头布局 | byte0=头长度(12/14)，byte1=协议版本(0x10/0x20)，bytes4-7=data size，**bytes8-11=".FIT"** |
| `local_timestamp` 与 `timestamp` 同一 epoch 解码 | 因此两者差值就是平台时区偏移（分钟） |
| `FitEncoder` 自带 CRC 与 FIT 时间戳转换 | 不用手写 FIT 二进制，M1 的 GPX→FIT 直接复用 |
| MyWhoosh 距离字段单位是**公里** | 参考项目 `distanceKm` → 需 ×1000 |
| 迈金上传字段名是 `jilu0` | 官方网页 JS 用 `jilu`，程序化上传必须 `jilu0`（已写进回归测试） |
| MyWhoosh 响应容器有 6 种形态 | `data.results` / `data[]` / `activities` / `results` / `rides` / `rideHistory` |
| 本环境 npm 官方源 tarball 不可达 | 已配置 `.npmrc` 走 npmmirror 镜像 |
| 参考项目实测：**WebView 点按钮比 API 直连更易触发风控** | 参考项目自己的注释：优先 OAuth1 直连「绕开 WebView 按钮风控」 |
| 参考项目实测：**密码输错一次即可能触发风控**，冷却期数小时~一天 | 已实现失败分类 + 账号级冷却 + 绝不自动重试 |
| `node:sqlite` 需要 Node >= 22.5 | 已在 `engines` 声明；且部分打包器不认识它是内置模块 → `db.ts` 用 `createRequire` 动态加载 |
| GitHub SSH 22 端口被环境代理阻断 | 改走 `ssh.github.com:443`；主机密钥指纹与官方一致 |

---

## 三、本地开发

```bash
# 1. 安装依赖
pnpm install

# 2. 构建
pnpm build

# 3. 测试
pnpm test

# 4. 启动（无外部依赖，单进程）
FITBRIDGE_PASSWORD=devpass pnpm start
```

访问 `http://127.0.0.1:8080`。
数据全在 `./data`（SQLite + blobs + master.key）；迁移在启动时自动执行。

首次启动若未设置 `FITBRIDGE_PASSWORD`，会生成随机管理员密码并打印到日志（仅一次）。
重置：`node apps/server/dist/cli/reset-password.js`。

---

## 四、目录结构（当前）

```
fitbridge/
├─ packages/
│  ├─ fitkit/          FIT 只读解析 + GCJ-02 转换 + 运动类型映射
│  │   └─ src/{read,geo,sport,build,repair,types}.ts
│  ├─ core/            领域模型 + 平台契约 + 流水线 + HTTP 工具 + FileStore 接口
│  │   └─ src/{domain,ports,engine,lib}/
│  └─ adapters/
│     ├─ otm/           迈金 / 顽鹿 OTM
│     └─ mywhoosh/      MyWhoosh（仅下载源）
├─ apps/
│  └─ server/          Fastify API + Web 控制台
│     ├─ src/{app,config,index,migrate}.ts
│     ├─ src/lib/{crypto,db,platforms,file-store,bootstrap,constants}.ts
│     ├─ src/cli/reset-password.ts
│     ├─ public/        Web 控制台（原生 HTML/CSS/JS，无外部依赖）
│     └─ migrations/001_init.sql
├─ deploy/Dockerfile      可选，后续生产部署用
├─ docker-compose.yml     可选，后续生产部署用
├─ scripts/{start,backup,restore}.sh
└─ docs/
```

---

## 五、已实现的关键接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 db / fileStore / platform 数量） |
| GET | `/api/v1/platforms` | **平台能力矩阵**（公开，UI 直接渲染这份数据） |
| GET | `/api/v1/platforms/:id` | 单平台详情 |
| GET | `/api/v1/auth/bootstrap-state` | 初始化状态 |
| POST | `/api/v1/auth/login` | 单用户登录（Cookie 会话） |
| POST | `/api/v1/auth/logout` | 登出 |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET | `/api/v1/connections` | 已连接平台（**永不含凭证内容**） |
| POST | `/api/v1/connections/:platformId` | 连接平台账号（账号密码 → 加密落库） |
| DELETE | `/api/v1/connections/:id` | 删除凭证 |
| POST | `/api/v1/connections/:id/validate` | 校验凭证有效性 |
| POST | `/api/v1/connections/:id/relogin` | 用保存的账号密码换新 token（token 过期后自动恢复） |
| GET | `/api/v1/risk-guard` | 风控/冷却状态 |
| POST | `/api/v1/risk-guard/clear` | 手动解除冷却（需 confirm=true） |
| GET | `/` | **Web 控制台**（登录 / 平台矩阵 / 连接账号） |

---

## 六、尚未实现（明确列入待办）

- [ ] 同步引擎编排 + 落库 + 去重账本（含 AUTH_EXPIRED → 自动重登 → 重试）
- [ ] 文件保留期清理任务（L2 90 天 / L3 7 天）
- [ ] 任务调度（进程内队列 → 需要时再上 BullMQ）
- [ ] Web 控制台 v2：活动库 / 轨迹图 / 对比
- [ ] GPX→FIT 构建（M1，`fitkit/src/build.ts`）
- [ ] FIT 合规修复（M1，`fitkit/src/repair.ts`）
- [ ] 限流 / 退避 / 熔断（Policy 层）
- [ ] SSE 实时事件流
- [ ] 「导出全部」ZIP
