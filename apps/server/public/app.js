/* FitBridge 控制台（M0 早期版本） */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  user: null,
  platforms: [],
  connections: [],
};

async function api(path, opts = {}) {
  const res = await fetch('/api/v1' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error(data?.error?.message || ('HTTP ' + res.status));
    e.code = data?.error?.code;
    e.status = res.status;
    throw e;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── 渲染：登录 ───────────────────────────────────────── */
function renderLogin(msg) {
  document.body.innerHTML = `
    <div class="login card">
      <h3 style="margin-bottom:2px">FitBridge</h3>
      <p class="hint" style="margin-bottom:14px">多平台运动数据同步 · 单用户自托管</p>
      <label>管理员密码</label>
      <input id="pwd" type="password" autocomplete="current-password" placeholder="FITBRIDGE_PASSWORD" />
      <div class="err" id="err"></div>
      <div class="row end" style="margin-top:12px">
        <button class="primary" id="go">登录</button>
      </div>
    </div>`;

  const submit = async () => {
    $('#err').textContent = '';
    $('#go').disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { password: $('#pwd').value } });
      await boot();
    } catch (e) {
      $('#err').textContent = e.message;
      $('#go').disabled = false;
    }
  };
  $('#go').onclick = submit;
  $('#pwd').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#pwd').focus();
  if (msg) $('#err').textContent = msg;
}

/* ── 渲染：主界面 ─────────────────────────────────────── */
function renderApp() {
  document.body.innerHTML = `
    <header class="top">
      <div class="logo">Fit<span>Bridge</span></div>
      <span class="badge" id="health">连接中…</span>
      <div class="spacer"></div>
      <span class="badge" id="mode">单用户 · 自托管</span>
      <button id="logout">退出</button>
    </header>
    <div class="wrap">
      <h1>平台</h1>
      <p class="hint">能力矩阵由各适配器的 manifest 声明渲染。点击平台卡片可连接账号。</p>
      <div class="grid" id="platforms"></div>

      <h2>已连接账号</h2>
      <p class="hint">凭证经 AES-256-GCM 加密后存于本地 SQLite，API 永不返回明文。</p>
      <div class="card" id="conns"></div>

      <h2>活动</h2>
      <p class="hint">统一运动库（待同步引擎接入后填充）。</p>
      <div class="card"><div class="empty">暂无活动 —— 同步引擎尚未接入</div></div>
    </div>`;

  $('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    renderLogin();
  };

  loadHealth();
  renderPlatforms();
  loadConnections();
}

async function loadHealth() {
  try {
    const res = await fetch('/health');
    const h = await res.json();
    const el = $('#health');
    el.textContent = 'v' + h.version + ' · db ' + (h.db ? 'ok' : 'down') + ' · ' + h.fileStore;
    el.className = 'badge ' + (h.db ? 'ok' : 'danger');
  } catch {
    $('#health').textContent = '服务异常';
    $('#health').className = 'badge danger';
  }
}

function platformCard(p) {
  const c = p.capabilities;
  const accessTag =
    p.access === 'official'
      ? '<span class="tag yes">官方 API</span>'
      : p.access === 'reverse-engineered'
        ? '<span class="tag warn">逆向接口</span>'
        : '<span class="tag">' + esc(p.access) + '</span>';

  return `
    <div class="card" data-pid="${esc(p.id)}">
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
          <label>账号</label>
          <input name="account" autocomplete="username" required />
          <label>密码</label>
          <input name="password" type="password" autocomplete="current-password" required />
          <div class="row end" style="margin-top:12px">
            <button class="primary" type="submit">连接</button>
          </div>
          <div class="ok-msg"></div>
          <div class="err"></div>
        </form>
      </details>
    </div>`;
}

function renderPlatforms() {
  const box = $('#platforms');
  box.innerHTML = state.platforms.map(platformCard).join('');
  $$('.conn-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const card = form.closest('.card');
      const pid = card.dataset.pid;
      const ok = form.querySelector('.ok-msg');
      const err = form.querySelector('.err');
      ok.textContent = '';
      err.textContent = '';
      const btn = form.querySelector('button');
      btn.disabled = true;
      btn.textContent = '连接中…';
      try {
        const fd = new FormData(form);
        await api('/connections/' + pid, {
          method: 'POST',
          body: {
            account: fd.get('account'),
            password: fd.get('password'),
          },
        });
        ok.textContent = '连接成功';
        form.reset();
        await loadConnections();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '连接';
      }
    };
  });
}

async function loadConnections() {
  const box = $('#conns');
  try {
    const data = await api('/connections');
    state.connections = data.connections || [];
  } catch {
    state.connections = [];
  }
  if (!state.connections.length) {
    box.innerHTML = '<div class="empty">还没有连接任何平台账号</div>';
    return;
  }
  box.innerHTML =
    '<table><thead><tr><th>平台</th><th>状态</th><th>最近校验</th><th>创建时间</th><th></th></tr></thead><tbody>' +
    state.connections
      .map(
        (c) => `<tr>
          <td>${esc(c.platformId)}</td>
          <td><span class="badge ${c.status === 'active' ? 'ok' : 'warn'}">${esc(c.status)}</span></td>
          <td>${esc(c.lastValidatedAt || '—')}</td>
          <td>${esc(c.createdAt || '—')}</td>
          <td class="row end"><button data-del="${esc(c.id)}">删除</button></td>
        </tr>`,
      )
      .join('') +
    '</tbody></table>';

  $$('button[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该平台凭证？')) return;
      await api('/connections/' + b.dataset.del, { method: 'DELETE' });
      await loadConnections();
    };
  });
}

/* ── 启动 ─────────────────────────────────────────────── */
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
}

boot();
