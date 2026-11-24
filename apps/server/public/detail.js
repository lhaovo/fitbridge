/* FitBridge · 活动详情弹层
 *
 * 没有引入图表库：轨迹图与指标图都是手写 SVG。
 *  - 轨迹投影：等距圆柱 + 按纬度 cos 修正，并保持等比例（x/y 同一 scale），
 *    这样叠加跨平台轨迹时形状不会被拉伸。
 *  - 指标图：min/max 归一化到 viewBox，坐标轴标签直接画在 SVG 里。
 *
 * 弹层用原生 <dialog> + showModal()：背景 inert、焦点收敛、top layer、
 * ::backdrop、Esc 关闭、关闭后焦点回到触发按钮 —— 这些都由浏览器负责，
 * 不需要手写 role="dialog" / aria-modal / 焦点陷阱 / Esc 监听。
 */

const DETAIL = {
  id: null,
  act: null,
  files: [],
  track: null,
  related: [],
  /** 已叠加对比的其它平台轨迹 */
  overlays: [],
};

const CHART_COLOR = {
  speed: '#3b82f6',
  hr: '#ef4444',
  power: '#22c55e',
  cadence: '#a855f7',
  alt: '#f59e0b',
};

const TZ_SOURCE_LABEL = {
  platform: '平台给出',
  'file-local-timestamp': 'FIT 文件',
  unknown: '未知',
};

const dnum = (v, d = 0) =>
  v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toFixed(d);
const dkmh = (mps) =>
  mps === null || mps === undefined || !isFinite(mps) ? '—' : (mps * 3.6).toFixed(1);

/* ── 弹层 ───────────────────────────────────────────────── */
/**
 * 弹层节点按需创建。
 * 放在 document.body 下（不在 #app 里），所以主界面重渲染不会把它冲掉。
 */
function ensureModal() {
  let m = document.getElementById('modal');
  if (m) return m;
  m = document.createElement('dialog');
  m.id = 'modal';
  m.className = 'modal';
  // 点遮罩关闭（Esc 由原生处理）
  m.setAttribute('closedby', 'any');
  // 原生 <dialog> 已经提供 role=dialog / aria-modal，
  // 但**可访问名**要自己给：指向标题（<h2 id="modal-title">）
  m.setAttribute('aria-labelledby', 'modal-title');
  m.innerHTML =
    '<div class="modal-card">' +
    '<div class="modal-head">' +
    '<div class="modal-title-wrap">' +
    '<h2 class="modal-title" id="modal-title"></h2>' +
    '<div class="modal-sub" id="modal-sub"></div>' +
    '</div>' +
    '<button type="button" id="modal-close" autofocus>关闭</button>' +
    '</div>' +
    '<div id="modal-body" class="modal-body"></div>' +
    '</div>';
  document.body.appendChild(m);

  m.querySelector('#modal-close').onclick = () => detailClose();
  installLightDismiss(m);
  // Esc 关闭是原生行为（close 事件）；这里只负责收尾
  m.addEventListener('close', () => {
    DETAIL.id = null;
    DETAIL.overlays = [];
  });
  return m;
}

function detailOpen() {
  const m = ensureModal();
  if (!m.open) m.showModal();
}
function detailClose() {
  const m = document.getElementById('modal');
  if (m && m.open) m.close();
}

/* ── 加载 ───────────────────────────────────────────────── */
async function openDetail(id) {
  DETAIL.id = id;
  DETAIL.overlays = [];
  ensureModal();
  const title = document.getElementById('modal-title');
  const sub = document.getElementById('modal-sub');
  const body = document.getElementById('modal-body');
  title.textContent = '加载中…';
  sub.textContent = '';
  body.replaceChildren();
  detailOpen();
  try {
    const enc = encodeURIComponent(id);
    const [a, t, r] = await Promise.all([
      api('/activities/' + enc),
      api('/activities/' + enc + '/track').catch(() => ({ track: null })),
      api('/activities/' + enc + '/related').catch(() => ({ related: [] })),
    ]);
    DETAIL.act = a.activity;
    DETAIL.files = a.files || [];
    DETAIL.track = t.track || null;
    DETAIL.related = r.related || [];
  } catch (e) {
    body.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    return;
  }
  renderDetail();
}

/* ── 渲染 ───────────────────────────────────────────────── */
function renderDetail() {
  const a = DETAIL.act;
  const track = DETAIL.track;
  const sum = (track && track.summary) || {};
  const m = a.metrics || {};

  // 标题：活动名 + 平台（作为 dialog 的可访问名），其余信息放副标题
  const title = document.getElementById('modal-title');
  title.innerHTML =
    '<span class="mtitle">' +
    '<span>' + esc(a.name || '(未命名活动)') + '</span>' +
    '<span class="tag">' + esc(a.source.platformId) + '</span>' +
    (a.rawSportType && a.rawSportType !== a.sportType
      ? '<span class="tag">原始类型 ' + esc(a.rawSportType) + '</span>'
      : '') +
    '</span>';
  document.getElementById('modal-sub').innerHTML =
    esc(fmtTime(a.startTime)) + ' · ' + esc(a.sportType) + ' · ' + esc(a.id);

  document.getElementById('modal-body').innerHTML = [
    statsBlock(a, m, sum),
    flagsBlock(a, track),
    trackBlock(track),
    seriesBlock(track),
    filesBlock(a),
    relatedBlock(),
    rawBlock(a),
  ].join('');

  bindDetailEvents();
}

function statTile(label, value, sub) {
  return (
    '<div class="stat">' +
    '<div class="stat-label">' + esc(label) + '</div>' +
    '<div class="stat-value">' + value + '</div>' +
    (sub ? '<div class="stat-sub">' + sub + '</div>' : '') +
    '</div>'
  );
}

/** 两个来源（本地 FIT vs 平台元数据）不一致时给出对照 */
function diffSub(fitVal, dbVal, fmt) {
  if (fitVal === null || fitVal === undefined) return '';
  if (dbVal === null || dbVal === undefined) return '';
  const rel = Math.abs(fitVal - dbVal) / (Math.abs(dbVal) || 1);
  if (rel < 0.005) return '';
  return '平台值 ' + fmt(dbVal);
}

function statsBlock(a, m, sum) {
  const rows = [];
  rows.push(
    statTile(
      '距离',
      esc(fmtDist(a.distanceMeters)),
      esc(diffSub(sum.distanceMeters, a.distanceMeters, fmtDist)),
    ),
  );
  rows.push(
    statTile(
      '时长',
      esc(fmtDur(a.durationSec)),
      esc(
        sum.durationSec && Math.abs(sum.durationSec - a.durationSec) > 30
          ? 'FIT ' + fmtDur(sum.durationSec)
          : '',
      ),
    ),
  );
  const avgSpeed = sum.avgSpeedMps;
  const derivedAvg =
    a.durationSec > 0 ? a.distanceMeters / a.durationSec : undefined;
  // 主值用「距离/移动时间」（FIT 语义里的 avg_speed）；
  // 只有当它和「距离/总时长（含停表）」差别明显时，才补一行对照。
  const avgSub =
    derivedAvg !== undefined && avgSpeed !== undefined
      ? Math.abs(derivedAvg - avgSpeed) / (avgSpeed || 1) > 0.05
        ? '含停表均速 ' + dkmh(derivedAvg) + ' km/h'
        : ''
      : '';
  rows.push(
    statTile(
      '平均速度',
      avgSpeed !== undefined ? dkmh(avgSpeed) + ' <small>km/h</small>' : '—',
      esc(avgSub),
    ),
  );
  rows.push(
    statTile('最高速度', dkmh(sum.maxSpeedMps) !== '—' ? dkmh(sum.maxSpeedMps) + ' <small>km/h</small>' : '—'),
  );
  rows.push(
    statTile(
      '平均心率',
      dnum(sum.avgHeartRate ?? m.avgHeartRate, 0) !== '—'
        ? dnum(sum.avgHeartRate ?? m.avgHeartRate, 0) + ' <small>bpm</small>'
        : '—',
      esc(
        sum.avgHeartRate && m.avgHeartRate && Math.abs(sum.avgHeartRate - m.avgHeartRate) > 2
          ? '平台 ' + Math.round(m.avgHeartRate) + ' bpm'
          : '',
      ),
    ),
  );
  rows.push(
    statTile(
      '最高心率',
      dnum(sum.maxHeartRate, 0) !== '—' ? dnum(sum.maxHeartRate, 0) + ' <small>bpm</small>' : '—',
    ),
  );
  rows.push(
    statTile(
      '平均功率',
      dnum(sum.avgPower ?? m.avgPower, 0) !== '—'
        ? dnum(sum.avgPower ?? m.avgPower, 0) + ' <small>W</small>'
        : '—',
      esc(
        sum.avgPower && m.avgPower && Math.abs(sum.avgPower - m.avgPower) > 3
          ? '平台 ' + Math.round(m.avgPower) + ' W'
          : '',
      ),
    ),
  );
  rows.push(
    statTile(
      '最高功率',
      dnum(sum.maxPower, 0) !== '—' ? dnum(sum.maxPower, 0) + ' <small>W</small>' : '—',
    ),
  );
  rows.push(
    statTile(
      '平均踏频',
      dnum(sum.avgCadence ?? m.avgCadence, 0) !== '—'
        ? dnum(sum.avgCadence ?? m.avgCadence, 0) + ' <small>rpm</small>'
        : '—',
    ),
  );
  rows.push(
    statTile(
      '累计爬升',
      a.elevationGainMeters !== undefined && a.elevationGainMeters !== null
        ? Math.round(a.elevationGainMeters) + ' <small>m</small>'
        : dnum(sum.elevationGainM, 0) !== '—'
          ? dnum(sum.elevationGainM, 0) + ' <small>m</small>'
          : '—',
    ),
  );
  rows.push(
    statTile(
      '移动时长',
      a.movingTimeSec ? fmtDur(a.movingTimeSec) : '—',
      esc(a.durationSec && a.movingTimeSec ? '静止 ' + fmtDur(a.durationSec - a.movingTimeSec) : ''),
    ),
  );
  return (
    '<h3 class="sec">统计</h3><div class="stats">' + rows.join('') + '</div>'
  );
}

function flagsBlock(a, track) {
  const f = a.flags || {};
  const tags = [];
  const cs = (track && track.coordinateSystem) || f.coordinateSystemOriginal || 'unknown';
  tags.push(
    '<span class="tag ' + (cs === 'gcj02' ? 'warn' : 'ok') + '">文件坐标系 ' + esc(cs) + '</span>',
  );
  if (track && track.convertedTo) {
    tags.push('<span class="tag ok">显示已转 ' + esc(track.convertedTo) + '</span>');
  } else if (cs === 'gcj02') {
    tags.push('<span class="tag warn">未转换</span>');
  }
  if (f.timezoneAdjusted) tags.push('<span class="tag">时区已修正</span>');
  const tzSource = a.timezoneSource || 'unknown';
  if (tzSource !== 'unknown') {
    tags.push(
      '<span class="tag">UTC' + fmtOffset(a.timezoneOffsetMin ?? 0) +
        ' · ' + esc(TZ_SOURCE_LABEL[tzSource] || tzSource) + '</span>',
    );
  } else {
    tags.push('<span class="tag">时区未知</span>');
  }
  if (a.localStartTime) {
    tags.push('<span class="tag">当地 ' + esc(wallClock(a.localStartTime)) + '</span>');
  }
  if (a.syncState) {
    tags.push('<span class="tag ' + (a.syncState === 'synced' ? 'yes' : 'warn') + '">' + esc(a.syncState) + '</span>');
  }
  // 平台 flags 与 FIT 解析的警告常常是同一批字串，这里去重
  // 「轨迹点超过上限」是同步时解析产生的（同步用 5000 点上限省内存），
  // 详情页是完整解析的，所以这条在这里会自相矛盾 —— 过滤掉。
  const fw = [
    ...new Set([...(f.warnings || []), ...((track && track.warnings) || [])]),
  ].filter((w) => !w.includes('轨迹点超过上限'));
  return (
    '<div class="tags" style="margin:2px 0 6px">' + tags.join('') + '</div>' +
    (fw.length
      ? '<div class="notice">' + fw.map((w) => esc(w)).join('<br/>') + '</div>'
      : '')
  );
}

/** 把带偏移的 ISO 显示成「当地墙钟」，不要按浏览器时区二次转换 */
function wallClock(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(:\d{2})?)/.exec(String(iso));
  if (!m) return String(iso);
  return m[1].replace(/-/g, '/') + ' ' + m[2];
}

function fmtOffset(min) {
  const s = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return s + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ── 轨迹图 ─────────────────────────────────────────────── */
function trackBlock(track) {
  const pts = (track && track.track) || [];
  const head =
    '<h3 class="sec">轨迹 <span class="muted" style="font-weight:400;font-size:12.5px">' +
    (track
      ? track.pointCount + ' 个原始点' + (track.sampled ? '（已抽样到 ' + pts.length + ' 点）' : '')
      : '无轨迹') +
    '</span></h3>';
  return head + '<div class="chartbox" id="track-box">' + svgTrack() + '</div>';
}

function svgTrack() {
  const sets = [];
  const mainPts = (DETAIL.track && DETAIL.track.track) || [];
  sets.push({ label: '当前活动', points: mainPts, color: '#3b82f6', width: 2.2 });
  for (const o of DETAIL.overlays) {
    sets.push({ label: o.label, points: o.points, color: '#f59e0b', width: 2, dash: '6 4' });
  }
  const all = [];
  for (const s of sets) {
    for (const p of s.points) {
      if (isFinite(p.lat) && isFinite(p.lon)) all.push(p);
    }
  }
  if (all.length < 2) {
    return '<div class="empty">没有可用轨迹点（FIT 缺失 / 已过保留期 / 解析失败）</div>';
  }

  const W = 880, H = 380, PAD = 20;
  const lats = all.map((p) => p.lat);
  const lons = all.map((p) => p.lon);
  const lat0 = (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const px = lons.map((l) => l * k);
  const minX = Math.min.apply(null, px), maxX = Math.max.apply(null, px);
  const minY = Math.min.apply(null, lats), maxY = Math.max.apply(null, lats);
  const w = Math.max(maxX - minX, 1e-7);
  const h = Math.max(maxY - minY, 1e-7);
  const sc = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (lon) => PAD + (W - PAD * 2) / 2 + (lon * k - cx) * sc;
  const Y = (lat) => PAD + (H - PAD * 2) / 2 - (lat - cy) * sc;

  const paths = [];
  for (const s of sets) {
    const p2 = s.points.filter((p) => isFinite(p.lat) && isFinite(p.lon));
    if (p2.length < 2) continue;
    const d = p2
      .map((p, i) => (i ? 'L' : 'M') + X(p.lon).toFixed(1) + ' ' + Y(p.lat).toFixed(1))
      .join(' ');
    paths.push(
      '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' + s.width +
        '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') +
        ' stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>',
    );
    if (s === sets[0]) {
      const a0 = p2[0], a1 = p2[p2.length - 1];
      paths.push(
        '<circle cx="' + X(a0.lon).toFixed(1) + '" cy="' + Y(a0.lat).toFixed(1) +
          '" r="4" fill="#22c55e" stroke="#0f1115" stroke-width="1.5"/>' +
          '<circle cx="' + X(a1.lon).toFixed(1) + '" cy="' + Y(a1.lat).toFixed(1) +
          '" r="4" fill="#ef4444" stroke="#0f1115" stroke-width="1.5"/>',
      );
    }
  }

  const legend =
    '<div class="legend">' +
    sets
      .map(
        (s) =>
          '<span class="lg"><i style="background:' + s.color + '"></i>' + esc(s.label) +
          '（' + s.points.length + ' 点）</span>',
      )
      .join('') +
    '<span class="lg"><i style="background:#22c55e"></i>起点</span>' +
    '<span class="lg"><i style="background:#ef4444"></i>终点</span>' +
    '</div>';

  return (
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="svg-track" preserveAspectRatio="xMidYMid meet" role="img" aria-label="活动轨迹图">' +
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#12151b" rx="8"/>' +
    paths.join('') +
    '</svg>' + legend
  );
}

/* ── 指标图 ─────────────────────────────────────────────── */
function seriesBlock(track) {
  const series = (track && track.series) || [];
  if (!series.length) return '';
  const cards = series.map((s) => seriesCard(s)).join('');
  return '<h3 class="sec">指标曲线</h3><div class="charts">' + cards + '</div>';
}

function seriesCard(s) {
  const color = CHART_COLOR[s.key] || '#3b82f6';
  return (
    '<div class="chartcard">' +
    '<div class="chart-head"><span>' + esc(s.label) + '</span>' +
    '<span class="muted">均 ' + dnum(s.avg, 1) + ' · ' + esc(s.unit) + '</span></div>' +
    svgSeries(s, color) +
    '</div>'
  );
}

function svgSeries(s, color) {
  const pts = s.points || [];
  if (pts.length < 2) {
    return '<div class="empty" style="padding:14px">无 ' + esc(s.label) + ' 数据</div>';
  }
  const W = 340, H = 108;
  const PL = 6, PR = 44, PT = 10, PB = 18;
  let min = s.min, max = s.max;
  if (!isFinite(min) || !isFinite(max)) return '';
  if (max - min < 1e-6) { max = min + 1; min = min - 1; }
  const tMax = Math.max(pts[pts.length - 1].t, 1);
  const X = (t) => PL + (t / tMax) * (W - PL - PR);
  const Y = (v) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);

  const line = pts
    .map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1))
    .join(' ');
  const area =
    line + ' L ' + X(pts[pts.length - 1].t).toFixed(1) + ' ' + (H - PB) +
    ' L ' + X(pts[0].t).toFixed(1) + ' ' + (H - PB) + ' Z';

  const grid = [0, 0.5, 1]
    .map((r) => {
      const y = PT + r * (H - PT - PB);
      const v = max - r * (max - min);
      return (
        '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) +
        '" stroke="#262b35" stroke-width="1"/>' +
        '<text x="' + (W - PR + 5) + '" y="' + (y + 3.5).toFixed(1) +
        '" fill="#7c869a" font-size="9.5">' + dnum(v, v >= 100 ? 0 : 1) + '</text>'
      );
    })
    .join('');

  return (
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="svg-series" preserveAspectRatio="none" role="img" aria-label="' +
      esc(s.label) + '曲线，最小 ' + dnum(s.min, 1) + '，最大 ' + dnum(s.max, 1) + ' ' + esc(s.unit) + '">' +
    grid +
    '<path d="' + area + '" fill="' + color + '" opacity="0.13"/>' +
    '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<text x="' + PL + '" y="' + (H - 5) + '" fill="#7c869a" font-size="9.5">0</text>' +
    '<text x="' + (W - PR) + '" y="' + (H - 5) + '" fill="#7c869a" font-size="9.5" text-anchor="end">' +
    fmtDur(tMax) + '</text>' +
    '</svg>'
  );
}

/* ── 文件 ───────────────────────────────────────────────── */
function filesBlock(a) {
  const files = DETAIL.files || [];
  const rows = files
    .map((f) => {
      const kb = f.byteSize < 1024 * 1024
        ? (f.byteSize / 1024).toFixed(1) + ' KB'
        : (f.byteSize / 1024 / 1024).toFixed(2) + ' MB';
      return (
        '<tr>' +
        '<td><span class="tag">' + esc(f.kind) + '</span></td>' +
        '<td>' + esc(f.coordinateSystem || 'unknown') + '</td>' +
        '<td>' + kb + '</td>' +
        '<td class="muted" style="font-size:11.5px">' + esc(String(f.sha256).slice(0, 16)) + '…</td>' +
        '<td>' +
        (f.expired
          ? '<span class="tag no">已过期</span>'
          : '<a class="btn-link" href="/api/v1/activities/' + encodeURIComponent(a.id) + '/file">下载</a>') +
        '</td></tr>'
      );
    })
    .join('');
  return (
    '<h3 class="sec">文件</h3>' +
    (files.length
      ? tableWrap(
        '<table class="ftable"><caption class="visually-hidden">本地文件</caption>' +
        '<thead><tr><th scope="col">类型</th><th scope="col">坐标系</th><th scope="col">大小</th>' +
        '<th scope="col">SHA-256</th><th scope="col">操作</th></tr></thead><tbody>' +
        rows + '</tbody></table>',
        '本地文件',
      )
      : '<div class="empty">没有本地文件</div>')
  );
}

/* ── 跨平台关联 ─────────────────────────────────────────── */
function relatedBlock() {
  const rel = DETAIL.related || [];
  const head =
    '<h3 class="sec">跨平台关联活动 <span class="muted" style="font-weight:400;font-size:12.5px">' +
    '时间差 ≤5 分钟且距离差 ≤2%</span></h3>';
  if (!rel.length) {
    return head + '<div class="empty">没有其它平台上的同一条活动</div>';
  }
  const rows = rel
    .map((r) => {
      const ov = DETAIL.overlays.find((o) => o.id === r.id);
      const offset = ov ? ov.offsetText : '';
      return (
        '<tr>' +
        '<td><span class="tag">' + esc(r.platformId) + '</span></td>' +
        '<td>' + esc(r.name || '(未命名)') + '</td>' +
        '<td>' + esc(fmtDist(r.distanceMeters)) + '</td>' +
        '<td>' + (r.distanceDiffPct === 0 ? '—' : dnum(r.distanceDiffPct, 2) + '%') + '</td>' +
        '<td>' + (r.timeDiffSec === 0 ? '—' : Math.round(r.timeDiffSec) + 's') + '</td>' +
        '<td><span class="tag">' + esc(r.coordinateSystem || 'unknown') + '</span></td>' +
        '<td>' + (offset ? '<span class="tag ok">' + esc(offset) + '</span>' : '') + '</td>' +
        '<td class="row end acts">' +
        '<button type="button" data-overlay="' + esc(r.id) + '">' + (ov ? '取消叠加' : '叠加对比') + '</button>' +
        '<button type="button" data-open="' + esc(r.id) + '">打开</button>' +
        '</td></tr>'
      );
    })
    .join('');
  return (
    head +
    tableWrap(
      '<table class="ftable"><caption class="visually-hidden">其它平台上的同一条活动</caption>' +
      '<thead><tr><th scope="col">平台</th><th scope="col">名称</th><th scope="col">距离</th>' +
      '<th scope="col">距离差</th><th scope="col">时间差</th><th scope="col">坐标系</th>' +
      '<th scope="col">叠加偏移</th><th scope="col">操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>',
      '跨平台关联活动',
    )
  );
}

/* ── 原始报文 ───────────────────────────────────────────── */
function rawBlock(a) {
  if (!a.raw) return '';
  let txt;
  try {
    txt = JSON.stringify(a.raw, null, 2);
  } catch {
    return '';
  }
  const clipped = txt.length > 20000;
  const shown = clipped ? txt.slice(0, 20000) + '\n…（已截断）' : txt;
  return (
    '<h3 class="sec">平台原始报文</h3>' +
    '<details class="rawbox"><summary>展开查看 JSON</summary><pre>' + esc(shown) + '</pre></details>'
  );
}

/* ── 事件绑定 ───────────────────────────────────────────── */
function bindDetailEvents() {
  const body = document.getElementById('modal-body');

  body.querySelectorAll('button[data-open]').forEach((b) => {
    b.onclick = () => openDetail(b.dataset.open);
  });

  body.querySelectorAll('button[data-overlay]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.overlay;
      const idx = DETAIL.overlays.findIndex((o) => o.id === id);
      if (idx >= 0) {
        DETAIL.overlays.splice(idx, 1);
        renderDetail();
        return;
      }
      b.disabled = true;
      b.textContent = '加载中…';
      try {
        const r = await api('/activities/' + encodeURIComponent(id) + '/track');
        const other = r.track;
        if (!other || !other.track || other.track.length < 2) {
          toast('该活动没有可用轨迹', 'warn');
          renderDetail();
          return;
        }
        const main = (DETAIL.track && DETAIL.track.track) || [];
        const rel = DETAIL.related.find((x) => x.id === id);
        const off = trackOffset(main, other.track);
        DETAIL.overlays.push({
          id,
          label: (rel ? rel.platformId : '对照') + ' 叠加',
          points: other.track,
          offsetText: off ? '平均 ' + off.avg + 'm' : '',
          offset: off,
        });
        renderDetail();
      } catch (e) {
        toast(e.message, 'err');
        renderDetail();
      }
    };
  });
}

/**
 * 两条轨迹的对应点平均偏移（米）。
 * 用时间对齐（同一秒的点配对），可以直接看出 GCJ-02 是否被正确转换：
 * 同一条骑行两个平台的数据如果差 500 米，说明一边是 GCJ-02、一边是 WGS-84 没对齐。
 */
function trackOffset(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return null;
  const map = new Map();
  for (const p of b) map.set(p.t, p);
  let sum = 0, n = 0, max = 0;
  for (const p of a) {
    const q = map.get(p.t);
    if (!q) continue;
    const d = haversine(p.lat, p.lon, q.lat, q.lon);
    sum += d;
    if (d > max) max = d;
    n++;
  }
  if (!n) return null;
  return { avg: Math.round(sum / n), max: Math.round(max), n };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
