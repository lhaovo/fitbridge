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

## 三、界面美化 + 深浅色主题

> 2026-11-24 追加。用户要求：美化界面、可切换深浅色、**默认浅色**。

### 3.1 主题机制（按 `dark-mode` / `dark-mode-toggle` 指南实现）

```
① <meta name="color-scheme" content="light dark">     声明支持两种方案
② 内联脚本（紧跟 meta，非 module/defer）               防 FOUC
③ :root { color-scheme: light dark }                    ← 基础值必须保持 light dark
④ :root:has(> head > meta[...][content="dark"]) {...}  把 meta 映射回 CSS 属性
⑤ 所有语义色用 light-dark() 写一次                     自动跟随 color-scheme
```

关键点（指南原文）：

- *"The `<meta>` is only a *presentational hint*: any `color-scheme` declaration in author CSS
  overrides it."* → 只改 meta 不生效，**必须**用 `:has()` 把 meta 映射回属性。
- *"DO NOT hardcode `color-scheme: light` or `color-scheme: dark` as the root default;
  the base declaration MUST stay `light dark`."* → 基础声明保持 `light dark`。
- *"CSS MUST NOT depend on JS: if JS never runs, the `<meta>` stays `light dark`
  and the site follows the system preference — nothing breaks."*

**默认浅色**的实现：内联脚本里 `localStorage.getItem('color-scheme') || 'light'`。
没有存储值时 meta 写成 `light` → `:has()` 把它映射成 `color-scheme: light` → 页面浅色。
所以「默认浅色」和「meta 保持 light dark 的能力」两者兼得。

切换时同时更新两处：
- `<meta name="color-scheme">` → 驱动 `light-dark()`
- `<html data-theme>` → 给**不支持 `light-dark()` 的老浏览器**兜底
  （`@supports not (color: light-dark(white, black))` 块里用 `[data-theme]` 切换）

其它细节：
- `theme-color` meta 跟着变（移动端浏览器地址栏）
- 按钮的 `aria-label` / `title` 会说明「点了会变成什么」
- 跨标签页同步：监听 `storage` 事件
- 切换按钮用**事件委托**，登录页和主界面各有一个都能用

### 3.2 浏览器原生 UI 也跟着主题走

| 手段 | 作用 |
|---|---|
| `color-scheme` | 滚动条、表单控件、日期选择器、canvas 底色 |
| `accent-color: var(--brand)` | 复选框 / 单选框 / 滑块的选中色 |
| `scrollbar-color` | 自定义滚动条（thumb 与 track 对比度 ≥3:1） |
| `::selection` | 选中文本高亮 |

> 注意：**不能给 `scrollbar-color` 加过渡动画**（WebKit bug 311752 会导致闪烁），
> 本项目也没有动画它。

### 3.3 对比度全部实测过

| 项 | 浅色 | 深色 | 要求 |
|---|---|---|---|
| 正文 / 页面底 | 16.40 | 16.43 | ≥4.5 ✅ |
| 次要文字 / 卡片底 | 5.51 | 6.96 | ≥4.5 ✅ |
| 品牌色 / 卡片底 | 5.17 | 6.52 | ≥4.5 ✅ |
| ok / 卡片底 | 5.02 | 10.19 | ≥4.5 ✅ |
| warn / 卡片底 | 5.02 | 10.64 | ≥4.5 ✅ |
| danger / 卡片底 | 4.83 | 6.42 | ≥4.5 ✅ |
| 输入框边框 / 卡片底 | 3.12 | 3.18 | ≥3（WCAG 1.4.11 非文本）✅ |
| 滚动条 thumb / track | 3.01 | 3.24 | ≥3 ✅ |
| 图表 5 条线 / 图表底 | 4.41 ~ 6.37 | 6.61 ~ 10.95 | ≥3 ✅ |

> 输入框边框单独用 `--border-input`（≥3:1）—— 边框是「这个框是个输入框」的
> **唯一**视觉线索，必须够；卡片/分隔线用更柔的 `--border` 无妨。
> 图表线条也跟着主题换色：浅色底用 blue-700 / green-700 这类深色，
> 深色底用 blue-400 / green-400 这类亮色（原来的 `#22c55e` 在浅色底上只有 2.1:1）。

### 3.4 视觉改动清单

- **顶栏**：毛玻璃（`backdrop-filter`）+ 半透明底 + 更紧凑的圆角按钮
- **卡片**：分层阴影（`--shadow-1/2/3`）、更大的圆角（12px）、平台卡片 hover 抬升
- **按钮**：primary 填充 / default 描边 / ghost 三档，hover/active 有反馈
- **输入框**：3px 品牌色焦点环、hover 变色；用 `:user-invalid` 而不是 `:invalid`
  （后者会在页面加载时就把空的必填项标红）
- **chips（平台选择）**：胶囊形，选中时品牌色描边 + 浅色底
- **表格**：有边框的滚动容器、粘性表头、hover 行高亮、空态用虚线框
- **徽标 / 标签**：柔和底色 + 同色系描边（ok/warn/danger 各一套）
- **图表**：SVG 里的硬编码颜色全部换成 CSS 变量，跟着主题走
- **Toast**：入场动画 + 左侧色条
- **焦点圈**：统一 `:focus-visible`，鼠标点击不显示
- **动效**：全部带 `prefers-reduced-motion` 兜底

---

## 四、顺带挖出的 2 个真 bug

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

## 五、复查结果

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

## 六、刻意没做的事

| 没做 | 原因 |
|---|---|
| 完整 CSP `script-src` | 前端还是 innerHTML 拼字符串；先做 Trusted Types 或全量 DOM 化再上 |
| Trusted Types | 同上；`esc()` 纪律目前已覆盖全部插值（已逐条核对） |
| SSE 替代轮询 | 需要服务端配合（目前是 8s/30s 轮询，且已加页面可见性暂停）；属于 M1 的「事件流」需求 |
| `popover` 改下拉/菜单 | 当前没有 dropdown / menu 组件，用不上 |
| View Transitions / 动效 | 这是内部控制台，不需要过渡动画；已加 `prefers-reduced-motion` 兜底 |
