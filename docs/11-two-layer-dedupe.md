# 11 · 下载去重 与 上传去重 分层

> 问题：选「同时上传到目标平台」时，只要本地库已有该活动，就会被判成重复直接跳过，
> 于是**一条也传不出去**。必须先勾「全量重拉」把文件全下一遍才能传。

---

## 1. 根因

原来只有**一层**去重，且被用在了两个不同的地方：

```
Discover(源平台) ──► [去重: 本地库有没有?] ──► Fetch(下载) ──► Upsert(本地库)
                                                                    │
                                                         Upload(目标平台) ◄┘
```

去重发生在 **Fetch 之前**，命中就 `continue`。而上传阶段的候选集
`processed` 只装「本轮真正下载过的活动」—— 于是：

| 场景 | 本地库 | 结果 |
|---|---|---|
| 第一次同步 + 上传 | 空 | 下载 40 条 → 上传 40 条 ✅ |
| 第二次同步 + 上传（不勾全量重拉） | 有 40 条 | 全部判重跳过 → `processed` 为空 → **上传 0 条** ❌ |

**「本地库有没有」和「目标平台有没有」是两个不同的问题**，被混成了一件事。

---

## 2. 改法

```
Discover(源平台) ──► [下载层去重: 本地库有没有?] ──┬─► 有 → 跳过下载，但仍进上传候选集
                                                  └─► 无 → 下载 → Upsert → 进上传候选集
                                                                            │
              上传候选集 = 本地库(来源平台 ∈ 本次选择) + 本轮新下载 ◄──────────┘
                                                                            │
                              Upload(目标平台) ◄── [上传层去重: 目标平台有没有?] ──┘
```

### 下载层（源平台 → 本地库）
- 幂等键不变：`用户 + 平台 + 活动ID`（数据库 UNIQUE 约束强制）
- 命中 → **不重复下载**（省流量、省风控额度）
- 但**不再把它踢出上传候选集**

### 上传层（本地库 → 目标平台）
判重依据换成「**目标平台自己有没有这条活动**」，两层：

1. **本地同步记录**：`activity.syncedTargets` 含该目标 → 跳过（精确）
2. **目标平台列表软匹配**：拉一次目标平台活动列表，按
   `开始时间 ±10 分钟` + `距离 max(2%, 100m)` 匹配 → 跳过（覆盖「用户手动在 App 里传过」）

软匹配缺时间时**一律判为「不是同一条」** —— 宁可重复上传（用户可删），也不要漏传。

### 候选集怎么来的
- 本轮新下载的活动（blobKey = 刚下载的文件）
- 本地库里 `sourcePlatform ∈ 本次选择的来源平台` 的活动（blobKey = 已有文件）

> ★ 这条是关键：本地库已有的活动也进候选集，上传阶段按目标侧判重。

### 条数上限的位置
上限（`maxItemsPerRun`）在**判重之后**才截断。
否则「已被目标判定为重复」和「已同步过」的老活动会一直占着名额，
真正没传过的新活动反而永远轮不到（每轮都在同一批里打转）。
判重在前 → 每轮往前推进一批 ✓

---

## 3. 实测（真实数据，2026-11-25）

本地库 41 条（MyWhoosh 8 + 迈金 33），其中 MyWhoosh 与迈金有**同一趟骑行**
（开始时间、距离完全一致），正好用来验软判重。

| 运行 | 结果 |
|---|---|
| 预览（dryRun） | 跳过上传 6（迈金已有）· 计划上传 2 |
| 真实执行 | **上传 2** · 跳过上传 6 · 失败 0 |
| 再执行一次 | 上传 0 · 跳过上传 8 · 失败 0 ← 幂等 ✅ |

跳过的 6 条就是「迈金已经有了」的那几条 —— 说明软判重真的在工作，
而不是把「本地已有」和「目标已有」混为一谈。

### 遗留：迈金侧入库（已定位到平台侧，且已加「回查确认」兜底）

上传接口返回 `{"code":200,"success_count":1,"failed_files":[]}`（已受理），
但迈金活动列表 `pagination.total` 始终是 33，新传的那 2 条不出现。

排查过程（都是实测）：

| 实验 | 文件 | 结果 |
|---|---|---|
| ① 原样上传 MyWhoosh 的 FIT | `be1f4ed5`（1 个 lap、`sub_sport=virtual_activity`） | 接口 200 / success_count=1，**列表无** |
| ② 重建后上传（5km 一个 lap + device_info + sport 消息 + generic sub_sport） | 同一条活动 | 接口 200 / success_count=1，**列表无** |
| ③ 上传 fitkit 生成的**合成 FIT**（最标准的 file_id→session→lap→activity→record，CRC 正确） | `/tmp/synth.fit` | 接口 200 / success_count=1，**列表无** |
| ④ 换字段名 `jilu`（网页端那个） | 同上 | **422「没有上传文件」**（与参考项目记载一致） |
| ⑤ 用上传返回的 `file_key` 反查 `analysis/fit_content/{base64(key)}` | 两次上传的 key | **HTTP 500** → 迈金侧根本没生成骑行记录 |

结论：**不是文件格式问题**。③说明连最标准的 FIT 都不入库，⑤说明迈金后台根本没建记录。
参考项目（成熟 Android 应用）也把 MyWhoosh 列为「仅作下载数据源」，
并在 README 里记录了同类现象：「上传成功但列表无数据」。

### 应对：上传后回查确认入库（已实现）

既然平台会「假成功」，就不能信接口的返回值：

```
上传成功（接口层）
   ↓
回查目标平台列表（轮询到 verifyTimeoutSec，默认 90s）
   ├─ 出现了  → markSynced，算「上传成功」
   └─ 没出现  → 记为「上传失败：未确认入库」，不写 sync_items
                 → 下一轮还能重传
```

实测（MyWhoosh → 迈金，verifyTimeoutSec=40）：

```
下载 0 · 跳过下载 1 · 上传 0 · 跳过上传 6 · 上传失败 2
  ! otm/5ecd8712…: 上传未确认入库：上传接口已受理，但等待 40 秒后目标平台列表里
     仍没有这条活动 —— 该平台会静默丢弃这类文件（迈金实测如此），可稍后重试或换个目标平台
```

DB 里这两条**没有**被标成已同步（`sync_items` 为空）→ 下一轮会重传 ✓
关掉开关（`verifyUpload: false`）则退回「接口返回即算成功」的旧行为。

### FIT 重建器（顺带做了）

`packages/fitkit/src/rebuild.ts` —— 把任意来源的 FIT 改写成标准结构：

- 每个 lap 切 5km（与迈金原生文件一致），并写全 lap 汇总字段
- `sub_sport` 用 252（generic），不用 `virtual_activity`
- 补 `sport`(12)、`device_info`(23) 消息
- session 的 `avg_speed` 按「距离/移动时间」自算（源文件里这个字段经常是坏的）

往返无损验证：距离 34235.1m、心率 149、功率 105、开始时间全部一致，
CRC 校验通过。迈金上传前会自动判断「需不需要重建」再传。

---

## 3.1 相关代码

| 文件 | 内容 |
|---|---|
| `packages/fitkit/src/rebuild.ts` | FIT 重建器（5km lap / device_info / sport / generic sub_sport） |
| `packages/fitkit/src/read.ts` | `raw` 里补 `lap_count` / `sub_sport`，供 `needsRebuild()` 判断 |
| `packages/adapters/otm/src/upload.ts` | 迈金上传前自动重建不合规的 FIT |
| `packages/core/src/engine/sync-engine.ts` | `verifyUploaded()` 回查 + `uploaded` 暂存后再 markSynced |

## 4. 状态字段

`SyncRunSummary` / `PlatformStat` 新增：

| 字段 | 含义 |
|---|---|
| `skipped` | 下载阶段跳过（本地已有） |
| `uploadSkipped` | 上传阶段跳过（目标已有 / 已同步过） |
| `uploadPlanned` | 本轮计划上传（dryRun 时 = 预览条数） |
| `uploadDeferred` | 因条数上限本轮没轮到，下轮继续 |
| `verifyUpload`（policy） | 上传后是否回查确认入库，默认 true |
| `verifyTimeoutSec`（policy） | 回查等待上限，默认 90 秒 |

前端把两层拆开展示：「跳过下载（本地已有）」 vs 「跳过上传（目标已有）」。

---

## 5. 相关代码

| 文件 | 内容 |
|---|---|
| `packages/core/src/engine/sync-engine.ts` | `UploadCandidate`、`candidateFromStored()`、`isSameActivity()`、上传阶段判重、上限后置 |
| `packages/core/test/sync-engine.test.ts` | 11 个新用例（本地已有仍上传 / 已同步跳过 / 目标已有跳过 / forceResync / dryRun 预览 / 上限收敛 / 回查失败不假装成功 / 回查成功才标已同步 / 关掉回查 / isSameActivity 单测） |
| `apps/server/public/app.js` | 结果展示拆成「跳过下载 / 跳过上传 / 未轮到」 |
| `apps/server/public/index.html` | 面板说明改成「去重分两层，互不影响」 |
