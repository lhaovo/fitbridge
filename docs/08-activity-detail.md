# 活动详情页（M0.11）

> 实现日期：2026-11-24 · 相关代码：`apps/server/src/lib/activity-detail.ts`、`apps/server/public/detail.js`

---

## 一、为什么把轨迹「现场解析」而不是落库

轨迹点不入库，只在打开详情页时**现场解析 FIT blob**：

| 方案 | 取舍 |
|---|---|
| 落库轨迹点 | 多一份数据要跟保留期/清理逻辑对齐；SQLite 里塞几万点行会让库膨胀 10 倍 |
| 现场解析 | 单文件 FIT 解析约 10–50ms，够快；blob 本来就在本地磁盘，没有额外 I/O 成本 |

代价是每次打开详情页都要重新解析 —— 对单用户自托管场景完全可以接受。

---

## 二、后端

### 2.1 `GET /api/v1/activities/:id/track`

```
?coord=wgs84   （默认）GCJ-02 文件转成 WGS-84 后返回
?coord=none    保留文件里的原始坐标
```

返回结构：

```ts
{
  activityId, hasFit, coordinateSystem, convertedTo,
  pointCount,        // FIT 里的真实点数
  sampled,           // 是否被抽样
  track:  [{ t, lat, lon, alt?, speed?, hr?, power?, cadence? }],
  series: [{ key, label, unit, points:[{t,v}], min, max, avg }],
  summary: { distanceMeters, durationSec, avgSpeedMps, maxSpeedMps,
             avgHeartRate, maxHeartRate, avgPower, maxPower,
             avgCadence, elevationGainM, startTime, endTime, sportType },
  warnings: []
}
```

- 轨迹点上限 **1200**（超出按等间隔抽样，保留首尾点）
- 解析时 `maxTrackPoints: 0`（**不截断**）—— 同步时用 5000 点上限省内存，
  但详情页要看到完整轨迹（否则图表 x 轴和骑行时长对不上）

### 2.2 `GET /api/v1/activities/:id/related`

跨平台关联：开始时间差 ≤ 5 分钟 **且** 距离差 ≤ 2%，即同一条骑行在别的平台上的副本。
返回里带该活动的**文件坐标系**，前端据此决定叠加时是否需要转换。

---

## 三、前端（`public/detail.js`）

没有引图表库，轨迹图与指标图都是手写 SVG：

- **轨迹投影**：等距圆柱 + 按纬度 `cos` 修正，x/y 用**同一个 scale**（等比例），
  这样叠加对比时形状不会被拉伸
- **指标图**：`min/max` 归一化到 viewBox，网格线 + 右侧数值标签 + 底部时间轴
- **叠加对比**：点「叠加对比」会拉取另一平台活动的轨迹叠上去（橙色虚线），
  并按**同一秒的点配对**算出平均偏移（米）
  → 这是验证 GCJ-02 转换是否正确的直接证据

### 坐标系归一的必要性

实测数据里同一条骑行：

| 平台 | 文件坐标系 | 说明 |
|---|---|---|
| 迈金 OTM | `gcj02` | `fit_content` 通道是 GCJ-02（七牛直链 `durl` 才是 WGS-84） |
| MyWhoosh | `wgs84` | 原生 WGS-84 |

两条轨迹直接叠加会差出 **~500m**。所以详情页默认把 GCJ-02 转成 WGS-84 再显示，
并在徽章上标明「文件坐标系 / 显示已转」。

---

## 四、这一轮从真实数据里挖出来的 4 个 bug

都是「页面做出来之后一眼看出不对」暴露的，全部已修并补了回归测试：

### 4.1 FIT 里的 `avg_speed` 字段不可信（影响所有平均速度）

实测 20 个真实 FIT 文件，`avg_speed` 与「距离 / 移动时间」对比：

| 文件 | 文件里的 avg_speed | 真实值（距离/移动时间） | 结论 |
|---|---|---|---|
| 15 个 | 一致（误差 <0.1%） | — | 正常 |
| 2 个 | `0` | 6.188 / 3.212 m/s | **字段是 0** |
| 1 个 | `0.534` | 3.956 m/s | **明显偏小** |
| 其余 | 与「距离/总时长」一致但与「距离/移动时间」不同 | — | 语义是移动平均速度（正确） |

修法（`packages/fitkit/src/read.ts`）：**一律自己算** `total_distance / total_timer_time`，
文件里的值只做兜底；两者差 >2% 就写一条 warning 留痕。

> 迈金详情里的 `avgSpeed`（1.92）也不能用 —— 它既不是 m/s 也不是 km/h 的正确值，
> 所以适配器层不读它，平均速度一律来自 FIT。

### 4.2 「全量重拉」没有绕过增量窗口

`forceResync` 只影响「这一条活动要不要重下」，**列表接口仍然带着 `since`**，
结果点「全量重拉」会发现 0 条活动（实测：迈金 33 条 → discovered 0）。

修法：`policy.forceResync` 时连 `since` 都不算，直接拉全量历史。
修完实测：迈金 33 条、MyWhoosh 7 条，零失败。

### 4.3 迈金详情的开始时间字段名和列表不一样

| 来源 | 字段 | 形态 |
|---|---|---|
| 列表 | `start_riding_time` | `"2026-11-21 13:03:35"`（本地墙钟，无时区） |
| 详情 | `startRidingTime` | `1795237415000`（unix 毫秒） |

原来只认 `start_riding_time` → 详情里的本地时间拿不到，`timezone_offset_min` 一直是 0。

修法：统一 `parseOtmStart()` 同时兼容两种形态，并输出「绝对时刻 + 当地墙钟(+08:00)」。
现在库里：`start_time=2026-11-21T05:03:35.000Z`、`local_start_time=2026-11-21T13:03:35+08:00`、
`timezone_offset_min=480`、`timezone_source=platform`。

### 4.4 网络错误只会显示 "fetch failed"

undici 的报错完全没有信息量。加了 `enrichNetworkError()` 把它翻成可读信息：

```
连接被重置（service14.mywhoosh.com）：Client network socket disconnected before secure TLS connection was established
连接超时（api.example.com）：… —— 出口网络不通或被代理拦截
域名解析失败（api.example.com）：… —— 检查 DNS / 代理配置
```

并且引擎对**网络类错误做退避重试**（1.5s / 4s / 8s，整轮共享 12 次预算），
`RATE_LIMITED` 仍然绝不自动重试（风控语义）。

---

## 五、踩过的另一个坑：改完代码但服务还在跑旧版本

重启脚本原来只 `kill $(cat pid 文件)`。旧进程没退干净时，新进程绑不上 8080 会**直接退出**，
于是「改了代码但行为没变」，白排查半天。

`scripts/restart-dev.sh` 现在做三件事：
按 PID 杀 → 按端口兜底杀 → 用 HTTP 探测就绪（不用 `ss`，端口刚 bind 时它可能还没刷新）。

> 同理，`pkill -f "node .../index.js"` 会误伤命令行里带同样字符串的父 shell，
> 所以脚本改成按端口反查真正占着端口的 pid。

---

## 六、MyWhoosh API 域名的可用性（环境问题，非代码问题）

MyWhoosh 的 v2 API 走 `service14.mywhoosh.com`（`Bearer` 鉴权）。
这个域名在当前网络环境下**时通时不通**（同一分钟内可从 200 变成 TCP 超时），
DNS 解析到 `198.18.x.x`（透明代理的 fake-ip 段）。

`services.mywhoosh.com` 虽然稳定，但它前面的网关要求 **AWS SigV4 风格**的
`Authorization: key=value,...` 签名，不是 `Bearer`，所以**不能直接当备用域名**。

结论：这是出口网络/代理的问题，不是代码问题。现在的行为是
「重试 3 次 → 报出可读的网络错误 → 本轮跳过该平台，其余平台照常同步」。
