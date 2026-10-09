/* homeTrend 프론트엔드 — 해시 라우팅 + Chart.js */
const app = document.getElementById('app');
const state = { meta: null, overview: {}, raw: {}, charts: [], sort: { overview: ['chg3m', -1], apts: ['count12m', -1] } };
// 정적 사이트(GitHub Pages): 빌드된 data/*.json을 읽는다. 로컬 서버: /api/* 를 호출한다
const STATIC = !!window.HT_STATIC;
const A = window.Analyze;

// ---------- 유틸 ----------
const api = async (p) => {
  const r = await fetch(p);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

// ---------- 데이터 ----------
const getMeta = () => api(STATIC ? 'data/meta.json' : '/api/meta');
const getOverview = (code) => api(STATIC ? `data/overview/${code}.json` : `/api/overview/${code}`);

const dateStr = (n) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
function unpack(p, months) {
  const yms = p.yms.slice(-months);
  const from = Number(yms[0] + '01');
  const apts = p.apts;
  const trades = p.t.filter((r) => r[1] >= from).map(([i, d, a, floor, price, direct]) => ({
    dong: apts[i][0], apt: apts[i][1], built: apts[i][2], jibun: apts[i][3],
    date: dateStr(d), area: a / 100, floor, price, kind: direct ? '직거래' : '중개거래',
  }));
  const rents = p.j.filter((r) => r[1] >= from).map(([i, d, a, floor, deposit]) => ({
    dong: apts[i][0], apt: apts[i][1], built: apts[i][2],
    date: dateStr(d), area: a / 100, floor, deposit, monthly: 0,
  }));
  return { yms, trades, rents };
}
// 지역 원본은 한 번 받아 메모리에 두고, 지역·단지 화면 모두 여기서 계산
async function getRaw(code, months) {
  const k = `${code}:${months}`;
  if (!state.raw[k]) {
    state.raw[k] = (STATIC
      ? (state.raw[code] ||= api(`data/region/${code}.json`)).then((p) => unpack(p, months))
      : api(`/api/raw/${code}?months=${months}`).then((p) => unpack(p, months))
    ).catch((e) => { delete state.raw[k]; delete state.raw[code]; throw e; });
  }
  return state.raw[k];
}
// brokerOnly: 직거래(가족 간 거래 등 시세와 동떨어질 수 있는 거래)를 빼고 계산
async function getRegion(code, months, brokerOnly) {
  const raw = await getRaw(code, months);
  const trades = brokerOnly ? raw.trades.filter((t) => t.kind !== '직거래') : raw.trades;
  return { ...A.regionSummary(raw.yms, trades, raw.rents), apartments: A.apartmentList(trades) };
}
async function getApt(code, key, months) {
  const { yms, trades, rents } = await getRaw(code, months);
  const t = A.markBulk(trades.filter((x) => A.aptKey(x) === key)).sort((a, b) => a.date.localeCompare(b.date));
  if (!t.length) throw new Error('해당 기간에 거래가 없는 단지입니다');
  if (t.every((x) => x.bulk)) throw new Error('해당 기간에 일괄 거래(통매각)만 있어 시세를 계산할 수 없는 단지입니다');
  const r = rents.filter((x) => A.aptKey(x) === key).sort((a, b) => a.date.localeCompare(b.date));
  const last = t[t.length - 1];
  return {
    apt: { key, name: last.apt, dong: last.dong, jibun: last.jibun, built: last.built },
    ...A.apartmentDetail(yms, t, r),
    trades: t,
    rents: r,
  };
}
// 정적 사이트는 빌드한 기간까지만 선택 가능
const monthOpts = (opts) => (STATIC ? opts.filter(([m]) => m <= state.meta.months) : opts);

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PYEONG = 3.305785;

function fmtEok(v) { // 만원 → "12억 3,000"
  if (v == null) return '–';
  v = Math.round(v);
  const eok = Math.floor(v / 10000), rest = v % 10000;
  if (!eok) return `${rest.toLocaleString()}만`;
  return rest ? `${eok}억 ${rest.toLocaleString()}` : `${eok}억`;
}
const fmtMan = (v) => (v == null ? '–' : `${Math.round(v).toLocaleString()}만`);
const fmtPct = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
function delta(x, d = 1) {
  if (x == null) return '<span class="muted">–</span>';
  if (Math.abs(x) * 100 < 0.5 * 10 ** -d) return `<span class="muted">${(0).toFixed(d)}%</span>`;
  return x > 0 ? `<span class="up">▲ ${(x * 100).toFixed(d)}%</span>` : `<span class="down">▼ ${(-x * 100).toFixed(d)}%</span>`;
}
const fmtYm = (ym) => (ym ? `${ym.slice(2, 4)}.${ym.slice(4)}` : '–');
const ymTs = (ym) => Date.UTC(+ym.slice(0, 4), +ym.slice(4) - 1, 15);
const tsLabel = (v) => { const d = new Date(v); return `${String(d.getUTCFullYear()).slice(2)}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const phaseChip = (p) => (p ? `<span class="phase" title="${esc(p.note)}"><b>${p.id ? `${p.id}국면 ` : ''}${esc(p.name)}</b><span class="muted">${esc(p.desc)}</span></span>` : '<span class="muted">–</span>');

// 관심단지 (브라우저 저장). seen: 마지막으로 확인한 거래일 → 그 뒤 거래를 '새 거래'로 표시
const watch = {
  list() { try { return JSON.parse(localStorage.getItem('homeTrend.watch')) || []; } catch (_) { return []; } },
  save(l) { try { localStorage.setItem('homeTrend.watch', JSON.stringify(l)); } catch (_) { /* 저장 불가 */ } },
  has(code, key) { return this.list().some((w) => w.code === code && w.key === key); },
  toggle(item) {
    let l = this.list();
    l = this.has(item.code, item.key) ? l.filter((w) => !(w.code === item.code && w.key === item.key)) : [...l, item];
    this.save(l);
    return this.has(item.code, item.key);
  },
  markSeen(code, key, date) {
    const l = this.list();
    const w = l.find((x) => x.code === code && x.key === key);
    if (w && date && !(w.seen >= date)) { w.seen = date; this.save(l); }
  },
};

function sparkline(values, w = 110, h = 28) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = values.map((x, i) => (x == null ? null : `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - ((x - min) / span) * (h - 4)).toFixed(1)}`)).filter(Boolean);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${css('--series-1')}" stroke-width="1.5" stroke-linejoin="round" points="${pts.join(' ')}"/></svg>`;
}

// ---------- 차트 ----------
function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation = false;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: css('--surface'), titleColor: css('--ink'), bodyColor: css('--ink-2'),
    borderColor: css('--border'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
  });
}
function makeChart(canvas, cfg) {
  const c = new Chart(canvas, cfg);
  state.charts.push(c);
  return c;
}
function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }

// 거래가 몇 달 안에 몰린 단지도 눈금이 겹치지 않게: 최소 6개월 폭을 두고, 같은 달 눈금은 한 번만 쓴다
const MIN_SPAN = 183 * 864e5;
const timeAxis = {
  type: 'linear', grid: { display: false },
  ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (v, i, ticks) => (i && tsLabel(ticks[i - 1].value) === tsLabel(v) ? '' : tsLabel(v)) },
  afterDataLimits: (s) => { const pad = (MIN_SPAN - (s.max - s.min)) / 2; if (pad > 0) { s.min -= pad; s.max += pad; } },
};
const legend = (items) => `<div class="legend">${items.map(([label, color, dot]) => `<span><i class="${dot ? 'dot' : ''}" style="background:${color}"></i>${label}</span>`).join('')}</div>`;

// ---------- 라우터 ----------
// 화면이 바뀌면 routeId가 증가 → 늦게 도착한 이전 화면의 응답은 버린다
state.routeId = 0;
const isStale = (id) => id !== state.routeId;

async function route() {
  const id = ++state.routeId;
  if (!state.keepView) destroyCharts(); // 기간 변경 중엔 기존 차트를 남겨두고, 새로 그릴 때 정리
  chartDefaults();
  try {
    if (!state.meta) {
      state.meta = await getMeta();
      const live = (state.meta.source || state.meta.mode) === 'live';
      const b = document.getElementById('mode');
      b.textContent = live ? '국토부 실거래 데이터' : '데모 데이터 (실제 시세 아님)';
      if (STATIC && state.meta.builtAt) {
        const t = new Date(state.meta.builtAt);
        b.textContent += ` · ${t.getMonth() + 1}/${t.getDate()} 갱신`;
      }
      b.className = 'badge' + (live ? '' : ' demo');
    }
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const view = parts[0];
    const tab = view === 'r' || view === 'a' ? regionOf(parts[1])?.group
      : view === 'watch' ? 'watch'
      : view === 'g' && parts[1] ? parts[1] : '서울';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    if (view === 'r') await viewRegion(parts[1], id);
    else if (view === 'a') await viewApt(parts[1], parts.slice(2).join('/'), id);
    else if (view === 'watch') await viewWatch(id);
    else await viewOverview(tab, id);
  } catch (e) {
    if (!isStale(id)) app.innerHTML = `<div class="card err">불러오지 못했습니다: ${esc(e.message)}</div>`;
  }
  state.keepView = false; // 화면이 showLoading 전에 실패해도 다음 화면에 넘어가지 않게
  if (!isStale(id)) document.body.classList.remove('busy');
}
const regionOf = (code) => state.meta.regions.find((r) => r.code === code);
function requireRegion(code) {
  const r = regionOf(code);
  if (!r) throw new Error(`알 수 없는 지역 코드: ${code}`);
  return r;
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', route);

// ---------- 개요: 지역별 비교 ----------
const OV_COLS = [
  ['name', '지역', (r) => r.name, (r) => `<a href="#/r/${r.code}">${esc(r.name)}</a>`],
  ['current', '평당가 (3개월 평균)', (r) => r.ind?.current, (r) => fmtMan(r.ind?.current)],
  ['eq84', '84㎡ 환산', (r) => r.ind?.current, (r) => (r.ind?.current ? fmtEok(Math.round(r.ind.current * 84 / PYEONG / 100) * 100) : '–')],
  ['chg3m', '3개월', (r) => r.ind?.chg3m, (r) => delta(r.ind?.chg3m)],
  ['chg12m', '12개월', (r) => r.ind?.chg12m, (r) => delta(r.ind?.chg12m)],
  ['fromPeak', '5년 고점 대비', (r) => r.ind?.fromPeak, (r) => (r.ind ? `${delta(r.ind.fromPeak)} <span class="muted">${fmtYm(r.ind.peakYm)}</span>` : '–')],
  ['volVsAvg', '거래량 (장기평균 대비)', (r) => r.ind?.volVsAvg, (r) => (r.ind ? `${r.ind.volRecent}건/월 ${delta(r.ind.volVsAvg, 0)}` : '–')],
  ['newHighShare', '신고가 비율', (r) => r.ind?.newHighShare, (r) => fmtPct(r.ind?.newHighShare, 0)],
  ['jeonseRatio', '전세가율', (r) => r.ind?.jeonseRatio, (r) => fmtPct(r.ind?.jeonseRatio, 0)],
  ['phase', '국면', (r) => r.ind?.phase?.id, (r) => (r.error ? `<span class="err" title="${esc(r.error)}">오류</span>` : r.ind ? phaseChip(r.ind.phase) : '<span class="muted">불러오는 중…</span>')],
  ['spark', '24개월 추이', null, (r) => (r.series ? sparkline(r.series.slice(-24).map((s) => s.ma)) : '')],
];

function sortRows(rows, cols, [key, dir]) {
  const col = cols.find((c) => c[0] === key);
  if (!col || !col[2]) return rows;
  return [...rows].sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * dir;
  });
}
function tableHead(cols, sortKey, [key, dir]) {
  return `<tr>${cols.map(([k, label, getter], i) => `<th class="${i === 0 ? 'l' : ''} ${k === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}" data-sort="${getter ? k : ''}" data-table="${sortKey}">${label}</th>`).join('')}</tr>`;
}
function bindSort(root, sortKey, rerender) {
  root.querySelectorAll(`th[data-table="${sortKey}"]`).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (!k) return;
    const [cur, dir] = state.sort[sortKey];
    // 이름·하락폭은 오름차순(가나다, 많이 빠진 순)부터, 나머지는 큰 값부터
    const firstDir = ['name', 'apt', 'dong', 'fromPeak'].includes(k) ? 1 : -1;
    state.sort[sortKey] = [k, cur === k ? -dir : firstDir];
    rerender();
  }));
}

async function viewOverview(group, id) {
  const regions = state.meta.regions.filter((r) => r.group === group);
  // 지난번에 실패한 지역은 다시 시도
  regions.forEach((r) => { if (state.overview[r.code]?.error) delete state.overview[r.code]; });
  app.innerHTML = `
    <h1>${esc(group)} 지역별 시세 트렌드</h1>
    <p class="sub">실거래 평당가의 3개월 이동평균 기준 (단지 구성 보정, 신고 진행 중인 지난달·통매각 같은 일괄 거래 제외). 거래량은 최근 3개월을 36개월 평균과 비교해요. 지역을 누르면 단지별로 볼 수 있어요.</p>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">국면 지도 — 가격 변화 × 거래량 (최근 3개월)</h2><span class="spacer"></span><label class="muted" style="font-size:12px"><input type="checkbox" id="trail" ${state.trail ? 'checked' : ''}> 모든 지역 이동 경로</label></div>
      <p class="muted" style="margin:0 0 10px;font-size:12px">벌집순환모형: 거래량이 먼저 움직이고 가격이 따라옵니다. 오른쪽 아래(불황)→가운데 오른쪽(회복진입)→오른쪽 위(회복) 순서로 옮겨가는 지역을 주목하세요. 점에 마우스를 올리면 6개월 전 → 3개월 전 → 지금 이동 경로가 보여요.</p>
      <p class="muted" style="margin:-4px 0 10px;font-size:12px">신고가 비율: 최근 3개월 거래 중 같은 단지·평형의 이전 최고가를 넘은 거래 비중. 시장이 달아오르면 가장 먼저 올라가요.</p>
      <div class="chart-box tall"><canvas id="phaseMap"></canvas></div>
    </div>
    <div class="card table-wrap"><table><thead></thead><tbody></tbody></table></div>`;

  const rows = regions.map((r) => ({ ...r, ...(state.overview[r.code] || {}) }));
  const thead = app.querySelector('thead'), tbody = app.querySelector('tbody');
  const render = () => {
    thead.innerHTML = tableHead(OV_COLS, 'overview', state.sort.overview);
    tbody.innerHTML = sortRows(rows, OV_COLS, state.sort.overview)
      .map((r) => `<tr class="link" data-href="#/r/${r.code}">${OV_COLS.map(([, , , f], i) => `<td class="${i === 0 ? 'l' : ''}">${f(r)}</td>`).join('')}</tr>`).join('');
    bindSort(app, 'overview', render);
  };
  tbody.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });

  const map = phaseMap(document.getElementById('phaseMap'));
  const refreshMap = () => {
    const pts = rows.filter((r) => r.ind?.chg3m != null && r.ind?.volVsAvg != null)
      .map((r) => ({ x: r.ind.volVsAvg * 100, y: r.ind.chg3m * 100, label: r.name.replace(/ \(.+\)/, ''), code: r.code, phase: r.ind.phase,
        trail: (r.ind.trail || []).map((t) => ({ x: t.volVsAvg * 100, y: t.chg3m * 100, ym: t.ym })) }));
    map.data.datasets[0].data = pts;
    map.data.datasets[1].data = state.trail ? pts.flatMap((p) => p.trail) : []; // 전체 경로를 볼 때만 축 범위에 넣는다
    map.update('none');
  };
  document.getElementById('trail').addEventListener('change', (e) => { state.trail = e.target.checked; refreshMap(); });
  render(); refreshMap();

  let i = 0;
  const todo = rows.filter((r) => !r.ind && !r.error);
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < todo.length) {
      const r = todo[i++];
      try {
        const d = await getOverview(r.code);
        state.overview[r.code] = { ind: d.indicators, series: d.series };
      } catch (e) {
        state.overview[r.code] = { error: e.message };
      }
      Object.assign(r, state.overview[r.code]);
      if (isStale(id)) return; // 다른 화면으로 이동함
      render(); refreshMap();
    }
  }));
}

function phaseMap(canvas) {
  const quadrants = {
    id: 'quadrants',
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x, y } } = c;
      ctx.save();
      ctx.strokeStyle = css('--axis'); ctx.lineWidth = 1;
      const x0 = x.getPixelForValue(0), y0 = y.getPixelForValue(0);
      ctx.beginPath(); ctx.moveTo(x0, a.top); ctx.lineTo(x0, a.bottom); ctx.moveTo(a.left, y0); ctx.lineTo(a.right, y0); ctx.stroke();
      ctx.fillStyle = css('--muted'); ctx.font = `12px ${Chart.defaults.font.family}`;
      // 축이 데이터에 맞춰 잘리므로, 화면에 충분히 보이는 사분면에만 이름을 쓴다
      const wide = (px) => px > 160, tall = (px) => px > 40;
      const [right, left, top, bottom] = [wide(a.right - x0), wide(x0 - a.left), tall(y0 - a.top), tall(a.bottom - y0)];
      ctx.textAlign = 'right';
      if (right && top) ctx.fillText('① 회복기 · 가격↑ 거래↑', a.right - 8, a.top + 16);
      if (right && bottom) ctx.fillText('⑤ 불황기 · 가격↓ 거래↑', a.right - 8, a.bottom - 8);
      ctx.textAlign = 'left';
      if (left && top) ctx.fillText('② 호황기 · 가격↑ 거래↓', a.left + 8, a.top + 16);
      if (left && bottom) ctx.fillText('④ 침체기 · 가격↓ 거래↓', a.left + 8, a.bottom - 8);
      ctx.restore();
      // 이동 경로: 6개월 전 → 3개월 전 → 지금. 전체 보기가 아니면 마우스를 올린 지역만 (축 밖은 잘림)
      ctx.save();
      ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
      ctx.strokeStyle = css('--series-1'); ctx.fillStyle = css('--series-1'); ctx.lineWidth = 1.5;
      for (const p of c.data.datasets[0].data) {
        const one = p.code === c.$hover;
        if (!p.trail?.length || !(state.trail || one)) continue;
        ctx.globalAlpha = one ? 0.9 : 0.3;
        const px = [...p.trail, p].map((t) => [x.getPixelForValue(t.x), y.getPixelForValue(t.y)]);
        ctx.beginPath();
        px.forEach(([px1, py1], i) => ctx[i ? 'lineTo' : 'moveTo'](px1, py1));
        ctx.stroke();
        if (one) {
          ctx.font = `11px ${Chart.defaults.font.family}`; ctx.textAlign = 'center';
          p.trail.forEach((t, i) => {
            ctx.beginPath(); ctx.arc(px[i][0], px[i][1], 3, 0, 7); ctx.fill();
            ctx.fillText(fmtYm(t.ym), px[i][0], px[i][1] - 8);
          });
        }
      }
      ctx.restore();
    },
    // 이름표는 겹치지 않는 자리(오른쪽→왼쪽→위→아래)에만 놓고, 자리가 없으면 생략 (툴팁으로 확인)
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a } = c;
      ctx.save();
      ctx.fillStyle = css('--ink-2'); ctx.font = `12px ${Chart.defaults.font.family}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const pts = c.getDatasetMeta(0).data;
      const R = 6, H = 14;
      const taken = pts.map((p) => [p.x - R, p.y - R, p.x + R, p.y + R]);
      const hit = (b) => b[0] < a.left || b[2] > a.right || b[1] < a.top || b[3] > a.bottom
        || taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
      pts.forEach((p, i) => {
        const text = c.data.datasets[0].data[i].label;
        const w = ctx.measureText(text).width;
        const spots = [[p.x + 8, p.y], [p.x - 8 - w, p.y], [p.x - w / 2, p.y - 13], [p.x - w / 2, p.y + 13]];
        const spot = spots.find(([x, y]) => !hit([x, y - H / 2, x + w, y + H / 2]));
        if (!spot) return;
        taken.push([spot[0], spot[1] - H / 2, spot[0] + w, spot[1] + H / 2]);
        ctx.fillText(text, spot[0], spot[1]);
      });
      ctx.restore();
    },
  };
  // 데이터 범위에 맞추되 0(국면 경계)은 항상 보이게, 양끝에 여백
  const fit = (step, minSpan) => (s) => {
    const lo = Math.min(0, s.min), hi = Math.max(0, s.max);
    const pad = Math.max((hi - lo) * 0.08, minSpan / 2);
    s.min = Math.floor((lo - pad) / step) * step;
    s.max = Math.ceil((hi + pad) / step) * step;
  };
  return makeChart(canvas, {
    type: 'scatter',
    data: { datasets: [
      { data: [], pointRadius: 5, pointHoverRadius: 7, backgroundColor: css('--series-1'), borderColor: css('--surface'), borderWidth: 2 },
      // 경로의 과거 위치 (축 범위 계산에도 포함)
      { data: [], pointRadius: 2, pointHoverRadius: 2, backgroundColor: css('--series-1-soft'), borderWidth: 0 },
    ] },
    options: {
      scales: {
        x: { title: { display: true, text: '거래량 (최근 3개월 vs 36개월 평균, %)' }, grid: { display: false }, afterDataLimits: fit(5, 10) },
        y: { title: { display: true, text: '가격 변화 (3개월, %)' }, afterDataLimits: fit(1, 2) },
      },
      onClick: (e, els) => { if (els[0]?.datasetIndex === 0) location.hash = `#/r/${e.chart.data.datasets[0].data[els[0].index].code}`; },
      onHover: (e, els) => {
        const el = els.find((x) => x.datasetIndex === 0);
        e.native.target.style.cursor = el ? 'pointer' : 'default';
        const code = el ? e.chart.data.datasets[0].data[el.index].code : null;
        if (code !== e.chart.$hover) { e.chart.$hover = code; e.chart.draw(); }
      },
      plugins: { tooltip: { filter: (i) => i.datasetIndex === 0, callbacks: { label: (c) => [`${c.raw.label} · ${c.raw.phase?.name || ''}`, `가격 ${c.raw.y.toFixed(1)}% · 거래량 ${c.raw.x.toFixed(0)}%`] } } },
    },
    plugins: [quadrants],
  });
}

// ---------- 지역 상세 ----------
const BULK_HINT = '10건 이상 — 임대주택 통매각 같은 일괄 거래로 보고 시세·거래량에서 뺐어요';
const APT_COLS = [
  ['apt', '단지', (r) => r.apt, (r) => `${esc(r.apt)}${r.bulk ? ` <span class="tag" title="같은 날 직거래 ${BULK_HINT}">일괄 ${r.bulk}건 제외</span>` : ''}`],
  ['dong', '동', (r) => r.dong, (r) => esc(r.dong)],
  ['built', '준공', (r) => r.built, (r) => r.built || '–'],
  ['count12m', '최근 1년 거래', (r) => r.count12m, (r) => `${r.count12m}건`],
  ['mainArea', '주력 평형', (r) => r.mainArea, (r) => `${r.mainArea}㎡`],
  ['ppy', '평당가', (r) => r.ppy, (r) => fmtMan(r.ppy)],
  ['recentPrice', '최근 시세', (r) => r.recentPrice, (r) => fmtEok(r.recentPrice)],
  ['peakPrice', '기간 내 최고가', (r) => r.peakPrice, (r) => `${fmtEok(r.peakPrice)} <span class="muted">${r.peakDate.slice(2, 7).replace('-', '.')}</span>`],
  ['fromPeak', '최고가 대비', (r) => r.fromPeak, (r) => delta(r.fromPeak)],
  ['lastDate', '최근 거래일', (r) => r.lastDate, (r) => r.lastDate.slice(2).replace(/-/g, '.')],
];

function monthsSeg(cur, opts) {
  return `<div class="seg" id="months">${opts.map(([m, l]) => `<button data-m="${m}" class="${m === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function getMonths(view, opts, def) {
  let v = null;
  try { v = Number(sessionStorage.getItem(`homeTrend.months.${view}`)); } catch (_) { /* 저장소 사용 불가 */ }
  return opts.some(([m]) => m === v) ? v : def;
}
function bindMonths(view) {
  app.querySelectorAll('#months button').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('on')) return;
    try { sessionStorage.setItem(`homeTrend.months.${view}`, b.dataset.m); } catch (_) { /* 무시 */ }
    b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.keepView = true; // 다시 그릴 때 현재 화면을 지우지 않고 흐리게 유지
    route();
  }));
}
// 거래 유형: 전체 / 중개거래만 (직거래 제외). 화면을 옮겨도 유지
function getKind() { try { return sessionStorage.getItem('homeTrend.kind') || 'all'; } catch (_) { return 'all'; } }
function kindSeg(brokerOnly) {
  return `<div class="seg" id="kind" title="직거래에는 가족 간 거래처럼 시세와 동떨어진 거래가 섞일 수 있어요">${[['all', '전체 거래'], ['broker', '중개거래만']].map(([k, l]) => `<button data-k="${k}" class="${(k === 'broker') === brokerOnly ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function bindKind() {
  app.querySelectorAll('#kind button').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('on')) return;
    try { sessionStorage.setItem('homeTrend.kind', b.dataset.k); } catch (_) { /* 무시 */ }
    b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.keepView = true;
    route();
  }));
}
// 데이터를 기다리는 동안: 기간 변경이면 현재 화면을 흐리게, 아니면 로딩 문구
function showLoading(html) {
  document.body.classList.add('busy');
  if (state.keepView) state.keepView = false;
  else app.innerHTML = html;
}
const REGION_MONTHS = [[36, '3년'], [60, '5년'], [120, '10년']];
const APT_MONTHS = [[36, '3년'], [60, '5년'], [120, '10년'], [192, '16년']];

async function viewRegion(code, id) {
  const region = requireRegion(code);
  const opts = monthOpts(REGION_MONTHS);
  const months = getMonths(`region.${code}`, opts, Math.min(60, state.meta.months || 60));
  const brokerOnly = getKind() === 'broker';
  showLoading(`<div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div><h1>${esc(region.name)}</h1><p class="muted">실거래 ${months}개월치 불러오는 중… (처음 보는 기간은 국토부 API 호출로 30초 정도 걸릴 수 있어요)</p>`);
  const d = await getRegion(code, months, brokerOnly);
  if (isStale(id)) return;
  destroyCharts();
  const ind = d.indicators;
  const s = d.series;
  app.innerHTML = `
    <div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div>
    <div class="row"><h1>${esc(region.name)}</h1>${phaseChip(ind.phase)}<span class="spacer"></span>${kindSeg(brokerOnly)}${monthsSeg(months, opts)}</div>
    <p class="sub">평당가 = 전용면적 기준 거래가 ÷ 평 (중위값). 이동평균은 거래된 단지 구성이 달라 생기는 착시를 보정한 값이고, 최근 지표는 신고가 끝난 달까지로 계산해요. 통매각 같은 일괄 거래는 빼고 계산해요.</p>
    <div class="kpis">
      <div class="kpi"><div class="label">평당 매매가</div><div class="value num">${fmtMan(ind.current)}</div><div class="hint">${fmtYm(ind.currentYm)} 기준 · 84㎡ 환산 ${ind.current ? fmtEok(Math.round(ind.current * 84 / PYEONG / 100) * 100) : '–'}</div></div>
      <div class="kpi"><div class="label">3개월 변화</div><div class="value num">${delta(ind.chg3m)}</div><div class="hint">12개월 ${delta(ind.chg12m)}</div></div>
      <div class="kpi"><div class="label">기간 내 고점 대비</div><div class="value num">${delta(ind.fromPeak)}</div><div class="hint">고점 ${fmtYm(ind.peakYm)} · ${fmtMan(ind.peak)}</div></div>
      <div class="kpi"><div class="label">고점 이후 저점 대비</div><div class="value num">${delta(ind.fromLow)}</div><div class="hint">${ind.lowYm ? `저점 ${fmtYm(ind.lowYm)} · ${fmtMan(ind.low)}` : '현재가 고점'}</div></div>
      <div class="kpi"><div class="label">월 거래량 (최근 3개월)</div><div class="value num">${ind.volRecent ?? '–'}건</div><div class="hint">장기평균 ${delta(ind.volVsAvg, 0)} · 직전 3개월 ${delta(ind.volChg, 0)}${brokerOnly ? '' : ` · 직거래 ${fmtPct(ind.directShare, 0)}`}</div></div>
      <div class="kpi"><div class="label">전세가율 (최근 6개월)</div><div class="value num">${fmtPct(ind.jeonseRatio, 0)}</div><div class="hint">평당 전세가 ÷ 평당 매매가</div></div>
      <div class="kpi"><div class="label">신고가 비율 (최근 3개월)</div><div class="value num">${fmtPct(ind.newHighShare, 0)}</div><div class="hint">직전 거래보다 ${ind.upShare != null ? `오름 ${fmtPct(ind.upShare, 0)} · 내림 ${fmtPct(ind.downShare, 0)}` : '–'}</div></div>
    </div>
    ${ind.phase ? `<p class="phase-note card">${ind.phase.id ? `${ind.phase.id}국면 ` : ''}<b>${esc(ind.phase.name)}</b> — ${esc(ind.phase.note)}</p>` : ''}
    <div class="card">
      <h2>평당 매매가 · 전세가 추이</h2>
      ${legend([['매매 월 중위값', css('--series-1-soft'), true], ['매매 3개월 이동평균 (구성 보정)', css('--series-1')], ['전세 3개월 이동평균 (구성 보정)', css('--series-2')]])}
      <div class="chart-box"><canvas id="price"></canvas></div>
    </div>
    <div class="card">
      <h2>월별 매매 거래량</h2>
      <p class="muted" style="margin:-6px 0 8px;font-size:12px">거래량은 가격보다 먼저 움직이는 경향이 있어요. 마지막 달(옅은 막대)은 신고 진행 중이라 덜 잡힙니다.${s.some((r) => r.bulk) ? ' 회색은 통매각 같은 일괄 거래로, 지표 계산에서 뺐어요.' : ''}</p>
      ${legend([['거래', css('--series-1')], ...(s.some((r) => r.bulk) ? [['일괄 거래 (제외)', css('--axis')]] : []), [`장기 평균 ${ind.volLong ?? '–'}건/월 (36개월 중위)`, css('--muted')]])}
      <div class="chart-box short"><canvas id="vol"></canvas></div>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>거래 온도</h2>
        <p class="muted" style="margin:-6px 0 8px;font-size:12px">같은 단지·평형의 이전 거래와 비교 (3개월 이동평균). 신고가·상승 비율이 오르면 과열, 하락 비율이 상승 비율을 넘으면 꺾이는 신호예요.</p>
        ${legend([['신고가', css('--up')], ['직전보다 오름', css('--series-2')], ['직전보다 내림', css('--down')]])}
        <div class="chart-box short"><canvas id="heat"></canvas></div>
      </div>
      <div class="card">
        <h2>전세가율 추이</h2>
        <p class="muted" style="margin:-6px 0 8px;font-size:12px">평당 전세가 ÷ 평당 매매가 (3개월 이동평균). 오르면 매매가와 전세가의 갭이 좁아져 갭투자 수요가 들어오기 쉬워요.</p>
        ${legend([['전세가율', css('--series-2')]])}
        <div class="chart-box short"><canvas id="jr"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지별 시세</h2><span class="spacer"></span><input type="search" id="q" placeholder="단지명·동 검색"></div>
      <div class="table-wrap"><table><thead></thead><tbody></tbody></table></div>
    </div>`;
  bindMonths(`region.${code}`);
  bindKind();

  const labels = s.map((r) => fmtYm(r.ym));
  makeChart(document.getElementById('price'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '매매 중위', data: s.map((r) => r.median), showLine: false, pointRadius: 2.5, pointBackgroundColor: css('--series-1-soft'), pointBorderWidth: 0 },
        { label: '매매 3개월 평균', data: s.map((r) => r.ma), borderColor: css('--series-1'), borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true },
        { label: '전세 3개월 평균', data: s.map((r) => r.jeonseMa), borderColor: css('--series-2'), borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } }, y: { ticks: { callback: (v) => `${v.toLocaleString()}만` }, title: { display: true, text: '만원/평' } } },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtMan(c.raw)}` } } },
    },
  });
  makeChart(document.getElementById('vol'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: '거래', data: s.map((r) => r.count), backgroundColor: s.map((_, i) => (i === s.length - 1 ? css('--series-1-soft') : css('--series-1'))), borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom', barPercentage: 0.8, categoryPercentage: 0.9 },
      { label: '일괄 거래 (제외)', data: s.map((r) => r.bulk || null), backgroundColor: css('--axis'), borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom', barPercentage: 0.8, categoryPercentage: 0.9 },
      { type: 'line', stack: 'avg', label: '장기 평균', data: s.map(() => ind.volLong), borderColor: css('--muted'), borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0 },
    ] },
    options: {
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } }, y: { stacked: true, ticks: { precision: 0 } } },
      plugins: { tooltip: { callbacks: { label: (c) => [
        ` ${c.raw}건${c.dataIndex === s.length - 1 ? ' (신고 진행 중)' : ''}`,
        ` 일괄 거래 ${c.raw}건 (지표에서 제외)`,
        ` 장기 평균 ${c.raw}건 (36개월 중위)`,
      ][c.datasetIndex] } } },
    },
  });

  const roll3 = (xs) => xs.map((_, i) => { const w = xs.slice(Math.max(0, i - 2), i + 1).filter((v) => v != null); return w.length === 3 ? w.reduce((a, b) => a + b) / 3 : null; });
  const done = s.slice(0, -1); // 신고 진행 중인 마지막 달 제외
  const pctAxis = { ticks: { callback: (v) => `${Math.round(v * 100)}%` } };
  const lineDs = (label, data, color) => ({ label, data, borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true });
  const lineOpts = { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: pctAxis },
    plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${fmtPct(c.raw, 0)}` } } } };
  makeChart(document.getElementById('heat'), {
    type: 'line',
    data: { labels: done.map((r) => fmtYm(r.ym)), datasets: [
      lineDs('신고가', roll3(done.map((r) => r.newHigh)), css('--up')),
      lineDs('직전보다 오름', roll3(done.map((r) => r.upShare)), css('--series-2')),
      lineDs('직전보다 내림', roll3(done.map((r) => r.downShare)), css('--down')),
    ] },
    options: lineOpts,
  });
  makeChart(document.getElementById('jr'), {
    type: 'line',
    data: { labels: done.map((r) => fmtYm(r.ym)), datasets: [lineDs('전세가율', done.map((r) => (r.ma && r.jeonseMa ? r.jeonseMa / r.ma : null)), css('--series-2'))] },
    options: lineOpts,
  });

  const thead = app.querySelector('thead'), tbody = app.querySelector('tbody'), q = document.getElementById('q');
  const cols = [...APT_COLS, ['star', '', null, (r) => `<button class="star ${watch.has(code, r.key) ? 'on' : ''}" data-key="${esc(r.key)}" title="관심단지">★</button>`]];
  const render = () => {
    const term = q.value.trim();
    const rows = d.apartments.filter((r) => !term || r.apt.includes(term) || r.dong.includes(term));
    thead.innerHTML = tableHead(cols, 'apts', state.sort.apts);
    tbody.innerHTML = sortRows(rows, cols, state.sort.apts).slice(0, 300)
      .map((r) => `<tr class="link" data-href="#/a/${code}/${encodeURIComponent(r.key)}">${cols.map(([, , , f], i) => `<td class="${i < 2 ? 'l' : ''}">${f(r)}</td>`).join('')}</tr>`).join('');
    bindSort(app, 'apts', render);
  };
  q.addEventListener('input', render);
  tbody.addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (star) {
      const a = d.apartments.find((x) => x.key === star.dataset.key);
      star.classList.toggle('on', watch.toggle({ code, key: a.key, name: a.apt, region: region.name, seen: a.lastDate }));
      return;
    }
    const tr = e.target.closest('tr[data-href]');
    if (tr) location.hash = tr.dataset.href;
  });
  render();
}

// ---------- 단지 상세 ----------
async function viewApt(code, key, id) {
  const region = requireRegion(code);
  const opts = monthOpts(APT_MONTHS);
  const months = getMonths(`apt.${code}.${key}`, opts, 36);
  showLoading(`<div class="crumb"><a href="#/r/${code}">${esc(region.name)}</a> ›</div><p class="muted">불러오는 중… (처음 보는 기간은 30초 정도 걸릴 수 있어요)</p>`);
  const d = await getApt(code, key, months);
  if (isStale(id)) return;
  destroyCharts();
  const { apt } = d;
  const areaKey = `${code}:${key}`; // 다른 구에 같은 동·단지명이 있을 수 있어 지역 코드까지 포함
  let areaSel = state.aptArea?.[areaKey] || d.areas[0].area;
  if (!d.areas.some((a) => a.area === areaSel)) areaSel = d.areas[0].area;

  // 네이버는 통합검색의 부동산 박스(매물 수·호가)가 가장 확실하고, 호갱노노는 단지명 검색을 URL로 받는다.
  // KB·국토부는 검색어를 URL로 넘길 수 없어 클릭할 때 단지명을 복사해 붙여넣게 한다
  const regionName = region.name.replace(/ \(.+\)/, '');
  const naverQ = encodeURIComponent(`${regionName} ${apt.name} 아파트`);
  const hogangQ = encodeURIComponent(apt.name);
  app.innerHTML = `
    <div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> › <a href="#/r/${code}">${esc(region.name)}</a> ›</div>
    <div class="row">
      <h1>${esc(apt.name)}</h1>
      <button class="star ${watch.has(code, key) ? 'on' : ''}" id="star" title="관심단지" style="font-size:22px">★</button>
      <span class="muted">${esc(apt.dong)} ${esc(apt.jibun)} · ${apt.built || '–'}년 준공</span>
      <span class="spacer"></span>${monthsSeg(months, opts)}
    </div>
    <p class="links">현재 매물·호가 확인 →
      <a href="https://search.naver.com/search.naver?query=${naverQ}" target="_blank" rel="noopener">네이버부동산</a>
      <a href="https://hogangnono.com/search?q=${hogangQ}" target="_blank" rel="noopener">호갱노노</a>
      <a href="https://kbland.kr/" target="_blank" rel="noopener" class="copy-name" title="단지명이 복사돼요. 검색창에 붙여넣으세요">KB부동산</a>
      <a href="https://rt.molit.go.kr/" target="_blank" rel="noopener" class="copy-name" title="단지명이 복사돼요. 검색창에 붙여넣으세요">국토부 실거래가</a>
      <span class="muted" id="copied" style="font-size:12px"></span>
    </p>
    <div class="row" style="margin-bottom:16px"><span class="muted">전용면적</span><div class="seg" id="areas">${d.areas.map((a) => `<button data-a="${a.area}" class="${a.area === areaSel ? 'on' : ''}">${a.area}㎡ <span class="muted">(${a.count})</span></button>`).join('')}</div></div>
    <div id="areaView"></div>`;
  bindMonths(`apt.${code}.${key}`);
  app.querySelectorAll('.copy-name').forEach((a) => a.addEventListener('click', () => {
    navigator.clipboard?.writeText(apt.name).then(() => {
      document.getElementById('copied').textContent = `'${apt.name}' 복사됨 — 검색창에 붙여넣으세요`;
    }, () => {});
  }));
  const lastDate = d.trades[d.trades.length - 1].date;
  watch.markSeen(code, key, lastDate); // 단지 화면을 열면 새 거래 표시를 지운다
  document.getElementById('star').addEventListener('click', (e) => {
    e.target.classList.toggle('on', watch.toggle({ code, key, name: apt.name, region: region.name, seen: lastDate }));
  });
  document.querySelectorAll('#areas button').forEach((b) => b.addEventListener('click', () => {
    areaSel = b.dataset.a;
    state.aptArea = { ...(state.aptArea || {}), [areaKey]: areaSel };
    document.querySelectorAll('#areas button').forEach((x) => x.classList.toggle('on', x === b));
    renderArea();
  }));

  function renderArea() {
    destroyCharts();
    const sel = d.areas.find((a) => a.area === areaSel);
    const ind = sel.indicators;
    const all = d.trades.filter((t) => String(Math.round(t.area)) === areaSel);
    const trades = all.filter((t) => !t.bulk);
    const jeonse = d.rents.filter((t) => String(Math.round(t.area)) === areaSel && t.monthly === 0);
    const recent = median(trades.slice(-3).map((t) => t.price));
    const max = trades.reduce((a, b) => (b.price > a.price ? b : a));
    const last = trades[trades.length - 1];
    const jRecent = median(jeonse.slice(-5).map((t) => t.deposit));

    document.getElementById('areaView').innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="label">최근 시세 (최근 3건 중위)</div><div class="value num">${fmtEok(recent)}</div><div class="hint">마지막 ${last.date.slice(2).replace(/-/g, '.')} · ${last.floor}층 ${fmtEok(last.price)}</div></div>
        <div class="kpi"><div class="label">기간 내 최고가</div><div class="value num">${fmtEok(max.price)}</div><div class="hint">${max.date.slice(2).replace(/-/g, '.')} · ${max.floor}층</div></div>
        <div class="kpi"><div class="label">최고가 대비</div><div class="value num">${delta(recent / max.price - 1)}</div><div class="hint">6개월 이동평균 3개월 변화 ${delta(ind.chg3m)}</div></div>
        <div class="kpi"><div class="label">전세 시세</div><div class="value num">${fmtEok(jRecent)}</div><div class="hint">전세가율 ${fmtPct(ind.jeonseRatio, 0)} · 갭 ${jRecent && recent ? fmtEok(recent - jRecent) : '–'}</div></div>
        <div class="kpi"><div class="label">단지 국면</div><div class="value" style="font-size:16px;margin-top:6px">${phaseChip(ind.phase)}</div><div class="hint">거래가 적은 단지는 지역 국면도 함께 보세요</div></div>
      </div>
      <div class="card">
        <h2>${areaSel}㎡ 실거래 (매매 · 전세)</h2>
        ${legend([['매매 실거래', css('--series-1'), true], ['매매 6개월 이동평균', css('--series-1')], ['전세 실거래', css('--series-2'), true], ['전세 6개월 이동평균', css('--series-2')]])}
        <div class="chart-box tall"><canvas id="aptChart"></canvas></div>
      </div>
      <div class="grid2">
        <div class="card table-wrap"><h2>최근 매매</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>거래가</th><th>평당가</th><th class="l">유형</th></tr></thead><tbody>
          ${all.slice(-25).reverse().map((t) => `<tr${t.bulk ? ' class="muted"' : ''}><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.price)}</td><td>${fmtMan(t.price / (t.area / PYEONG))}</td><td class="l muted">${esc(t.kind)}${t.bulk ? ` · <span class="tag" title="같은 날 직거래 ${BULK_HINT}">일괄</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="card table-wrap"><h2>최근 전세</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>보증금</th></tr></thead><tbody>
          ${jeonse.slice(-25).reverse().map((t) => `<tr><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.deposit)}</td></tr>`).join('') || '<tr><td class="l muted" colspan="3">전세 거래 없음</td></tr>'}
        </tbody></table></div>
      </div>`;

    const dot = (color) => ({ showLine: false, pointRadius: 3.5, pointHoverRadius: 6, pointBackgroundColor: color, pointBorderColor: css('--surface'), pointBorderWidth: 1 });
    const line = (color) => ({ showLine: true, borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true });
    makeChart(document.getElementById('aptChart'), {
      type: 'scatter',
      data: {
        datasets: [
          { label: '전세', data: jeonse.map((t) => ({ x: Date.parse(t.date), y: t.deposit, t })), ...dot(css('--series-2')) },
          { label: '매매', data: trades.map((t) => ({ x: Date.parse(t.date), y: t.price, t })), ...dot(css('--series-1')) },
          { label: '전세 이동평균', data: sel.series.filter((r) => r.jeonseMa != null).map((r) => ({ x: ymTs(r.ym), y: r.jeonseMa })), ...line(css('--series-2')) },
          { label: '매매 이동평균', data: sel.series.filter((r) => r.ma != null).map((r) => ({ x: ymTs(r.ym), y: r.ma })), ...line(css('--series-1')) },
        ],
      },
      options: {
        scales: { x: timeAxis, y: { ticks: { callback: (v) => fmtEok(v) } } },
        plugins: { tooltip: { callbacks: {
          title: (items) => tsLabel(items[0].raw.x),
          label: (c) => (c.raw.t ? ` ${c.dataset.label} ${fmtEok(c.raw.y)} · ${c.raw.t.date.slice(5).replace('-', '/')} · ${c.raw.t.floor}층` : ` ${c.dataset.label} ${fmtEok(c.raw.y)}`),
        } } },
      },
    });
  }
  renderArea();
}

// ---------- 관심단지 ----------
async function viewWatch(id) {
  const list = watch.list();
  if (!list.length) {
    app.innerHTML = `<h1>관심단지</h1><div class="card muted">아직 관심단지가 없어요. 지역 화면의 단지 목록이나 단지 화면에서 ★를 눌러 추가하세요.</div>`;
    return;
  }
  app.innerHTML = `<h1>관심단지</h1><p class="sub">주력 평형 기준. 눌러서 상세 보기. 지난번 확인 뒤 들어온 실거래는 '새 거래'로 표시돼요.</p><div class="watch-grid">${list.map((w, i) => `
    <div class="card" data-href="#/a/${w.code}/${encodeURIComponent(w.key)}" id="w${i}">
      <div class="row"><b>${esc(w.name)}</b><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
      <div class="muted">불러오는 중…</div>
    </div>`).join('')}</div>
    ${list.length > 1 ? `<div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지 비교 — 주력 평형</h2><span class="spacer"></span>
        <div class="seg" id="cmpMode"><button data-m="ppy" class="on">평당가</button><button data-m="idx">상승률 (3년 전 = 100)</button></div></div>
      <p class="muted" style="margin:0 0 8px;font-size:12px">6개월 이동평균. 평형이 달라도 비교할 수 있게 평당가로 맞췄어요.${list.length > CMP_MAX ? ` 처음 ${CMP_MAX}개 단지만 보여요.` : ''}</p>
      <div id="cmpLegend"></div>
      <div class="chart-box"><canvas id="cmp"></canvas></div>
    </div>` : ''}`;
  app.querySelector('.watch-grid').addEventListener('click', (e) => { const c = e.target.closest('[data-href]'); if (c) location.hash = c.dataset.href; });
  const cmp = [];
  await Promise.all(list.map(async (w, i) => {
    const el = document.getElementById(`w${i}`);
    try {
      const d = await getApt(w.code, w.key, 36);
      const main = d.areas[0];
      const tr = d.trades.filter((t) => !t.bulk && String(Math.round(t.area)) === main.area);
      const recent = median(tr.slice(-3).map((t) => t.price));
      // 새 거래: 지난번 확인한 거래일 이후. 처음 보는 단지(seen 없음)는 지금을 기준으로 삼는다
      const market = d.trades.filter((t) => !t.bulk);
      if (!w.seen) watch.markSeen(w.code, w.key, market[market.length - 1].date);
      const fresh = w.seen ? market.filter((t) => t.date > w.seen) : [];
      // 신고가: 같은 평형의 이전(확인 시점까지) 최고가를 넘은 새 거래. 이전 거래가 없는 평형은 세지 않는다
      const high = fresh.filter((t) => {
        const prior = market.filter((o) => o.date <= w.seen && Math.round(o.area) === Math.round(t.area)).map((o) => o.price);
        return prior.length && t.price > Math.max(...prior);
      });
      const badges = `${fresh.length ? `<span class="tag new">새 거래 ${fresh.length}건</span>` : ''}${high.length ? `<span class="tag high">신고가 ${high.length}건</span>` : ''}`;
      if (i < CMP_MAX) cmp[i] = { name: w.name, series: main.series.map((r) => ({ ym: r.ym, v: r.ma == null ? null : r.ma / (Number(main.area) / PYEONG) })) };
      el.innerHTML = `
        <div class="row"><b>${esc(w.name)}</b>${badges}<span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
        <div class="row" style="margin-top:8px"><span class="num" style="font-size:20px;font-weight:600">${fmtEok(recent)}</span><span class="muted">${main.area}㎡</span><span class="spacer"></span>${sparkline(main.series.map((s) => s.ma), 100, 28)}</div>
        <div class="row" style="font-size:12px;margin-top:6px">최고가 대비 ${delta(recent / main.maxPrice - 1)} · 전세가율 ${fmtPct(main.indicators.jeonseRatio, 0)}</div>
        <div style="margin-top:6px">${phaseChip(main.indicators.phase)}</div>`;
    } catch (e) {
      el.querySelector(':scope > .muted').textContent = `오류: ${e.message}`;
    }
  }));
  if (isStale(id) || list.length < 2) return;
  compareChart(cmp.filter(Boolean));
}

// 관심단지 비교: 단지마다 범주 색을 순서대로 고정 (최대 6개)
const CMP_MAX = 6;
function compareChart(items) {
  const canvas = document.getElementById('cmp');
  if (!canvas || items.length < 2) return;
  const colors = items.map((_, i) => css(`--series-${i + 1}`));
  document.getElementById('cmpLegend').innerHTML = legend(items.map((it, i) => [esc(it.name), colors[i]]));
  const yms = items[0].series.map((r) => r.ym);
  const data = (mode) => items.map((it) => {
    const base = it.series.find((r) => r.v != null)?.v;
    return it.series.map((r) => (r.v == null ? null : mode === 'idx' ? (r.v / base) * 100 : r.v));
  });
  let mode = 'ppy';
  // 선 끝에 단지명을 직접 표시 (색만으로 구분하지 않게, 글자는 본문 색)
  const endLabels = {
    id: 'endLabels',
    afterDatasetsDraw(c) {
      const { ctx } = c;
      ctx.save();
      ctx.font = `12px ${Chart.defaults.font.family}`; ctx.fillStyle = css('--ink-2'); ctx.textBaseline = 'middle';
      c.data.datasets.forEach((ds, i) => {
        const pts = c.getDatasetMeta(i).data;
        const j = ds.data.findLastIndex((v) => v != null);
        if (j >= 0) ctx.fillText(ds.label, pts[j].x + 6, pts[j].y);
      });
      ctx.restore();
    },
  };
  const chart = makeChart(canvas, {
    type: 'line',
    data: { labels: yms.map(fmtYm), datasets: items.map((it, i) => ({ label: it.name, data: data(mode)[i], borderColor: colors[i], backgroundColor: colors[i], borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true })) },
    options: {
      layout: { padding: { right: Math.min(160, 12 + Math.max(...items.map((it) => it.name.length)) * 12) } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { ticks: { callback: (v) => (mode === 'idx' ? v : fmtMan(v)) } } },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.raw == null ? '–' : mode === 'idx' ? c.raw.toFixed(1) : fmtMan(c.raw)}` } } },
    },
    plugins: [endLabels],
  });
  app.querySelectorAll('#cmpMode button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.m;
    app.querySelectorAll('#cmpMode button').forEach((x) => x.classList.toggle('on', x === b));
    data(mode).forEach((d, i) => { chart.data.datasets[i].data = d; });
    chart.update('none');
  }));
}

route();
