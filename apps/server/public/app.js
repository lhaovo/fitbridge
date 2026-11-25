/* FitBridge 控制台
 *
 * 约定：
 *  - 静态骨架放在 index.html 的 <template> 里，这里用 cloneNode 取出，
 *    不用 innerHTML 拼自己的可信标记
 *  - 只有「数据驱动的列表」才用 innerHTML + esc()；
 *    esc() 是唯一的转义入口，平台返回的所有字符串都必须过它
 *  - 动态状态区域带 role="status" / aria-live，读屏用户能收到同步结果
 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  user: null,
  platforms: [],
  connections: [],
  activities: [],
  total: 0,
  events: [],
  filters: { q: '', platform: '', sport: '', since: '', until: '' },
  busy: false,
};

async function api(path, opts = {}) {
  // ★ 只有真有 body 时才声明 Content-Type: application/json。
  //   否则 Fastify 会把「空 body + JSON content-type」判成非法 JSON → 400，
  //   所有无 body 的 POST（校验 / 重新登录）都会挂掉。
  const { body, headers, ...rest } = opts;
  const init = { ...rest, headers: { ...(headers || {}) } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch('/api/v1' + path, init);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error(data?.error?.message || ('HTTP ' + res.status));
    e.code = data?.error?.code;
    e.status = res.status;
    e.payload = data;
    throw e;
  }
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDist = (m) => (m == null ? '—' : (m / 1000).toFixed(2) + ' km');
const fmtDur = (s) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

/* ── 模板 ───────────────────────────────────────────────── */
function fromTemplate(id) {
  const t = document.getElementById(id);
  return t.content.cloneNode(true);
}

/* ── 通用对话框 / Toast ─────────────────────────────────── */
/**
 * 原生 <dialog> 的「点遮罩关闭」（closedby="any"）兼容回退。
 *
 * closedby 是较新的属性；老浏览器上它会被忽略，弹层只剩 Esc 可关。
 * 这里用指针位置补上：按下和抬起都在弹层外才关。
 * 注意判断的是指针坐标而不是 event.target —— <dialog> 自身的 padding
 * 与子元素之间的空隙也会是 target，按 target 判断会误关。
 */
function installLightDismiss(dialog) {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const outside = (e, dlg) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
  dialog.addEventListener('pointerup', (e) => {
    if (pressedOutside && outside(e, dialog)) dialog.close();
  });
}

/** 通用确认弹层，替代原生 confirm() */
let confirmDlg = null;
function ensureConfirmDialog() {
  if (confirmDlg) return confirmDlg;
  const d = document.createElement('dialog');
  d.id = 'fb-confirm';
  d.className = 'modal modal-sm';
  d.setAttribute('closedby', 'any');
  d.setAttribute('aria-labelledby', 'fb-confirm-title');
  d.innerHTML =
    '<div class="modal-card">' +
    '<div class="modal-head">' +
    '<h2 class="modal-title" id="fb-confirm-title">请确认</h2>' +
    '<button type="button" id="fb-confirm-x" autofocus>关闭</button>' +
    '</div>' +
    '<div class="modal-body"><p id="fb-confirm-text" style="margin:0"></p></div>' +
    '<div class="modal-foot">' +
    '<button type="button" id="fb-confirm-cancel">取消</button>' +
    '<button type="button" id="fb-confirm-ok" class="primary">确定</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(d);
  installLightDismiss(d);
  d.querySelector('#fb-confirm-x').onclick = () => d.close();
  d.querySelector('#fb-confirm-cancel').onclick = () => d.close();
  confirmDlg = d;
  return d;
}

/**
 * 询问确认。返回 Promise<boolean>。
 * 关闭（Esc / 点遮罩 / 取消）都算「否」。
 */
function askConfirm(text, opts = {}) {
  const d = ensureConfirmDialog();
  d.querySelector('#fb-confirm-title').textContent = opts.title || '请确认';
  d.querySelector('#fb-confirm-text').textContent = text;
  const ok = d.querySelector('#fb-confirm-ok');
  ok.textContent = opts.okText || '确定';
  ok.className = opts.danger ? 'danger-btn' : 'primary';

  return new Promise((resolve) => {
    let answer = false;
    const onOk = () => { answer = true; d.close(); };
    ok.addEventListener('click', onOk, { once: true });
    d.addEventListener('close', () => {
      ok.removeEventListener('click', onOk);
      resolve(answer);
    }, { once: true });
    if (!d.open) d.showModal();
  });
}

/* ── 通知（Toast）─────────────────────────────────────────
 *
 * 替代原生 alert()（alert 会阻塞整个事件循环）。
 *
 * 实现遵循 modern-web-guidance / persistent-toast-notifications：
 *   ① popover="manual" —— 通知不会被浏览器自动关掉，必须显式关闭
 *      （或由脚本按业务需要定时关闭）。低频、重要的事件保持常驻。
 *   ② 每个 toast 独立定位 —— popover 进入 Top Layer，父容器的
 *      flex 布局和 z-index 都不生效，必须自己算 inset-block-end。
 *   ③ 关闭按钮用 popovertargetaction="hide"（原生行为，键盘可达，
 *      且不抢焦点）。
 *   ④ 用 ariaNotify() 播报；不支持该 API 时退回 role=status/alert。
 *   ⑤ 过渡用 transition-behavior: allow-discrete（独立声明），
 *      这样退出动画也能跑完再真正移除节点。
 */
const SUPPORTS_POPOVER = typeof HTMLElement.prototype.showPopover === 'function';
let toastSeq = 0;

function toastHost() {
  let host = $('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    // 所有通知都在同一个可定位的区域里，读屏用户能一致地找到
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', '通知');
    document.body.appendChild(host);
  }
  return host;
}

/** 重排 toast 的堆叠位置（新的在最下面，最贴近屏幕角落） */
function layoutToasts() {
  const list = $$('.toast-host .toast').reverse();
  let offset = 20;
  for (const t of list) {
    t.style.setProperty('--toast-bottom', offset + 'px');
    offset += t.getBoundingClientRect().height + 8;
  }
}

/**
 * @param {string} message 正文
 * @param {'info'|'ok'|'warn'|'err'} level
 * @param {{persistent?: boolean}} opts persistent=true 时不自动消失
 * @returns {HTMLElement} toast 元素（可用于手动关闭）
 */
function toast(message, level = 'info', opts = {}) {
  const persistent = opts.persistent === true;
  const host = toastHost();

  const el = document.createElement('div');
  const id = 'toast-' + ++toastSeq;
  el.id = id;
  el.className = 'toast ' + level;
  el.setAttribute('role', level === 'err' ? 'alert' : 'status');
  if (SUPPORTS_POPOVER) el.setAttribute('popover', 'manual');

  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = message;
  el.appendChild(body);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-x';
  btn.setAttribute('popovertarget', id);
  btn.setAttribute('popovertargetaction', 'hide');
  btn.setAttribute('aria-label', '关闭通知');
  btn.textContent = '\u00d7';
  btn.addEventListener('click', () => {
    // 有 popover 时由 toggle(closed) 统一移除；没有则直接移除
    if (!SUPPORTS_POPOVER) { el.remove(); layoutToasts(); }
  });
  el.appendChild(btn);

  host.appendChild(el);

  if (SUPPORTS_POPOVER) {
    el.addEventListener('toggle', (e) => {
      if (e.newState === 'closed') { el.remove(); layoutToasts(); }
    });
    try { el.showPopover(); } catch { /* 已被关掉 */ }
  }

  layoutToasts();

  // 只播报正文，不要把按钮的名字一起念出来
  if (typeof el.ariaNotify === 'function') {
    try { el.ariaNotify(message); } catch { /* 忽略 */ }
  }

  if (!persistent) {
    setTimeout(() => {
      if (SUPPORTS_POPOVER && el.matches(':popover-open')) el.hidePopover();
      else { el.remove(); layoutToasts(); }
    }, level === 'err' ? 9000 : 4000);
  }
  return el;
}

/* ── 主题（浅色 / 深色）────────────────────────────────────
 *
 * 状态存 localStorage，默认浅色。
 * 切换时同时更新两处：
 *   <meta name="color-scheme">  → 驱动 CSS 里的 light-dark()
 *   <html data-theme>           → 给不支持 light-dark() 的老浏览器兜底
 * 内联脚本（index.html）在 CSS 之前已经设过一次，这里只做同步。
 */
const THEME_KEY = 'color-scheme';

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, persist) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;

  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = t;
  // 移动端浏览器地址栏也跟着变
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = t === 'dark' ? '#0b0e14' : '#f4f6fa';

  // 切换按钮的文案要说明「点了会变成什么」
  $$('#theme-toggle').forEach((b) => {
    b.setAttribute('aria-label', t === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    b.setAttribute('title', t === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  });

  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式：忽略 */ }
  }
}

function initTheme() {
  applyTheme(currentTheme(), false);

  // 用事件委托：登录页和主界面各有一个切换按钮，谁先渲染都能用
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('#theme-toggle');
    if (!btn) return;
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  });

  // 另一个标签页改了主题 → 这里跟着变
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY || !e.newValue) return;
    applyTheme(e.newValue, false);
  });
}

/* ── 网络连通性自检 ────────────────────────────────────────
 *
 * 「账号密码错了」和「本机网断了」是最容易混淆的两种故障。
 * 服务端做一次 TLS 握手级探测（不带任何业务请求），
 * 把两者明确区分开，并直接告诉用户该检查什么。
 *
 * 探测每 60s 跑一次，所以只在「状态发生变化」时才播报，
 * 避免故障持续时反复打扰（也避免读屏用户被同样的信息刷屏）。
 */
let netState = null;      // null=未知 'ok' 'bad'
let netToast = null;      // 持续故障期间常驻的那条通知

async function checkConnectivity() {
  let data;
  try {
    data = await api('/connectivity');
  } catch {
    return;
  }
  const bad = data.unreachable || [];
  const ok = bad.length === 0 && data.allReachable !== false;
  const next = ok ? 'ok' : 'bad';
  const changed = next !== netState;
  netState = next;

  const badge = $('#net');
  // 只在真的变了的时候才改 DOM —— 每 60s 重写同样的文本会让读屏软件重复播报
  if (badge && badge.dataset.state !== next) {
    badge.dataset.state = next;
    badge.textContent = ok ? '网络正常' : '网络不通';
    badge.className = 'badge ' + (ok ? 'ok' : 'danger');
    badge.title = ok
      ? '所有平台 API 域名均可连接'
      : '连不上：' + bad.join('、') + '（检查本机网络 / 代理节点）';
  }

  const note = $('#net-note');
  if (note) {
    if (ok) {
      note.hidden = true;
    } else {
      note.hidden = false;
      note.innerHTML =
        '<b>连不上平台服务</b>：' +
        esc(bad.join('、')) +
        '<br/>这不是账号密码问题 —— 请检查本机网络 / 代理节点是否正常，恢复后再试。';
    }
  }

  // 网络故障是「持续状态」而不是「一次性事件」→ 用常驻通知，不自动消失
  if (!ok && changed) {
    netToast = toast(
      '连不上平台服务：' +
        bad.join('、') +
        '。这不是账号密码问题，请检查本机网络 / 代理节点是否正常，恢复后再试。',
      'err',
      { persistent: true }
    );
  } else if (ok && changed && netToast) {
    // 恢复了就把常驻通知收掉
    if (SUPPORTS_POPOVER && netToast.matches(':popover-open')) netToast.hidePopover();
    else netToast.remove();
    netToast = null;
    layoutToasts();
  }
}

/* ── 登录 ───────────────────────────────────────────────── */
function renderLogin(msg) {
  const root = $('#app');
  root.replaceChildren(fromTemplate('tpl-login'));
  const form = $('#login-form');
  const err = $('#err');

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { password: $('#pwd').value } });
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  };

  $('#pwd').focus();
  if (msg) err.textContent = msg;
  checkConnectivity();
}

/* ── 主框架 ─────────────────────────────────────────────── */
function renderApp() {
  const root = $('#app');
  root.replaceChildren(fromTemplate('tpl-app'));

  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); renderLogin(); };
  $('#dry').onclick = () => runSync(true);
  $('#run').onclick = () => runSync(false);
  $$('input[name=sync-mode]').forEach((r) => {
    r.onchange = () => applySyncMode();
  });
  applySyncMode();

  // 筛选：走原生 form，Enter 提交由浏览器处理（输入法选词不会误触发）
  $('#filter-form').onsubmit = (e) => { e.preventDefault(); readFilters(); loadActivities(); };
  $('#freset').onclick = () => {
    $('#fq').value = ''; $('#fplatform').value = ''; $('#fsport').value = '';
    $('#fsince').value = ''; $('#funtil').value = '';
    state.filters = { q: '', platform: '', sport: '', since: '', until: '' };
    loadActivities();
  };

  loadHealth();
  renderPlatforms();
  loadConnections();
  loadActivities();
  loadEvents();
  loadStorage();
  startPolling();
}

/* ── 轮询：页面不可见时暂停 ─────────────────────────────── */
let pollTimers = [];
function startPolling() {
  stopPolling();
  pollTimers.push(setInterval(loadEvents, 8000));
  pollTimers.push(setInterval(loadStorage, 30000));
  pollTimers.push(setInterval(checkConnectivity, 60000));
}
function stopPolling() {
  pollTimers.forEach((t) => clearInterval(t));
  pollTimers = [];
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    loadEvents();
    loadStorage();
    checkConnectivity();
    startPolling();
  }
});

/* ── 同步模式：仅本地库 / 同时上传 ─────────────────────── */
function syncMode() {
  const el = document.querySelector('input[name=sync-mode]:checked');
  return el ? el.value : 'local';
}

function applySyncMode() {
  const mode = syncMode();
  const isUpload = mode === 'upload';
  const wrap = $('#dst-wrap');
  if (wrap) wrap.style.display = isUpload ? 'block' : 'none';
  const run = $('#run');
  if (run) run.textContent = isUpload ? '同步并上传到目标平台' : '同步到本地库';
}

function readFilters() {
  state.filters = {
    q: $('#fq').value.trim(),
    platform: $('#fplatform').value,
    sport: $('#fsport').value,
    since: $('#fsince').value ? new Date($('#fsince').value + 'T00:00:00').toISOString() : '',
    until: $('#funtil').value ? new Date($('#funtil').value + 'T23:59:59').toISOString() : '',
  };
}

/* ── 同步 ───────────────────────────────────────────────── */
function renderSyncChips() {
  const src = $('#src-list'), dst = $('#dst-list');
  if (!src || !dst) return;
  const connected = new Set(state.connections.filter((c) => c.status === 'active').map((c) => c.platformId));
  src.innerHTML = state.platforms
    .filter((p) => p.capabilities.download)
    .map((p) => `<label class="chip"><input type="checkbox" value="${esc(p.id)}" ${connected.has(p.id) ? '' : 'disabled'}/> ${esc(p.displayName)}${connected.has(p.id) ? '' : ' <span class="muted">(未连接)</span>'}</label>`)
    .join('') || '<span class="muted">没有可用的来源平台</span>';
  dst.innerHTML = state.platforms
    .filter((p) => p.capabilities.upload)
    .map((p) => `<label class="chip"><input type="checkbox" value="${esc(p.id)}" ${connected.has(p.id) ? '' : 'disabled'}/> ${esc(p.displayName)}${connected.has(p.id) ? '' : ' <span class="muted">(未连接)</span>'}</label>`)
    .join('') || '<span class="muted">没有可上传的目标平台</span>';
}

async function runSync(dry) {
  if (state.busy) return;
  const sources = $$('#src-list input:checked').map((i) => i.value);
  // 仅本地库模式 → 不传目标平台
  const targets = syncMode() === 'upload'
    ? $$('#dst-list input:checked').map((i) => i.value)
    : [];
  const out = $('#sync-out');
  const force = $('#force').checked;
  if (!sources.length) { out.innerHTML = '<div class="err">请至少选择一个来源平台</div>'; return; }
  if (syncMode() === 'upload' && !targets.length) {
    out.innerHTML = '<div class="err">请至少选择一个目标平台（或切回「仅同步到本地库」）</div>';
    return;
  }

  state.busy = true;
  $('#run').disabled = true; $('#dry').disabled = true;
  out.innerHTML = '<div class="muted">运行中…</div>';
  try {
    const data = await api('/sync/run', {
      method: 'POST',
      body: {
        sourcePlatforms: sources,
        targetPlatforms: targets,
        dryRun: dry,
        policy: {
          maxItemsPerRun: Number($('#max-items').value) || 50,
          // 全量重拉：忽略增量窗口，重新拉全部历史（去重仍生效，不会产生重复）
          forceResync: force,
        },
      },
    });
    const s = data.summary;
    const dupSkipped = s.skipped > 0;

    // 所有平台都因为网络失败 → 大概率是本机网络/代理问题，不是账号问题
    const errs = s.errors || [];
    const netDown =
      errs.length > 0 &&
      errs.length === Object.keys(s.perPlatform).length &&
      errs.every((e) => /连接被重置|连接超时|域名解析失败|ECONNRESET|ETIMEDOUT|fetch failed|网络|不可达/.test(e));

    out.innerHTML = `
      <div class="tags">
        <span class="tag ${dry ? 'warn' : 'yes'}">${dry ? '预览完成（未写入任何数据）' : '同步完成'}</span>
        <span class="tag">发现 ${s.discovered}</span>
        <span class="tag">新增 ${s.downloaded}</span>
        <span class="tag ${dupSkipped ? 'warn' : ''}">跳过 ${s.skipped}${dupSkipped ? '（已存在·去重命中）' : ''}</span>
        <span class="tag ${s.failed ? 'no' : ''}">失败 ${s.failed}</span>
        <span class="tag ${s.uploaded ? 'yes' : ''}">上传 ${s.uploaded}</span>
        <span class="tag ${s.uploadFailed ? 'no' : ''}">上传失败 ${s.uploadFailed}</span>
      </div>
      <table><thead><tr><th scope="col">平台</th><th scope="col">发现</th><th scope="col">新增</th><th scope="col">跳过(去重)</th><th scope="col">失败</th><th scope="col">上传</th><th scope="col">上传失败</th></tr></thead>
      <tbody>${Object.entries(s.perPlatform).map(([k, v]) => `<tr>
        <td>${esc(k)}${v.error ? ' <span class="tag warn">' + esc(v.error) + '</span>' : ''}</td>
        <td>${v.discovered}</td><td>${v.downloaded}</td><td>${v.skipped}</td><td>${v.failed}</td><td>${v.uploaded}</td><td>${v.uploadFailed}</td></tr>`).join('')}</tbody></table>
      ${s.errors.length ? '<div class="err" style="margin-top:10px">' + s.errors.map(esc).join('<br/>') + '</div>' : ''}
      ${netDown ? '<div class="notice" style="margin-top:10px"><b>所有平台都连不上</b> —— 这不是账号密码问题，' +
        '多半是本机网络 / 代理节点断了。恢复网络后再点一次同步即可，账号密码不用动。</div>' : ''}
      <div class="muted" style="margin-top:8px">runId: ${esc(s.runId)}</div>`;
    if (!dry) { loadActivities(); loadEvents(); loadStorage(); }
  } catch (e) {
    out.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  } finally {
    state.busy = false;
    $('#run').disabled = false; $('#dry').disabled = false;
  }
}

/* ── 表格工具 ───────────────────────────────────────────── */
/**
 * 表格统一包一层 .table-wrapper：
 *  - overflow:auto 让宽表在自己的容器里横向滚动，而不是把整页撑宽
 *  - tabindex="0" + role="region" 让键盘用户能滚动它
 *  - container-type: inline-size 让 @container 查询能按表格自身宽度适配
 */
function tableWrap(tableHtml, label) {
  return '<div class="table-wrapper" tabindex="0" role="region" aria-label="' + esc(label) + '">' +
    tableHtml + '</div>';
}

/* ── 活动库 ─────────────────────────────────────────────── */
async function loadActivities() {
  const p = new URLSearchParams();
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.platform) p.set('platform', state.filters.platform);
  if (state.filters.sport) p.set('sport', state.filters.sport);
  if (state.filters.since) p.set('since', state.filters.since);
  if (state.filters.until) p.set('until', state.filters.until);
  p.set('limit', '200');

  const box = $('#acts');
  if (!box) return;
  try {
    const data = await api('/activities?' + p.toString());
    state.activities = data.activities || [];
    state.total = data.total || 0;
  } catch {
    state.activities = [];
    state.total = 0;
  }

  $('#ftotal').textContent = state.total + ' 条';

  const sel = $('#fplatform');
  if (sel && sel.options.length <= 1) {
    sel.innerHTML = '<option value="">全部来源</option>' +
      state.platforms.map((p2) => `<option value="${esc(p2.id)}">${esc(p2.displayName)}</option>`).join('');
  }

  if (!state.activities.length) {
    box.innerHTML = '<div class="empty">还没有活动 —— 先连接平台账号，再执行一次同步</div>';
    return;
  }

  const rows = state.activities.map((a) => {
    const m = a.metrics || {};
    const metricTxt = [
      m.avgHeartRate ? m.avgHeartRate + 'bpm' : '',
      m.avgPower ? m.avgPower + 'W' : '',
      m.avgCadence ? m.avgCadence + 'rpm' : '',
    ].filter(Boolean).join(' · ');
    const flags = [];
    if (a.flags?.timezoneAdjusted) flags.push('时区已修正');
    if (a.flags?.coordinatesAdjusted) flags.push('坐标已转换');
    if (a.flags?.coordinateSystemOriginal && a.flags.coordinateSystemOriginal !== 'unknown' && a.flags.coordinateSystemOriginal !== 'wgs84') {
      flags.push('源坐标系 ' + a.flags.coordinateSystemOriginal);
    }
    return `<tr>
        <td style="white-space:nowrap">${esc(fmtTime(a.startTime))}</td>
        <td>${esc(a.name)}${flags.length ? '<br/><span class="muted" style="font-size:11px">' + esc(flags.join(' · ')) + '</span>' : ''}</td>
        <td><span class="tag">${esc(a.source.platformId)}</span></td>
        <td class="num">${esc(fmtDist(a.distanceMeters))}</td>
        <td class="num">${esc(fmtDur(a.durationSec))}</td>
        <td>${esc(a.sportType)}</td>
        <td style="font-size:12px;color:var(--muted)">${esc(metricTxt || '—')}</td>
        <td>${(a.syncedTargets || []).map((t) => '<span class="tag yes">' + esc(t) + '</span>').join(' ') || '<span class="muted">—</span>'}</td>
        <td class="row end acts">
          <button type="button" data-view="${esc(a.id)}">详情</button>
          <a class="btn-link" href="/api/v1/activities/${esc(a.id)}/file">下载</a>
          <button type="button" data-del="${esc(a.id)}">删除</button>
        </td>
      </tr>`;
  }).join('');

  box.innerHTML = tableWrap(
    '<table class="acts-table">' +
    '<caption class="visually-hidden">活动列表，共 ' + state.total + ' 条</caption>' +
    '<thead><tr>' +
    '<th scope="col">时间</th><th scope="col">名称</th><th scope="col">来源</th>' +
    '<th scope="col">距离</th><th scope="col">时长</th><th scope="col">类型</th>' +
    '<th scope="col">指标</th><th scope="col">已同步</th><th scope="col">操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>',
    '活动列表',
  );

  $$('#acts button[data-view]').forEach((b) => {
    b.onclick = () => openDetail(b.dataset.view);
  });

  $$('#acts button[data-del]').forEach((b) => {
    b.onclick = async () => {
      const ok = await askConfirm('删除这条本地活动副本？（已上传到其它平台的数据不受影响）', {
        title: '删除本地副本',
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api('/activities/' + b.dataset.del, { method: 'DELETE' });
      loadActivities();
      toast('已删除本地副本', 'ok');
    };
  });
}

/* ── 本地库状态 ─────────────────────────────────────────── */
async function loadStorage() {
  const box = $('#storage');
  if (!box) return;
  let st;
  try {
    st = (await api('/storage/stats')).stats;
  } catch {
    box.innerHTML = '<div class="empty">无法读取本地库状态</div>';
    return;
  }
  const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  const byPlatform = st.byPlatform.length
    ? tableWrap(
      '<table><caption class="visually-hidden">按来源平台统计</caption>' +
      '<thead><tr><th scope="col">来源平台</th><th scope="col">活动</th><th scope="col">文件</th><th scope="col">占用</th></tr></thead><tbody>' +
      st.byPlatform.map((b) => `<tr>
        <td>${esc(b.platformId)}</td><td>${b.activities}</td><td>${b.files}</td><td>${kb(b.sizeBytes)}</td>
      </tr>`).join('') + '</tbody></table>',
      '按平台统计',
    )
    : '<div class="empty">还没有数据</div>';

  box.innerHTML = `
    <div class="row" style="gap:20px">
      <div style="flex:1;min-width:200px">
        <div class="meta">数据库</div>
        <div><code>${esc(st.database.path)}</code></div>
        <div class="muted" style="font-size:12px;margin-top:4px">
          ${kb(st.database.sizeBytes)} · ${st.database.tables} 张表 · journal=${esc(st.database.journalMode)}
        </div>
      </div>
      <div style="flex:1;min-width:200px">
        <div class="meta">原始文件</div>
        <div><code>${esc(st.blobs.dir)}</code></div>
        <div class="muted" style="font-size:12px;margin-top:4px">
          ${st.blobs.fileCount} 个 · ${kb(st.blobs.sizeBytes)} · 保留 ${st.policy.fileRetentionDays} 天
        </div>
      </div>
      <div style="flex:1;min-width:200px">
        <div class="meta">去重与保留</div>
        <div class="muted" style="font-size:12px">
          活动 ${st.counts.activities} 条（有效文件 ${st.counts.activeFiles}，已清理 ${st.counts.expiredFiles}）<br/>
          同步运行 ${st.counts.syncRuns} 次 · 凭证 ${st.counts.credentials} 个（加密）<br/>
          派生文件缓存 ${st.policy.derivedTtlDays} 天
        </div>
      </div>
    </div>
    ${byPlatform}`;
}

/* ── 事件 ───────────────────────────────────────────────── */
async function loadEvents() {
  const box = $('#events');
  if (!box) return;
  try {
    const data = await api('/events?limit=30');
    state.events = data.events || [];
  } catch {
    state.events = [];
  }
  if (!state.events.length) {
    box.innerHTML = '<div class="empty">暂无事件</div>';
    return;
  }
  box.innerHTML = tableWrap(
    '<table><caption class="visually-hidden">最近 30 条运行事件</caption>' +
    '<thead><tr><th scope="col">时间</th><th scope="col">级别</th><th scope="col">分类</th>' +
    '<th scope="col">平台</th><th scope="col">消息</th></tr></thead><tbody>' +
    state.events.map((e) => `<tr>
      <td style="white-space:nowrap;font-size:12px">${esc(fmtTime(e.created_at))}</td>
      <td><span class="badge ${e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'ok'}">${esc(e.level)}</span></td>
      <td>${esc(e.category)}</td>
      <td>${esc(e.platform_id || '—')}</td>
      <td>${esc(e.message)}</td>
    </tr>`).join('') + '</tbody></table>',
    '运行事件',
  );
}

/* ── 平台 / 连接 ────────────────────────────────────────── */
async function loadHealth() {
  try {
    const res = await fetch('/health');
    const h = await res.json();
    const el = $('#health');
    el.textContent = 'v' + h.version + ' · db ' + (h.db ? 'ok' : 'down') + ' · ' + h.fileStore;
    el.className = 'badge ' + (h.db ? 'ok' : 'danger');
  } catch {
    const el = $('#health');
    el.textContent = '服务异常';
    el.className = 'badge danger';
  }
}

function platformCard(p) {
  const c = p.capabilities;
  const accessTag = p.access === 'official'
    ? '<span class="tag yes">官方 API</span>'
    : p.access === 'reverse-engineered'
      ? '<span class="tag warn">逆向接口</span>'
      : '<span class="tag">' + esc(p.access) + '</span>';
  return `
    <div class="card interactive" data-pid="${esc(p.id)}">
      <h3>${esc(p.displayName)}
        <span class="badge ${p.riskLevel === 'high' ? 'danger' : p.riskLevel === 'medium' ? 'warn' : 'ok'}">${esc(p.riskLevel)}</span>
      </h3>
      <div class="meta">${esc(p.vendor)} · 短码 <code>${esc(p.shortCode)}</code> · 坐标系 ${esc(p.coordinateSystem)}</div>
      <div class="tags">
        ${accessTag}
        <span class="tag ${c.download ? 'yes' : 'no'}">${c.download ? '可下载' : '不可下载'}</span>
        <span class="tag ${c.upload ? 'yes' : 'no'}">${c.upload ? '可上传' : '不可上传'}</span>
        ${c.uploadFormats.map((f) => '<span class="tag">' + esc(f.toUpperCase()) + '</span>').join('')}
        <span class="tag">${c.incremental ? '支持增量' : '无增量接口'}</span>
      </div>
      ${p.notes ? '<div class="notice">' + esc(p.notes) + '</div>' : ''}
      <details>
        <summary style="cursor:pointer;color:var(--muted);font-size:13px">连接账号</summary>
        <form class="conn-form" style="margin-top:10px">
          <label for="acc-${esc(p.id)}">账号</label>
          <input id="acc-${esc(p.id)}" name="account" autocomplete="username" required />
          <label for="pwd-${esc(p.id)}">密码</label>
          <input id="pwd-${esc(p.id)}" name="password" type="password" autocomplete="current-password" required />
          <div class="row end" style="margin-top:12px"><button class="primary" type="submit">连接</button></div>
          <div class="ok-msg" role="status" aria-live="polite"></div>
          <div class="err" role="alert"></div>
        </form>
      </details>
    </div>`;
}

function renderPlatforms() {
  const box = $('#platforms');
  if (!box) return;
  box.innerHTML = state.platforms.map(platformCard).join('');
  $$('#platforms .conn-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const pid = form.closest('.card').dataset.pid;
      const ok = form.querySelector('.ok-msg');
      const err = form.querySelector('.err');
      ok.textContent = ''; err.textContent = '';
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = '连接中…';
      try {
        const fd = new FormData(form);
        await api('/connections/' + pid, {
          method: 'POST',
          body: { account: fd.get('account'), password: fd.get('password') },
        });
        ok.textContent = '连接成功';
        form.reset();
        await loadConnections();
        toast('平台账号已连接', 'ok');
      } catch (e2) {
        err.textContent = e2.message + (e2.payload?.retryAfterMinutes ? '（约 ' + e2.payload.retryAfterMinutes + ' 分钟后可重试）' : '');
      } finally {
        btn.disabled = false; btn.textContent = '连接';
      }
    };
  });
}

async function loadConnections() {
  const box = $('#conns');
  if (!box) return;
  try {
    const data = await api('/connections');
    state.connections = data.connections || [];
  } catch {
    state.connections = [];
  }
  renderSyncChips();
  if (!state.connections.length) {
    box.innerHTML = '<div class="empty">还没有连接任何平台账号</div>';
    return;
  }
  box.innerHTML = tableWrap(
    '<table><caption class="visually-hidden">已连接的平台账号</caption>' +
    '<thead><tr><th scope="col">平台</th><th scope="col">状态</th><th scope="col">最近校验</th>' +
    '<th scope="col">创建时间</th><th scope="col">操作</th></tr></thead><tbody>' +
    state.connections.map((c) => `<tr>
      <td>${esc(c.platformId)}</td>
      <td><span class="badge ${c.status === 'active' ? 'ok' : 'warn'}">${esc(c.status)}</span></td>
      <td>${esc(c.lastValidatedAt || '—')}</td>
      <td>${esc(c.createdAt || '—')}</td>
      <td class="row end acts">
        <button type="button" data-val="${esc(c.id)}">校验</button>
        <button type="button" data-rel="${esc(c.id)}">重新登录</button>
        <button type="button" data-del="${esc(c.id)}">删除</button>
      </td></tr>`).join('') + '</tbody></table>',
    '已连接账号',
  );

  $$('#conns button[data-val]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '校验中…';
      try {
        const r = await api('/connections/' + b.dataset.val + '/validate', { method: 'POST' });
        toast(r.ok ? '凭证有效' : '凭证无效：' + (r.reason || ''), r.ok ? 'ok' : 'warn');
        await loadConnections();
      } catch (e) { toast(e.message, 'err'); }
      finally { b.disabled = false; b.textContent = '校验'; }
    };
  });
  $$('#conns button[data-rel]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '登录中…';
      try {
        await api('/connections/' + b.dataset.rel + '/relogin', { method: 'POST' });
        toast('已重新登录', 'ok');
        await loadConnections();
      } catch (e) { toast(e.message, 'err'); }
      finally { b.disabled = false; b.textContent = '重新登录'; }
    };
  });
  $$('#conns button[data-del]').forEach((b) => {
    b.onclick = async () => {
      const ok = await askConfirm('删除该平台凭证？之后需要重新输入账号密码才能同步。', {
        title: '删除平台凭证',
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api('/connections/' + b.dataset.del, { method: 'DELETE' });
      toast('凭证已删除', 'ok');
      await loadConnections();
    };
  });
}

/* ── 启动 ───────────────────────────────────────────────── */
initTheme();

async function boot() {
  try {
    const me = await api('/auth/me');
    if (!me.user) return renderLogin();
  } catch {
    return renderLogin();
  }
  try {
    const data = await api('/platforms');
    state.platforms = data.platforms || [];
  } catch {
    state.platforms = [];
  }
  renderApp();
  await loadConnections();
  checkConnectivity();
}

boot();
