/* FitBridge 控制台 */
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

/* ── 登录 ─────────────────────────────────────────────── */
function renderLogin(msg) {
  document.body.innerHTML = `
    <div class="login card">
      <h3 style="margin-bottom:2px">FitBridge</h3>
      <p class="hint" style="margin-bottom:14px">多平台运动数据同步 · 单用户自托管</p>
      <label>管理员密码</label>
      <input id="pwd" type="password" autocomplete="current-password" />
      <div class="err" id="err"></div>
      <div class="row end" style="margin-top:12px"><button class="primary" id="go">登录</button></div>
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

/* ── 主框架 ───────────────────────────────────────────── */
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

      <h1>同步</h1>
      <p class="hint">选择来源与目标平台 → 先「预览」确认影响面，再执行。目标平台仅在已连接且支持上传时可选。</p>
      <div class="card">
        <div class="row" style="gap:16px;align-items:flex-start">
          <div style="flex:1;min-width:260px">
            <label>来源平台（可多选）</label>
            <div id="src-list" class="chips"></div>
          </div>
          <div style="flex:1;min-width:260px">
            <label>同步模式</label>
            <div class="chips" id="mode-list">
              <label class="chip"><input type="radio" name="sync-mode" value="local" checked /> 仅同步到本地库</label>
              <label class="chip"><input type="radio" name="sync-mode" value="upload" /> 同时上传到目标平台</label>
            </div>
          </div>
        </div>
        <div id="dst-wrap" style="display:none;margin-top:14px">
          <label>目标平台（可多选，仅在「同时上传」模式下生效）</label>
          <div id="dst-list" class="chips"></div>
        </div>
        <div class="row" style="margin-top:14px">
          <label style="margin:0">条数上限</label>
          <input id="max-items" type="number" value="50" min="1" max="500" style="width:90px" />
          <label class="chip" style="margin-left:6px"><input type="checkbox" id="force" /> 全量重拉</label>
          <div class="spacer" style="flex:1"></div>
          <button id="dry">预览（不写入）</button>
          <button class="primary" id="run">同步到本地库</button>
        </div>
        <div class="muted" style="margin-top:10px;font-size:12.5px">
          <b>增量</b>：默认只查「上次成功同步时间 − 24 小时回看窗口」内的新活动（平台列表是时间倒序，遇到更早的就停止翻页）。
          所以平时点同步可能显示「发现 0 条」—— 那就是没有新活动，属正常。需要重新拉全部历史请勾选「全量重拉」。
        </div>
        <div class="muted" style="margin-top:6px;font-size:12.5px">
          <b>去重三层</b>：① 来源唯一键（用户 + 平台 + 活动ID，数据库 UNIQUE 约束强制）② 目标侧 external_id 幂等键
          ③ 上传前目标列表软存在检查。<b>已同步过的活动会被自动跳过，不会重复下载或重复上传；文件按内容哈希去重存储。</b>
        </div>
        <div id="sync-out" class="out"></div>
      </div>

      <h1>活动库</h1>
      <p class="hint">跨平台统一运动库。元数据常驻；原始文件按保留期清理。</p>
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <input id="fq" placeholder="搜索名称 / ID" style="width:220px" />
          <select id="fplatform" style="width:160px"></select>
          <select id="fsport" style="width:140px">
            <option value="">全部类型</option>
            <option value="ride">骑行</option>
            <option value="run">跑步</option>
            <option value="swim">游泳</option>
            <option value="hiking">徒步</option>
            <option value="other">其他</option>
          </select>
          <input id="fsince" type="date" style="width:150px" />
          <input id="funtil" type="date" style="width:150px" />
          <button id="fgo">筛选</button>
          <button id="freset">重置</button>
          <div class="spacer" style="flex:1"></div>
          <span id="ftotal" class="badge"></span>
        </div>
        <div id="acts"></div>
      </div>

      <h1>本地库</h1>
      <p class="hint">元数据常驻 SQLite；原始文件按保留期清理（到期删文件、保留账本）。</p>
      <div class="card" id="storage"></div>

      <h1>平台</h1>
      <p class="hint">能力矩阵由各适配器的 manifest 声明渲染。点击平台卡片可连接账号。</p>
      <div class="grid" id="platforms"></div>

      <h1>已连接账号</h1>
      <div class="card" id="conns"></div>

      <h1>运行事件</h1>
      <div class="card" id="events"></div>
    </div>`;

  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); renderLogin(); };
  $('#dry').onclick = () => runSync(true);
  $('#run').onclick = () => runSync(false);
  $$('input[name=sync-mode]').forEach((r) => {
    r.onchange = () => applySyncMode();
  });
  applySyncMode();
  $('#fgo').onclick = () => { readFilters(); loadActivities(); };
  $('#freset').onclick = () => {
    $('#fq').value = ''; $('#fplatform').value = ''; $('#fsport').value = '';
    $('#fsince').value = ''; $('#funtil').value = '';
    state.filters = { q: '', platform: '', sport: '', since: '', until: '' };
    loadActivities();
  };
  $$('#fq,#fplatform,#fsport,#fsince,#funtil').forEach((el) => {
    el.onkeydown = (e) => { if (e.key === 'Enter') { readFilters(); loadActivities(); } };
  });

  loadHealth();
  renderPlatforms();
  loadConnections();
  loadActivities();
  loadEvents();
  loadStorage();
  setInterval(loadEvents, 8000);
  setInterval(loadStorage, 30000);
}

/** 同步模式：仅本地库 / 同时上传 */
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

/* ── 同步 ─────────────────────────────────────────────── */
function renderSyncChips() {
  const src = $('#src-list'), dst = $('#dst-list');
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
          incremental: !$('#force').checked,
          lookbackHours: $('#force').checked ? 24 * 365 * 10 : 24,
        },
      },
    });
    const s = data.summary;
    const dupSkipped = Object.values(s.perPlatform).reduce((a, v) => a + v.skipped, 0);
    out.innerHTML = `
      <div class="ok-msg">${dry ? '预览完成（未写入任何数据）' : '同步完成'}</div>
      <div class="row" style="margin:8px 0">
        <span class="tag">发现 ${s.discovered}</span>
        <span class="tag yes">新增 ${s.downloaded}</span>
        <span class="tag ${dupSkipped ? 'warn' : ''}">跳过 ${s.skipped}${dupSkipped ? '（已存在·去重命中）' : ''}</span>
        ${s.failed ? `<span class="tag no">失败 ${s.failed}</span>` : ''}
        ${s.uploaded ? `<span class="tag yes">上传 ${s.uploaded}</span>` : ''}
        ${s.uploadFailed ? `<span class="tag no">上传失败 ${s.uploadFailed}</span>` : ''}
      </div>
      <table><thead><tr><th>平台</th><th>发现</th><th>新增</th><th>跳过(去重)</th><th>失败</th><th>上传</th><th>上传失败</th></tr></thead>
      <tbody>${Object.entries(s.perPlatform).map(([k, v]) => `<tr>
        <td>${esc(k)}${v.error ? ' <span class="tag warn">' + esc(v.error) + '</span>' : ''}</td>
        <td>${v.discovered}</td><td>${v.downloaded}</td><td>${v.skipped}</td>
        <td>${v.failed}</td><td>${v.uploaded}</td><td>${v.uploadFailed}</td></tr>`).join('')}</tbody></table>
      ${s.errors.length ? '<div class="err" style="margin-top:10px">' + s.errors.map(esc).join('<br/>') + '</div>' : ''}
      <div class="muted" style="margin-top:8px">runId: ${esc(s.runId)}</div>`;
    if (!dry) { loadActivities(); loadEvents(); loadStorage(); }
  } catch (e) {
    out.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  } finally {
    state.busy = false;
    $('#run').disabled = false; $('#dry').disabled = false;
  }
}

/* ── 活动库 ───────────────────────────────────────────── */
async function loadActivities() {
  const p = new URLSearchParams();
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.platform) p.set('platform', state.filters.platform);
  if (state.filters.sport) p.set('sport', state.filters.sport);
  if (state.filters.since) p.set('since', state.filters.since);
  if (state.filters.until) p.set('until', state.filters.until);
  p.set('limit', '200');

  const box = $('#acts');
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

  box.innerHTML = '<table><thead><tr><th>时间</th><th>名称</th><th>来源</th><th>距离</th><th>时长</th><th>类型</th><th>指标</th><th>已同步</th><th></th></tr></thead><tbody>' +
    state.activities.map((a) => {
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
          <button data-view="${esc(a.id)}">详情</button>
          <a class="btn-link" href="/api/v1/activities/${esc(a.id)}/file">下载</a>
          <button data-del="${esc(a.id)}">删除</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table>';

  $$('button[data-view]').forEach((b) => {
    b.onclick = () => openDetail(b.dataset.view);
  });

  $$('button[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这条本地活动副本？')) return;
      await api('/activities/' + b.dataset.del, { method: 'DELETE' });
      loadActivities();
    };
  });
}

/* ── 本地库状态 ───────────────────────────────────────── */
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
    ${st.byPlatform.length ? `
    <table style="margin-top:14px"><thead><tr><th>来源平台</th><th>活动</th><th>文件</th><th>占用</th></tr></thead><tbody>
    ${st.byPlatform.map((b) => `<tr>
      <td>${esc(b.platformId)}</td><td>${b.activities}</td><td>${b.files}</td><td>${kb(b.sizeBytes)}</td>
    </tr>`).join('')}
    </tbody></table>` : '<div class="empty">还没有数据</div>'}`;
}

/* ── 事件 ─────────────────────────────────────────────── */
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
  box.innerHTML = '<table><thead><tr><th>时间</th><th>级别</th><th>分类</th><th>平台</th><th>消息</th></tr></thead><tbody>' +
    state.events.map((e) => `<tr>
      <td style="white-space:nowrap;font-size:12px">${esc(fmtTime(e.created_at))}</td>
      <td><span class="badge ${e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'ok'}">${esc(e.level)}</span></td>
      <td>${esc(e.category)}</td>
      <td>${esc(e.platform_id || '—')}</td>
      <td>${esc(e.message)}</td>
    </tr>`).join('') + '</tbody></table>';
}

/* ── 平台 / 连接 ──────────────────────────────────────── */
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
          <div class="row end" style="margin-top:12px"><button class="primary" type="submit">连接</button></div>
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
  box.innerHTML = '<table><thead><tr><th>平台</th><th>状态</th><th>最近校验</th><th>创建时间</th><th></th></tr></thead><tbody>' +
    state.connections.map((c) => `<tr>
      <td>${esc(c.platformId)}</td>
      <td><span class="badge ${c.status === 'active' ? 'ok' : 'warn'}">${esc(c.status)}</span></td>
      <td>${esc(c.lastValidatedAt || '—')}</td>
      <td>${esc(c.createdAt || '—')}</td>
      <td class="row end">
        <button data-val="${esc(c.id)}">校验</button>
        <button data-rel="${esc(c.id)}">重新登录</button>
        <button data-del="${esc(c.id)}">删除</button>
      </td></tr>`).join('') + '</tbody></table>';

  $$('button[data-val]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '校验中…';
      try {
        const r = await api('/connections/' + b.dataset.val + '/validate', { method: 'POST' });
        alert(r.ok ? '凭证有效' : '凭证无效：' + (r.reason || ''));
        await loadConnections();
      } catch (e) { alert(e.message); }
      finally { b.disabled = false; b.textContent = '校验'; }
    };
  });
  $$('button[data-rel]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '登录中…';
      try {
        await api('/connections/' + b.dataset.rel + '/relogin', { method: 'POST' });
        await loadConnections();
      } catch (e) { alert(e.message); }
      finally { b.disabled = false; b.textContent = '重新登录'; }
    };
  });
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
  await loadConnections();
}

boot();
