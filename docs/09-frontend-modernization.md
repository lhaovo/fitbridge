# 前端现代化改造（modern-web-guidance）

> 日期：2026-11-24 · 工具：`modern-web-guidance` 插件（`legacy-scan` + `search` + `retrieve`）

---

## 一、怎么做的

1. **`legacy-scan`** 扫全量前端（`apps/server/public/`，4 个文件）
   → 3 条确定性发现（2 条 IME、1 条 `innerHTML = ''`）
   ⚠️ 该工具只覆盖目录约 20% 的指南（38 guides / 52 rules），
   所以下面的 P0-1 / P0-2 / P1 全靠 `search` 补齐，`legacy-scan` 看不到。
2. **9 次 `search`**，按本项目实际用到的模式检索：
   `modal dialog focus` / `data table accessibility` / `dark mode color scheme` /
   `form validation submit` / `safe text rendering xss` / `live region status announcement` /
   `server sent events stream` / `popover menu disclosure` / `date time timezone formatting`
3. **4 份指南 `retrieve`**：`dialog` / `responsive-table` / `security` / `ime-safe-enter-submit`
4. **5 轮 headless Chrome 实测**：不只读代码，所有结论都带运行时证据

---

## 二、改造清单

### P0-1　详情弹层改用原生 `<dialog>` ✅

| 项 | 改前 | 改后 |
|---|---|---|
| 元素 | `div.modal` + 手写遮罩 | `<dialog>` + `showModal()` |
| 焦点收敛 | **没有**（实测 Tab 从弹层直接跳到背景页的 `#logout`/`#fq`） | 浏览器自动（背景 inert，实测强行 `focus()` 背景按钮无效） |
| 可访问名 | `role=dialog` + `aria-modal=true`，但**没有 `aria-labelledby`** | `aria-labelledby="modal-title"` → 指向 `<h2>` |
| 初始焦点 | 落在 `BODY` | `autofocus` → `#modal-close` |
| Esc | 手写 keydown 监听 | 原生行为 |
| 关闭后焦点 | 丢失 | 自动回到触发按钮（实测：点遮罩 / Esc 都回到「详情」按钮） |
| 滚动锁 | `document.body.style.overflow='hidden'` | `dialog:modal{overscroll-behavior:contain}` + `dialog::backdrop{overflow:hidden}` |

> 指南原话：*"DON'T add role="dialog", aria-modal, a focus trap, inert toggling or an Esc handler."*
> 之前手写了其中一半、漏了另一半，比全都不写更糟。

### P0-2　表格加滚动容器 + 窄屏堆叠布局 ✅

**根因链（实测）**：表格 865px > 容器 348px → 文档 `scrollWidth` 902px →
移动端布局视口被撑到 902px → `position:fixed` 遮罩按 902px 算 → 弹层落在屏幕外。

改法：
- `.table-wrapper`：`overflow:auto` + `tabindex="0"` + `role="region"` + `aria-label`
  → 宽表在自己的容器里滚，不再把整页撑宽
- `container-type: inline-size` + `@container (width < 760px)`
  → 按**表格自身宽度**（不是视口宽度）切堆叠卡片布局
- 堆叠时 `thead` 移出布局与朗读，各列用 `::before` 注入标签

**实测结果**：390px 视口下 `文档宽 390 / 页面横向溢出 false`，表格自动变成带标签的卡片。

### P0-3　IME 安全的 Enter 提交 ✅

```js
// 改前：手绑 keydown，中文输入法选词按 Enter 会误触发
$('#pwd').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
el.onkeydown = (e) => { if (e.key === 'Enter') { readFilters(); loadActivities(); } };
```

改法**不是**加 `event.isComposing` 判断，而是**改用原生 `<form>`**：
登录和筛选都改成 `<form>` + `type="submit"` 按钮，浏览器自己处理隐式提交，
IME 选词不会误触发。指南的 `dropWhen` 明确把「原生 form 提交」列为不需要额外处理的情况。

### P0-4　输入框可访问名 ✅

16 个输入框 → **0 个**缺可访问名。
所有 `<label>` 补 `for`，input 补 `id`（平台连接表单用平台 id 派生唯一 id）。

### P1 ✅

| 项 | 改法 |
|---|---|
| `color-scheme` | `:root { color-scheme: dark }` + `<meta name="color-scheme">`（原生控件不再亮色） |
| 动态区域无 live region | `#sync-out` / `#ftotal` / `#events` 加 `role="status" aria-live="polite"`，错误用 `role="alert"` |
| 表格无 caption / scope | 4 张表全部补 `<caption>`（视觉隐藏）+ `<th scope="col">` |
| 轮询不看页面可见性 | `visibilitychange` → 隐藏时 `clearInterval`，回前台立即补一次再重启 |
| 标题层级混乱 | 单个 H1（视觉隐藏）+ 各 section 用 `<section aria-labelledby>` + H2，弹层内 H2/H3 |
| 原生 `confirm()` / `alert()` | 换成 `<dialog>` 确认框 + `role="status"` 的 toast（alert 会阻塞整个事件循环） |

### P2　安全加固 ✅

```
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: same-origin
permissions-policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
cross-origin-opener-policy: same-origin
content-security-policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'
```

⚠️ **故意没有上完整的 CSP `script-src`**：前端还有 20+ 处 innerHTML 拼字符串
（所有插值都过 `esc()`，实测无 XSS）。上 CSP 要么全改 DOM API、
要么上 Trusted Types，工作量和收益不匹配。等前端改成 `createElement` 为主之后再收紧。

Cookie 仍是 `httpOnly + SameSite=Lax + Path=/`，**没有 `__Host-` 前缀 / `secure`**：
`__Host-` 强制要求 `Secure`，而本项目默认跑在局域网 HTTP 上，加了浏览器就不发这个 cookie → 直接登不上。
代码里写了注释说明，等部署到 HTTPS 反代后再切。

---

## 三、顺带挖出的 2 个真 bug

改造过程中用「真实鼠标点击 + 网络抓包」实测，暴露了两个之前没发现的问题：

### 3.1 事件委托没限定容器 → 点「删除」删错了东西

```js
// 活动库和「已连接账号」两个表都用 data-del / data-del 按钮，
// 但选择器是全文档匹配：
$$('button[data-del]').forEach(...)   // ← loadConnections() 后执行，
                                      //    把凭证表的处理器盖到了活动表的按钮上
```

结果：点活动库的「删除」弹出的是「删除平台凭证？」确认框，点确认会去删凭证。
改法：所有选择器限定到各自容器（`#acts button[data-del]` / `#conns button[data-del]` …）。

### 3.2 `api()` 无 body 时仍声明 JSON content-type → 400

```js
// 改前
fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: ... })
// 即使没有 body 也声明了 JSON → Fastify 把「空 body + JSON」判成非法 JSON → 400
```

结果：「校验」「重新登录」两个按钮**一直是坏的**，报 `HTTP 400`（curl 测却正常，
因为 curl 没带 content-type）。

改法（双保险）：
- 客户端：只有真有 body 才声明 `Content-Type: application/json`
- 服务端：注册宽容的 JSON 解析器 —— 空 body 当 `{}`，非法 JSON 仍返回 400
  （并显式标 `statusCode = 400`，否则 Fastify 会当成 500）

---

## 四、复查结果

| 检查 | 改前 | 改后 |
|---|---|---|
| `legacy-scan` 确定性发现 | 3 | **0** |
| 输入框缺可访问名 | 9 / 16 | **0 / 16** |
| 弹层内可聚焦 vs 背景可聚焦 | 4 vs 148（Tab 会逃） | 背景 inert，强行 focus 无效 |
| 弹层可访问名 | 空 | 「MyWhoosh - Noboru…」 |
| 390px 页面横向溢出 | true（文档宽 902px） | **false** |
| `color-scheme` | normal | dark |
| 安全响应头 | 0 | 6 |
| 测试 | 128 | **133**（新增 HTTP 层 5 个） |

---

## 五、刻意没做的事

| 没做 | 原因 |
|---|---|
| 完整 CSP `script-src` | 前端还是 innerHTML 拼字符串；先做 Trusted Types 或全量 DOM 化再上 |
| Trusted Types | 同上；`esc()` 纪律目前已覆盖全部插值（已逐条核对） |
| SSE 替代轮询 | 需要服务端配合（目前是 8s/30s 轮询，且已加页面可见性暂停）；属于 M1 的「事件流」需求 |
| `popover` 改下拉/菜单 | 当前没有 dropdown / menu 组件，用不上 |
| View Transitions / 动效 | 这是内部控制台，不需要过渡动画；已加 `prefers-reduced-motion` 兜底 |
