/* homeTrend 프론트엔드 — 해시 라우팅 + Chart.js */
const app = document.getElementById('app');
const state = { meta: null, overview: {}, raw: {}, charts: [], sort: { overview: ['chg3m', -1], apts: ['count12m', -1] }, pv: { median: true, jeonse: true }, ap: { mode: 'dots', jeonse: true, low: true } };
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
// 금리·주택가격 전망 심리 (한국은행). 키가 없어 파일이 없으면 null → 카드를 그리지 않는다
const getMacro = () => (state.macro ||= api(STATIC ? 'data/macro.json' : '/api/macro').catch(() => null));

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
const tsLabel = (v) => { const d = new Date(v); return `${String(d.getUTCFullYear()).slice(2)}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// ⓘ 설명 말풍선: 데스크톱은 마우스를 올리면, 모바일은 누르면 (아래쪽 시트로) 보인다. 긴 설명 문단 대신 쓴다
const tip = (text) => `<button type="button" class="tip" aria-label="설명 보기" data-tip="${esc(text)}">i</button>`;
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tip');
  document.querySelectorAll('.tip.open').forEach((x) => x !== t && x.classList.remove('open'));
  if (t) t.classList.toggle('open');
});
// 주제 조사: 마지막 한글 글자에 받침이 있으면 '은', 없으면 '는' (양평군은 / 강남구는)
function topic(word) {
  const c = [...String(word)].reverse().find((ch) => ch >= '가' && ch <= '힣');
  return c && (c.charCodeAt(0) - 0xac00) % 28 ? '은' : '는';
}
// 숫자를 문장으로: '1.2% 올랐고' / '거의 그대로이고'
const pctSpan = (x, d = 1) => `<span class="${x > 0 ? 'up' : 'down'}">${Math.abs(x * 100).toFixed(d)}%</span>`;
function regionLead(name, ind) {
  const out = [];
  if (ind.chg3m != null) {
    out.push(Math.abs(ind.chg3m) < 0.003 ? `${esc(name)} 평당가는 최근 3개월 거의 그대로이고` : `${esc(name)} 평당가는 최근 3개월 ${pctSpan(ind.chg3m)} ${ind.chg3m > 0 ? '올랐고' : '내렸고'}`);
  }
  if (ind.volVsAvg != null) {
    out.push(Math.abs(ind.volVsAvg) < 0.05 ? '거래량은 장기 평균 수준이에요.' : `거래량은 장기 평균보다 ${pctSpan(ind.volVsAvg, 0)} ${ind.volVsAvg > 0 ? '많아요.' : '적어요.'}`);
  }
  if (ind.newHighShare != null) out.push(`최근 3개월 거래 중 <b>${fmtPct(ind.newHighShare, 0)}</b>가 신고가예요.`);
  return out.join(' ');
}
// 데이터를 기다리는 동안 보여 줄 회색 틀
const skeleton = (note = '') => `<div class="sk sk-title"></div><div class="sk sk-line"></div><div class="kpis">${'<div class="sk sk-kpi"></div>'.repeat(4)}</div><div class="sk sk-chart"></div>${note ? `<p class="muted" style="font-size:12px">${note}</p>` : ''}`;
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

// 선 끝에 계열 이름을 직접 표시 (색만으로 구분하지 않게, 글자는 본문 색). 오른쪽 여백은 차트 layout.padding으로 확보
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(c) {
    const { ctx } = c;
    ctx.save();
    ctx.font = `12px ${Chart.defaults.font.family}`; ctx.fillStyle = css('--ink-2'); ctx.textBaseline = 'middle';
    c.data.datasets.forEach((ds, i) => {
      if (ds.endLabel === false) return;
      const pts = c.getDatasetMeta(i).data;
      const j = ds.data.findLastIndex((v) => v != null);
      if (j >= 0) ctx.fillText(ds.label, pts[j].x + 6, pts[j].y);
    });
    ctx.restore();
  },
};
// ---------- 시계열 차트 (TradingView Lightweight Charts) ----------
// 십자선·축 현재값·확대/이동이 기본 제공되는 금융 차트. 월 단위 데이터는 매달 1일 UTC 초로 넣는다
const LWC = window.LightweightCharts;
const ymSec = (ym) => Date.UTC(+ym.slice(0, 4), +ym.slice(4) - 1, 1) / 1000;
const secLabel = (t) => tsLabel(t * 1000);
// 축 눈금: 해가 바뀌는 곳은 연도, 나머지는 '4월'
const secTick = (t, type) => { const d = new Date(t * 1000); return type === LWC.TickMarkType.Year ? `${d.getUTCFullYear()}` : `${d.getUTCMonth() + 1}월`; };
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };
function tvChart(el) {
  // 십자선: 격자(--grid)·축(--axis)보다 확실히 진하게, 점선으로 구분
  const line = { color: css('--muted'), width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: css('--ink-2') };
  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' }, textColor: css('--muted'), fontSize: 12,
      fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: false, // 출처는 바닥글에 표기
      panes: { separatorColor: css('--grid'), separatorHoverColor: css('--accent-wash') },
    },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: secTick },
    crosshair: { mode: LWC.CrosshairMode.Magnet, vertLine: line, horzLine: line },
    localization: { locale: 'ko-KR', timeFormatter: secLabel },
    handleScroll: { vertTouchDrag: false }, // 모바일에서 세로로 쓸면 페이지가 스크롤되게
  });
  state.charts.push({ destroy: () => chart.remove() });
  return chart;
}

// 보이는 구간이 바뀔 때: 이동평균이 있는 첫(a)·끝(b) 달을 찾아 선 색(올랐으면 빨강·내렸으면 파랑)과
// 구간 최고·최저(점 + 가로 점선, 값은 오른쪽 축 — 점 옆 글자는 차트 가장자리에서 잘린다)를 갱신하고 onChange(a, b)
// label: 축 라벨에 붙일 이름('매매'), swatch: 선 색을 따라 바뀌는 범례 표시
function trackRange(chart, s, ma, line, onChange, label, swatch) {
  const last = s.length - 1;
  const markers = LWC.createSeriesMarkers(line, []);
  let extremes = [];
  const update = () => {
    const lr = chart.timeScale().getVisibleLogicalRange();
    const lo = Math.max(0, Math.ceil(lr?.from ?? 0)), hi = Math.min(last, Math.floor(lr?.to ?? last));
    const idx = [];
    for (let i = lo; i <= hi; i++) if (ma[i] != null) idx.push(i);
    if (idx.length < 2) return;
    const a = idx[0], b = idx[idx.length - 1];
    const c = css(ma[b] >= ma[a] ? '--up' : '--down');
    line.applyOptions({ lineColor: c, topColor: alpha(c, 0.18), bottomColor: alpha(c, 0) });
    if (swatch) swatch.style.background = c;
    let hiI = a, loI = a;
    idx.forEach((i) => { if (ma[i] > ma[hiI]) hiI = i; if (ma[i] < ma[loI]) loI = i; });
    const ext = hiI === loI ? [] : [[hiI, `${label} 최고`, css('--up')], [loI, `${label} 최저`, css('--down')]].sort((x, y) => x[0] - y[0]);
    markers.setMarkers(ext.map(([i, , color]) => ({ time: ymSec(s[i].ym), position: 'inBar', shape: 'circle', color, size: 0.6 })));
    extremes.forEach((l) => line.removePriceLine(l));
    // 지금이 최고·최저면 축의 현재값 라벨과 겹치므로 선은 생략
    extremes = ext.filter(([i]) => i !== b).map(([i, title, color]) => line.createPriceLine({ price: ma[i], color: alpha(color, 0.5), lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title }));
    onChange(a, b);
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange(update);
  return update;
}
// 기간 칩: 1년 = 마지막 완성월과 12개월 전을 비교. 0 = 받아 온 기간 전체
function bindRange(chart, segId, last) {
  const set = (m) => {
    if (!m) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({ from: last - 1 - m - 0.5, to: last + 0.5 });
  };
  const btns = app.querySelectorAll(`#${segId} button`);
  btns.forEach((btn) => btn.addEventListener('click', () => {
    btns.forEach((x) => x.classList.toggle('on', x === btn));
    set(Number(btn.dataset.r));
  }));
  set(0);
}
const rangeSeg = (id, n, opts = [[12, '1년'], [36, '3년'], [60, '5년'], [0, '전체']]) => `<div class="seg" id="${id}">${opts.filter(([m]) => m < n).map(([m, l]) => `<button data-r="${m}" class="${m === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const headJoin = (parts) => parts.filter(Boolean).map((x) => `<span>${x}</span>`).join('<span class="sep">·</span>');
const volFmt = { type: 'custom', minMove: 1, formatter: (v) => `${Math.round(v)}건` };

// 지역 평당가 + 거래량. 토스증권처럼 위의 큰 숫자가 십자선을 따라 바뀐다
function priceVolumeChart(s, ind) {
  const chart = tvChart(document.getElementById('pv'));
  const last = s.length - 1; // 신고 진행 중인 달: 이동평균은 그리지 않고(지표와 같은 기준) 거래량만 옅게
  const ma = s.map((r, i) => (i < last ? r.ma : null));
  const pt = (r, v) => (v == null ? { time: ymSec(r.ym) } : { time: ymSec(r.ym), value: v });
  const manFmt = { type: 'custom', minMove: 1, formatter: fmtMan };
  const price = chart.addSeries(LWC.AreaSeries, { title: '매매', lineWidth: 2, priceFormat: manFmt, priceLineStyle: LWC.LineStyle.Dotted, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: css('--surface') });
  price.setData(s.map((r, i) => pt(r, ma[i])));
  const jeonse = chart.addSeries(LWC.LineSeries, { title: '전세', color: css('--series-2'), lineWidth: 2, priceFormat: manFmt, priceLineVisible: false, crosshairMarkerRadius: 3, visible: state.pv.jeonse });
  jeonse.setData(s.map((r, i) => pt(r, i < last ? r.jeonseMa : null)));
  const median = chart.addSeries(LWC.LineSeries, { color: css('--series-1-soft'), lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2.5, priceFormat: manFmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: state.pv.median });
  median.setData(s.map((r) => pt(r, r.median)));

  // 거래량 (아래 칸). 일괄 거래는 거래 막대 뒤에 합계 높이로 깔아 쌓인 것처럼 보이게
  const volOpts = { priceFormat: volFmt, priceLineVisible: false, lastValueVisible: false };
  const bulk = chart.addSeries(LWC.HistogramSeries, { ...volOpts, color: css('--series-4') }, 1);
  bulk.setData(s.map((r) => (r.bulk ? { time: ymSec(r.ym), value: r.count + r.bulk } : { time: ymSec(r.ym) })));
  const vol = chart.addSeries(LWC.HistogramSeries, { ...volOpts, color: css('--volume') }, 1);
  vol.setData(s.map((r, i) => ({ time: ymSec(r.ym), value: r.count, ...(i === last ? { color: alpha(css('--volume'), 0.4) } : {}) })));
  if (ind.volLong != null) vol.createPriceLine({ price: ind.volLong, color: css('--muted'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '장기평균' });
  chart.panes()[0].setStretchFactor(3);
  chart.panes()[1].setStretchFactor(1);

  // 큰 숫자: 십자선이 있는 달(없으면 보이는 구간 끝 b)의 이동평균, 등락률은 구간 시작 a 대비
  const headValue = document.getElementById('pvValue'), headSub = document.getElementById('pvSub');
  let a = ma.findIndex((v) => v != null), b = last - 1;
  const showHead = (i) => {
    const k = i ?? b, r = s[k], v = ma[k];
    const chg = v != null && k > a ? v / ma[a] - 1 : null;
    headValue.innerHTML = v != null ? fmtMan(v) : '<span class="muted">신고 진행 중</span>';
    headSub.innerHTML = headJoin([
      `<b>${fmtYm(r.ym)}</b>`,
      chg != null ? `${delta(chg)} <span class="muted">${fmtYm(s[a].ym)} 대비</span>` : '',
      state.pv.median && r.median != null ? `매매 월 중위 ${fmtMan(r.median)}` : '',
      state.pv.jeonse && k < last && r.jeonseMa != null ? `전세 이동평균 ${fmtMan(r.jeonseMa)}` : '',
      `매매 거래 ${r.count}건${r.bulk ? ` (+일괄 ${r.bulk})` : ''}${k === last ? ' · 신고 진행 중' : ''}`,
    ]);
  };
  const onRange = trackRange(chart, s, ma, price, (a1, b1) => { [a, b] = [a1, b1]; showHead(null); }, '매매', document.getElementById('pvSwatch'));
  const byTime = new Map(s.map((r, i) => [ymSec(r.ym), i]));
  chart.subscribeCrosshairMove((p) => showHead(p.time != null ? byTime.get(p.time) ?? null : null));

  const series = { median, jeonse };
  app.querySelectorAll('#pvToggle button').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.s;
    state.pv[k] = !state.pv[k];
    btn.classList.toggle('on', state.pv[k]);
    series[k].applyOptions({ visible: state.pv[k] });
    showHead(null);
  }));
  bindRange(chart, 'pvRange', last);
  onRange();
}

// 실거래 점 (커스텀 시리즈). 달마다 한 칸을 쓰고 칸 안에서 계약일만큼 옆으로 놓아,
// 시간 축은 월 단위로 고르게 두면서 같은 달 거래끼리 겹치지 않게 한다. 신고가는 테두리로 표시
const dayOffset = (date) => { const [y, m, d] = date.split('-').map(Number); return (d - 0.5) / new Date(Date.UTC(y, m, 0)).getUTCDate() - 0.5; };
class DotsView {
  renderer() { return this; }
  update(data, options) { this.data = data; this.opts = options; }
  priceValueBuilder(r) { const ys = r.pts.map((p) => p.y); return [Math.min(...ys), Math.max(...ys), ys[ys.length - 1]]; }
  isWhitespace(r) { return !r.pts?.length; }
  defaultOptions() { return { ...LWC.customSeriesDefaultOptions, color: '#888', ring: '#d03b3b', focus: '#000', hoverId: -1, anchorId: -1, pinId: -1, lastValueVisible: false, priceLineVisible: false }; }
  // 칸 너비 안에서 점의 x 좌표 (media 좌표)
  dotX(barX, p) { return barX + p.dx * this.data.barSpacing * 0.9; }
  draw(target, toY) {
    const d = this.data, o = this.opts;
    if (!d?.visibleRange) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const r = Math.max(2, Math.min(4, d.barSpacing / 3));
      const focus = [];
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const bar = d.bars[i];
        for (const p of bar.originalData.pts || []) {
          const y = toY(p.y);
          if (y == null) continue;
          const x = this.dotX(bar.x, p) * hr;
          ctx.beginPath(); ctx.arc(x, y * vr, r * hr, 0, 2 * Math.PI);
          ctx.globalAlpha = 0.75; ctx.fillStyle = o.color; ctx.fill(); ctx.globalAlpha = 1;
          if (p.high) { ctx.lineWidth = 1.5 * hr; ctx.strokeStyle = o.ring; ctx.stroke(); }
          if (p.id === o.hoverId || p.id === o.anchorId || p.id === o.pinId) focus.push([x, y * vr]);
        }
      }
      // 마우스를 올린 점·기준점·상세 카드를 띄운 점은 맨 위에 크게
      focus.forEach(([x, y]) => {
        ctx.beginPath(); ctx.arc(x, y, (r + 3) * hr, 0, 2 * Math.PI);
        ctx.lineWidth = 2 * hr; ctx.strokeStyle = o.focus; ctx.stroke();
      });
    });
  }
}

// 단지 평형 차트: 실거래 점 / 월봉 전환 (매매·전세 모두), 6개월 이동평균, 아래 칸 월별 매매 건수.
// 점(월봉 모드에선 그 달)을 누르면 상세 카드가 뜨고, 카드에서 그 거래를 '기준'으로 잡으면 큰 숫자 옆 등락률이 기준 대비로 바뀐다
function aptChart(sel, allTrades, allJeonse) {
  const s = sel.series, last = s.length - 1;
  const o = state.ap;
  const ymOf = (t) => t.date.slice(0, 4) + t.date.slice(5, 7);
  // 신고가: 조회 시작 1년 뒤부터, 같은 평형의 이전 최고가를 넘은 매매 (처음 1년은 비교 대상이 적어 빼고)
  const warm = allTrades.length ? `${+allTrades[0].date.slice(0, 4) + 1}${allTrades[0].date.slice(4)}` : '';
  let top = -Infinity;
  const tradePts = allTrades.map((t, n) => {
    const high = t.date >= warm && t.price > top, prevTop = top > 0 ? top : null;
    top = Math.max(top, t.price);
    return { id: n, y: t.price, dx: dayOffset(t.date), ym: ymOf(t), t, kind: '매매', high, prevTop };
  });
  const jeonsePts = allJeonse.map((t, n) => ({ id: 1e6 + n, y: t.deposit, dx: dayOffset(t.date), ym: ymOf(t), t, kind: '전세' }));
  const low = (p) => p.t.floor <= 3; // 저층(지하 포함)은 시세보다 낮게 거래되는 경우가 많다

  const chart = tvChart(document.getElementById('ap'));
  chart.applyOptions({ crosshair: { mode: LWC.CrosshairMode.Normal } });
  const eokFmt = { type: 'custom', minMove: 1, formatter: fmtEok };
  const ma = s.map((r, i) => (i < last ? r.ma : null));
  const pt = (r, v) => (v == null ? { time: ymSec(r.ym) } : { time: ymSec(r.ym), value: v });
  const line = chart.addSeries(LWC.AreaSeries, { title: '매매', lineWidth: 2, priceFormat: eokFmt, priceLineStyle: LWC.LineStyle.Dotted, crosshairMarkerVisible: false });
  line.setData(s.map((r, i) => pt(r, ma[i])));
  const jLine = chart.addSeries(LWC.LineSeries, { title: '전세', color: css('--series-2'), lineWidth: 2, priceFormat: eokFmt, priceLineVisible: false, crosshairMarkerVisible: false });
  jLine.setData(s.map((r, i) => pt(r, i < last ? r.jeonseMa : null)));
  const dotOpts = { priceFormat: eokFmt, ring: css('--up'), focus: css('--ink') };
  const jView = new DotsView(), tView = new DotsView();
  const jDots = chart.addCustomSeries(jView, { ...dotOpts, color: css('--series-2') });
  const tDots = chart.addCustomSeries(tView, { ...dotOpts, color: css('--series-1') });
  // 전세 월봉: 전세 색 하나로, 오른 달은 채움·내린 달은 속 빈 몸통. 매매 월봉보다 먼저 넣어 뒤에 깔린다
  const jCandles = chart.addSeries(LWC.CandlestickSeries, {
    priceFormat: eokFmt, upColor: css('--series-2'), downColor: 'transparent', borderUpColor: css('--series-2'), borderDownColor: css('--series-2'),
    wickUpColor: css('--series-2'), wickDownColor: css('--series-2'), lastValueVisible: false, priceLineVisible: false,
  });
  const candles = chart.addSeries(LWC.CandlestickSeries, {
    priceFormat: eokFmt, upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'),
    borderVisible: false, lastValueVisible: false, priceLineVisible: false,
  });
  const vol = chart.addSeries(LWC.HistogramSeries, { priceFormat: volFmt, priceLineVisible: false, lastValueVisible: false, color: css('--volume') }, 1);
  chart.panes()[0].setStretchFactor(4);
  chart.panes()[1].setStretchFactor(1);

  // 보이는 점 (층 필터·전세 토글 반영) → 각 시리즈 데이터
  let shownT = [], shownJ = [];
  const ohlc = (ps) => { if (!ps?.length) return null; const ys = ps.map((p) => p.y); return { open: ys[0], close: ys[ys.length - 1], high: Math.max(...ys), low: Math.min(...ys) }; };
  const byMonth = (pts) => { const m = new Map(); pts.forEach((p) => { if (!m.has(p.ym)) m.set(p.ym, []); m.get(p.ym).push(p); }); return m; };
  const apply = () => {
    shownT = tradePts.filter((p) => o.low || !low(p));
    shownJ = o.jeonse ? jeonsePts.filter((p) => o.low || !low(p)) : [];
    const mt = byMonth(shownT), mj = byMonth(shownJ);
    const dots = o.mode === 'dots';
    tDots.setData(s.map((r) => (dots && mt.has(r.ym) ? { time: ymSec(r.ym), pts: mt.get(r.ym) } : { time: ymSec(r.ym) })));
    jDots.setData(s.map((r) => (dots && mj.has(r.ym) ? { time: ymSec(r.ym), pts: mj.get(r.ym) } : { time: ymSec(r.ym) })));
    // 월봉: 그 달 첫 거래 → 마지막 거래가 몸통, 최저~최고가 꼬리
    const bars = (m) => s.map((r) => {
      const c = !dots && ohlc(m.get(r.ym));
      return c ? { time: ymSec(r.ym), ...c } : { time: ymSec(r.ym) };
    });
    candles.setData(bars(mt));
    jCandles.setData(bars(mj));
    vol.setData(s.map((r, i) => ({ time: ymSec(r.ym), value: mt.get(r.ym)?.length || 0, ...(i === last ? { color: alpha(css('--volume'), 0.4) } : {}) })));
    jLine.applyOptions({ visible: o.jeonse });
  };

  // 큰 숫자 + 설명 줄
  const headValue = document.getElementById('apValue'), headSub = document.getElementById('apSub');
  let a = ma.findIndex((v) => v != null), b = Math.max(0, last - 1), anchor = null, anchorLine = null;
  const dd = (date) => date.slice(2).replace(/-/g, '.');
  const vs = (v) => (anchor
    ? `${delta(v / anchor.y - 1)} <span class="muted">기준 ${dd(anchor.t.date)} ${fmtEok(anchor.y)} 대비</span>`
    : '');
  const range = (ps) => { const ys = ps.map((p) => p.y); const lo = Math.min(...ys), hi = Math.max(...ys); return lo === hi ? fmtEok(lo) : `${fmtEok(lo)}~${fmtEok(hi)}`; };
  const showHead = (k, dot) => {
    if (dot) {
      const t = dot.t, m = s[byTime.get(ymSec(dot.ym))]?.ma;
      headValue.innerHTML = `${fmtEok(dot.y)}${dot.high ? ' <span class="tag high">신고가</span>' : ''}`;
      headSub.innerHTML = headJoin([
        `<b>${dd(t.date)}</b>`, `${dot.kind} · ${t.floor}층`,
        anchor && anchor !== dot ? vs(dot.y) : (dot.kind === '매매' && m ? `${delta(dot.y / m - 1)} <span class="muted">매매 6개월 이동평균 대비</span>` : ''),
        dot.kind === '매매' ? `평당 ${fmtMan(dot.y / (t.area / PYEONG))}` : '',
      ]);
      return;
    }
    const i = k ?? b, r = s[i], v = ma[i];
    const ts = shownT.filter((p) => p.ym === r.ym), js = shownJ.filter((p) => p.ym === r.ym);
    headValue.innerHTML = v != null ? fmtEok(v) : '<span class="muted">이동평균 없음</span>';
    headSub.innerHTML = headJoin([
      `<b>${fmtYm(r.ym)}</b>`,
      v != null && anchor ? vs(v) : v != null && i > a ? `${delta(v / ma[a] - 1)} <span class="muted">${fmtYm(s[a].ym)} 대비</span>` : '',
      ts.length ? `매매 ${ts.length}건 ${range(ts)}` : '매매 없음',
      js.length ? `전세 ${js.length}건 ${range(js)}` : '',
      i === last ? '신고 진행 중' : '',
    ]);
  };
  const onRange = trackRange(chart, s, ma, line, (a1, b1) => { [a, b] = [a1, b1]; showHead(null); }, '매매', document.getElementById('apSwatch'));

  // 십자선 근처(10px 안)의 점 찾기. 점 위치는 렌더러와 같은 식으로 계산
  const byTime = new Map(s.map((r, i) => [ymSec(r.ym), i]));
  const nearest = (p) => {
    if (o.mode !== 'dots' || !p.point || p.time == null || !tView.data) return null;
    const k = byTime.get(p.time);
    let best = null, bd = 10;
    for (const j of [k - 1, k, k + 1]) {
      if (!s[j]) continue;
      const x0 = chart.timeScale().timeToCoordinate(ymSec(s[j].ym));
      if (x0 == null) continue;
      for (const q of [...shownT, ...shownJ].filter((q) => q.ym === s[j].ym)) {
        const y = line.priceToCoordinate(q.y);
        const dist = Math.hypot(tView.dotX(x0, q) - p.point.x, y - p.point.y);
        if (dist < bd) { bd = dist; best = q; }
      }
    }
    return best;
  };
  // applyOptions는 다시 그리면서 십자선 이벤트를 또 부르므로, 값이 바뀔 때만 적용 (안 그러면 무한 반복)
  const ids = { hoverId: -1, anchorId: -1, pinId: -1 };
  const focus = (k, id) => {
    if (ids[k] === id) return;
    ids[k] = id;
    [tDots, jDots].forEach((x) => x.applyOptions({ [k]: id }));
  };
  chart.subscribeCrosshairMove((p) => {
    const dot = nearest(p);
    focus('hoverId', dot ? dot.id : -1);
    showHead(p.time != null ? byTime.get(p.time) ?? null : null, dot);
  });
  // 상세 카드: 점을 누르면 그 거래, 월봉 모드에선 그 달의 매매·전세 요약. 빈 곳을 누르면 닫힌다
  const pop = document.getElementById('apPop');
  let pinned = null; // { dot } 또는 { i } (월)
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const dotCard = (dot) => {
    const t = dot.t, i = byTime.get(ymSec(dot.ym)), m = ma[i];
    const same = (dot.kind === '매매' ? shownT : shownJ).filter((q) => q.ym === dot.ym);
    const isAnchor = anchor === dot;
    return `<div class="pop-head"><span class="pop-kind"><i class="dot" style="background:${css(dot.kind === '매매' ? '--series-1' : '--series-2')}"></i>${dot.kind}</span><span class="muted">${t.date.replace(/-/g, '.')}</span><button type="button" class="pop-x" aria-label="닫기">×</button></div>
      <div class="pop-value num">${fmtEok(dot.y)}${dot.high ? ' <span class="tag high">신고가</span>' : ''}</div>
      <dl class="pop-rows num">
        ${row('층 · 전용', `${t.floor}층 · ${t.area}㎡`)}
        ${dot.kind === '매매' ? row('평당가', fmtMan(dot.y / (t.area / PYEONG))) : ''}
        ${dot.kind === '매매' && t.kind ? row('거래 유형', esc(t.kind)) : ''}
        ${dot.kind === '매매' && m ? row('6개월 이동평균 대비', delta(dot.y / m - 1)) : ''}
        ${dot.kind === '매매' && dot.prevTop ? row('직전 최고가 대비', `${delta(dot.y / dot.prevTop - 1)} <span class="muted">${fmtEok(dot.prevTop)}</span>`) : ''}
        ${dot.kind === '전세' && m ? row('매매 이동평균 대비 (전세가율)', fmtPct(dot.y / m, 0)) : ''}
        ${row(`같은 달 ${dot.kind}`, `${same.length}건${same.length > 1 ? ` · ${range(same)}` : ''}`)}
        ${anchor && !isAnchor ? row(`기준 ${dd(anchor.t.date)} 대비`, delta(dot.y / anchor.y - 1)) : ''}
      </dl>
      <button type="button" class="pop-btn" data-anchor>${isAnchor ? '기준 해제' : '이 거래를 기준으로 비교'}</button>`;
  };
  const monthCard = (i) => {
    const r = s[i], ts = shownT.filter((p) => p.ym === r.ym), js = shownJ.filter((p) => p.ym === r.ym);
    const part = (name, ps) => {
      const c = ohlc(ps);
      if (!c) return row(name, '<span class="muted">거래 없음</span>');
      return row(`${name} ${ps.length}건`, `${delta(c.close / c.open - 1)}`)
        + row('첫 · 마지막', `${fmtEok(c.open)} → ${fmtEok(c.close)}`)
        + row('최저 ~ 최고', `${fmtEok(c.low)} ~ ${fmtEok(c.high)}`);
    };
    return `<div class="pop-head"><span class="pop-kind">${fmtYm(r.ym)} 월봉</span>${i === last ? '<span class="muted">신고 진행 중</span>' : ''}<button type="button" class="pop-x" aria-label="닫기">×</button></div>
      <div class="pop-value num">${ma[i] != null ? fmtEok(ma[i]) : '–'} <span class="muted" style="font-size:12px;font-weight:400">매매 6개월 이동평균</span></div>
      <dl class="pop-rows num">${part('매매', ts)}${o.jeonse ? part('전세', js) : ''}</dl>`;
  };
  // 카드 자리: 대상 오른쪽(자리가 없으면 왼쪽), 세로는 차트 안으로. 보이는 구간 밖이면 숨김
  const place = () => {
    if (!pinned) { pop.hidden = true; return; }
    const ym = pinned.dot ? pinned.dot.ym : s[pinned.i].ym;
    const x0 = chart.timeScale().timeToCoordinate(ymSec(ym));
    const yv = pinned.dot ? pinned.dot.y : (ohlc(shownT.filter((p) => p.ym === ym)) || ohlc(shownJ.filter((p) => p.ym === ym)))?.close;
    const yc = yv != null ? line.priceToCoordinate(yv) : null;
    const box = pop.parentElement, W = box.clientWidth, H = chart.panes()[0].getHeight();
    if (x0 == null || yc == null || x0 < 0 || x0 > W) { pop.hidden = true; return; }
    const x = pinned.dot ? tView.dotX(x0, pinned.dot) : x0;
    pop.hidden = false;
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 14;
    const left = Math.max(0, Math.min(W - w, x + gap + w < W - 60 ? x + gap : x - gap - w));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(4, Math.min(H - h - 4, yc - h / 2))}px`;
  };
  const openCard = (target) => {
    pinned = target;
    focus('pinId', target?.dot ? target.dot.id : -1);
    if (!target) { pop.hidden = true; return; }
    pop.innerHTML = target.dot ? dotCard(target.dot) : monthCard(target.i);
    place();
    follow();
  };
  // 카드가 열려 있는 동안 매 프레임 자리를 맞춘다. 기간 이동뿐 아니라 창 크기 변경(구간이 고정돼 range 이벤트가 없다)·
  // 가격 축 드래그처럼 좌표만 바뀌는 조작에도 따라가게. 카드를 닫거나 화면을 떠나면 멈춘다
  let raf = 0;
  const follow = () => {
    if (raf) return;
    const tick = () => {
      if (!pinned || !pop.isConnected) { raf = 0; return; }
      place();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  const setAnchor = (dot) => {
    anchor = dot;
    if (anchorLine) line.removePriceLine(anchorLine);
    anchorLine = anchor ? line.createPriceLine({ price: anchor.y, color: css('--ink-2'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '기준' }) : null;
    focus('anchorId', anchor ? anchor.id : -1);
  };
  pop.addEventListener('click', (e) => {
    if (e.target.closest('.pop-x')) openCard(null);
    else if (e.target.closest('[data-anchor]') && pinned?.dot) {
      setAnchor(anchor === pinned.dot ? null : pinned.dot);
      openCard(pinned); showHead(null);
    }
  });
  chart.subscribeClick((p) => {
    if (o.mode === 'dots') {
      const dot = nearest(p);
      openCard(dot && dot !== pinned?.dot ? { dot } : null);
      return;
    }
    const i = p.time != null ? byTime.get(p.time) : null;
    const has = i != null && (shownT.some((q) => q.ym === s[i].ym) || shownJ.some((q) => q.ym === s[i].ym));
    openCard(has && pinned?.i !== i ? { i } : null);
  });

  app.querySelectorAll('#apMode button').forEach((btn) => btn.addEventListener('click', () => {
    o.mode = btn.dataset.m;
    document.getElementById('apKind').textContent = o.mode === 'dots' ? '매매 실거래' : '매매 월봉';
    document.getElementById('apJKind').textContent = o.mode === 'dots' ? '전세 실거래·이동평균' : '전세 월봉·이동평균';
    openCard(null);
    app.querySelectorAll('#apMode button').forEach((x) => x.classList.toggle('on', x === btn));
    apply(); showHead(null);
  }));
  app.querySelectorAll('#apToggle button').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.s;
    o[k] = !o[k];
    btn.classList.toggle('on', o[k]);
    apply(); showHead(null);
    if (pinned?.dot && !(pinned.dot.kind === '매매' ? shownT : shownJ).includes(pinned.dot)) openCard(null);
    else openCard(pinned);
  }));
  apply();
  bindRange(chart, 'apRange', last);
  onRange();
}

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

// ---------- 테마: 자동(시스템) / 라이트 / 다크 ----------
// 차트 색은 그릴 때 CSS 변수에서 읽으므로 테마가 바뀌면 화면을 다시 그린다
const THEMES = [['auto', '◐', '자동'], ['light', '☀', '라이트'], ['dark', '☾', '다크']];
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function getTheme() { try { return localStorage.getItem('homeTrend.theme') || 'auto'; } catch (_) { return 'auto'; } }
function applyTheme() {
  const t = getTheme();
  document.documentElement.dataset.theme = t === 'auto' ? (darkMq.matches ? 'dark' : 'light') : t;
  const [, icon, label] = THEMES.find((x) => x[0] === t) || THEMES[0];
  const b = document.getElementById('theme');
  b.textContent = icon;
  b.title = `테마: ${label} (누르면 바뀜)`;
  b.setAttribute('aria-label', b.title);
}
document.getElementById('theme').addEventListener('click', () => {
  const i = THEMES.findIndex((x) => x[0] === getTheme());
  try { localStorage.setItem('homeTrend.theme', THEMES[(i + 1) % THEMES.length][0]); } catch (_) { /* 저장 불가 */ }
  applyTheme();
  route();
});
darkMq.addEventListener('change', () => { if (getTheme() === 'auto') { applyTheme(); route(); } });
applyTheme();

// ---------- 전체 검색 (상단): 지역 이름 + 모든 지역의 단지 ----------
// 목록은 처음 검색창을 누를 때 한 번 받는다 (정적 사이트: 빌드 때 만든 data/search.json)
const getSearch = () => (state.search ||= api(STATIC ? 'data/search.json' : '/api/search').catch((e) => { state.search = null; throw e; }));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
function searchFlat(idx) {
  return state.meta.regions.flatMap((r) => (idx.regions[r.code] || []).map(([dong, apt, cnt]) => ({ r, dong, apt, cnt, na: norm(apt), nd: norm(dong) })));
}
// 지역 → 단지명이 검색어로 시작 → 단지명에 포함 → 동 이름에 포함 순, 같으면 거래 많은 순
function searchMatch(flat, q) {
  const n = norm(q);
  if (!n) return [];
  const regs = state.meta.regions.filter((r) => norm(r.name).includes(n)).slice(0, 5).map((r) => ({ r }));
  const apts = [];
  for (const e of flat) {
    const at = e.na.indexOf(n);
    if (at < 0 && !e.nd.includes(n)) continue;
    apts.push({ ...e, score: at === 0 ? 0 : at > 0 ? 1 : 2 });
  }
  apts.sort((x, y) => x.score - y.score || y.cnt - x.cnt);
  return [...regs, ...apts.slice(0, 30)];
}
function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (!q.trim() || i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.trim().length))}</mark>${esc(text.slice(i + q.trim().length))}`;
}
(function bindSearch() {
  const box = document.getElementById('gsearch'), input = document.getElementById('gq'), list = document.getElementById('gsList');
  let flat = null, items = [], sel = 0, partial = false, failed = false;
  const href = (it) => (it.apt ? `#/a/${it.r.code}/${encodeURIComponent(`${it.dong}|${it.apt}`)}` : `#/r/${it.r.code}`);
  const close = () => { list.hidden = true; };
  const draw = () => {
    const q = input.value;
    list.hidden = !q.trim();
    if (list.hidden) return;
    if (!flat) { list.innerHTML = `<div class="gs-msg">${failed ? '검색 목록을 불러오지 못했어요' : '검색 목록 불러오는 중…'}</div>`; return; }
    items = searchMatch(flat, q);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = (items.length
      ? items.map((it, i) => `<a class="gs-item${i === sel ? ' on' : ''}" href="${href(it)}" data-i="${i}">${it.apt
        ? `<b>${highlight(it.apt, q)}</b><span class="muted">${esc(it.r.name)} ${highlight(it.dong, q)} · 거래 ${it.cnt}건</span>`
        : `<b>${highlight(it.r.name, q)}</b><span class="muted">지역 · ${esc(it.r.group)}</span>`}</a>`).join('')
      : '<div class="gs-msg">찾는 단지가 없어요</div>')
      + (partial ? '<div class="gs-msg muted">로컬 서버에선 받아 둔 지역의 단지만 검색돼요</div>' : '');
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('focus', () => {
    if (!state.meta) return; // 첫 화면을 불러오기 전
    getSearch().then((idx) => { flat ||= searchFlat(idx); partial = !!idx.partial; draw(); }, () => { failed = true; draw(); });
    draw();
  });
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === 'Enter' && items[sel] && !list.hidden) {
      location.hash = href(items[sel]);
      input.value = ''; close(); input.blur();
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });
  list.addEventListener('click', (e) => { if (e.target.closest('a')) { input.value = ''; close(); } });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close(); });
  // '/' 키로 검색창으로
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
}());

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
// 모바일에선 표 머리 대신 정렬 선택 상자를 쓴다 (표는 카드 목록으로 바뀜)
const plain = (html) => html.replace(/<[^>]+>/g, '');
function sortSelect(cols, sortKey, [key]) {
  return `<label class="m-sort muted">정렬 <select data-table="${sortKey}">${cols.filter((c) => c[2]).map(([k, label]) => `<option value="${k}" ${k === key ? 'selected' : ''}>${plain(label)}</option>`).join('')}</select></label>`;
}
const cells = (cols, r, isLeft) => cols.map(([, label, , f], i) => `<td class="${isLeft(i) ? 'l' : ''}" data-label="${esc(plain(label))}">${f(r)}</td>`).join('');
function bindSort(root, sortKey, rerender) {
  root.querySelectorAll(`select[data-table="${sortKey}"]`).forEach((s) => s.addEventListener('change', () => {
    state.sort[sortKey] = [s.value, ['name', 'apt', 'dong', 'fromPeak'].includes(s.value) ? 1 : -1];
    rerender();
  }));
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
    <h1>${esc(group)} 지역별 시세 트렌드 ${tip('실거래 평당가의 3개월 이동평균 기준 (단지 구성 보정, 신고 진행 중인 지난달·통매각 같은 일괄 거래 제외). 거래량은 최근 3개월을 36개월 평균과 비교해요. 신고가 비율은 최근 3개월 거래 중 같은 단지·평형의 이전 최고가를 넘은 거래 비중으로, 시장이 달아오르면 가장 먼저 올라가요.')}</h1>
    <p class="lead" id="ovLead"></p>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">국면 지도 — 가격 변화 × 거래량 ${tip('벌집순환모형: 거래량이 먼저 움직이고 가격이 따라와요. 오른쪽 아래(불황) → 가운데 오른쪽(회복진입) → 오른쪽 위(회복) 순서로 옮겨가는 지역을 주목하세요. 점에 마우스를 올리면 6개월 전 → 3개월 전 → 지금 이동 경로가 보이고, 누르면 지역 화면으로 가요. ‘모든 지역 최근 이동 방향’을 켜면 지역마다 3개월 전 → 지금 움직임을 화살표로 보여줘요.')}</h2><span class="spacer"></span><label class="muted" style="font-size:12px"><input type="checkbox" id="trail" ${state.trail ? 'checked' : ''}> 모든 지역 최근 이동 방향</label></div>
      <div class="chart-box tall"><canvas id="phaseMap"></canvas></div>
    </div>
    <div id="macro"></div>
    <div class="card"><div class="row"><h2 style="margin:0">지역별 지표</h2><span class="spacer"></span><span id="ovSort"></span></div><div class="table-wrap mcards"><table><thead></thead><tbody></tbody></table></div></div>`;
  renderMacro(id);

  const rows = regions.map((r) => ({ ...r, ...(state.overview[r.code] || {}) }));
  const thead = app.querySelector('thead'), tbody = app.querySelector('tbody');
  const render = () => {
    thead.innerHTML = tableHead(OV_COLS, 'overview', state.sort.overview);
    document.getElementById('ovSort').innerHTML = sortSelect(OV_COLS, 'overview', state.sort.overview);
    tbody.innerHTML = sortRows(rows, OV_COLS, state.sort.overview)
      .map((r) => `<tr class="link" data-href="#/r/${r.code}">${cells(OV_COLS, r, (i) => i === 0)}</tr>`).join('');
    bindSort(app, 'overview', render);
    // 한 줄 요약: 3개월 새 오른 지역 수와 가장 많이 오른 곳.
    // 지역이 하나씩 들어올 때마다 숫자가 바뀌면 오류처럼 보이므로, 다 불러온 뒤에 한 번만 문장을 정한다
    const lead = document.getElementById('ovLead');
    const pending = rows.filter((r) => !r.ind && !r.error).length;
    if (pending) {
      const done = rows.length - pending;
      lead.innerHTML = `<span class="muted">${esc(group)} ${rows.length}개 지역의 실거래를 불러오는 중이에요 · ${done}/${rows.length}</span><span class="lead-progress"><i style="width:${(done / rows.length) * 100}%"></i></span>`;
      return;
    }
    const ok = rows.filter((r) => r.ind?.chg3m != null);
    // 빠진 지역은 3곳까지 이름으로, 그보다 많으면 개수로 밝힌다
    const failed = rows.filter((r) => r.error), thin = rows.filter((r) => r.ind && r.ind.chg3m == null);
    const who = (rs) => (rs.length <= 3 ? `${rs.map((r) => esc(r.name)).join('·')}${topic(rs[rs.length - 1].name)}` : `${rs.length}곳은`);
    const notes = [failed.length ? `${who(failed)} 불러오지 못해 빼고 계산했어요` : '', thin.length ? `${who(thin)} 거래가 적어 뺐어요` : ''].filter(Boolean);
    const note = notes.length ? ` <span class="muted">(${notes.join(' · ')})</span>` : '';
    if (!ok.length) {
      lead.innerHTML = `<span class="err">지역 데이터를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.</span>${note}`;
      return;
    }
    const up = ok.filter((r) => r.ind.chg3m > 0.003).length, down = ok.filter((r) => r.ind.chg3m < -0.003).length;
    const best = ok.reduce((a, b) => (b.ind.chg3m > a.ind.chg3m ? b : a));
    const hot = ok.filter((r) => r.ind.volVsAvg > 0.2).length;
    lead.innerHTML = `최근 3개월 ${esc(group)} ${ok.length}개 지역 중 ${up ? `<span class="up">${up}곳이 올랐고</span>` : '오른 곳은 없고'} ${down ? `<span class="down">${down}곳이 내렸어요</span>` : '내린 곳은 없어요'}. 가장 많이 오른 곳은 <a href="#/r/${best.code}">${esc(best.name)}</a>(${delta(best.ind.chg3m)})이고, 거래량이 장기 평균보다 20% 넘게 늘어난 곳은 ${hot}곳이에요.${note}`;
  };
  tbody.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });

  const map = phaseMap(document.getElementById('phaseMap'));
  const refreshMap = () => {
    const pts = rows.filter((r) => r.ind?.chg3m != null && r.ind?.volVsAvg != null)
      .map((r) => ({ x: r.ind.volVsAvg * 100, y: r.ind.chg3m * 100, label: r.name.replace(/ \(.+\)/, ''), code: r.code, phase: r.ind.phase,
        trail: (r.ind.trail || []).map((t) => ({ x: t.volVsAvg * 100, y: t.chg3m * 100, ym: t.ym })) }));
    map.data.datasets[0].data = pts;
    map.data.datasets[1].data = state.trail ? pts.flatMap((p) => p.trail.slice(-1)) : []; // 전체 보기에서 그리는 3개월 전 위치만 축 범위에 넣는다
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

// ---------- 금리·심리 (전국) ----------
async function renderMacro(id) {
  const m = await getMacro();
  const box = document.getElementById('macro');
  if (isStale(id) || !box || !m?.series?.length) return;
  const by = Object.fromEntries(m.series.map((x) => [x.id, x]));
  // 최근 36개월, 계열마다 빠진 달은 null
  const yms = state.meta.yms.slice(-36);
  const vals = (x) => { const mp = new Map(x?.points || []); return yms.map((ym) => mp.get(ym) ?? null); };
  const last = (x) => x?.points?.[x.points.length - 1];
  const ago = (x, n) => x?.points?.[x.points.length - 1 - n]?.[1];
  const chgPt = (x, n = 3, unit = '%p') => {
    const [, v] = last(x) || [], p = ago(x, n);
    if (v == null || p == null) return '';
    const d = Math.round((v - p) * 100) / 100;
    return d ? `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${unit}</span>` : '<span class="muted">변화 없음</span>';
  };
  const rates = ['baseRate', 'mortgageRate', 'jeonseLoanRate'].map((k) => by[k]).filter((x) => x?.points.length);
  const csi = by.housingCsi?.points.length ? by.housingCsi : null;
  const colors = rates.map((_, i) => css(`--series-${i + 1}`));
  box.innerHTML = `
    <div class="card">
      <h2>금리 · 주택가격 전망 심리 (전국) ${tip('한국은행 통계. 금리는 매수 여력, 주택가격전망 CSI는 1년 뒤 집값이 오를 거라 보는 가구가 많을수록 100보다 커요. 금리가 내리고 CSI가 100을 넘어 오르면 매수세가 붙기 쉬워요.')}</h2>
      ${m.missing?.length ? `<p class="muted" style="margin:-6px 0 12px;font-size:12px">못 받은 지표: ${esc(m.missing.join(', '))}</p>` : ''}
      <div class="kpis">
        ${rates.map((x) => `<div class="kpi"><div class="label">${esc(x.name)}</div><div class="value num">${last(x)[1].toFixed(2)}%</div><div class="hint">${fmtYm(last(x)[0])} · 3개월 전 대비 ${chgPt(x)}</div></div>`).join('')}
        ${csi ? `<div class="kpi"><div class="label">주택가격전망 CSI</div><div class="value num">${last(csi)[1]}</div><div class="hint">${fmtYm(last(csi)[0])} · 3개월 전 대비 ${chgPt(csi, 3, '')}</div></div>` : ''}
      </div>
      <div class="grid2">
        ${rates.length ? `<div><h2 style="font-size:14px">금리 (연 %)</h2>${legend(rates.map((x, i) => [esc(x.name), colors[i]]))}<div class="chart-box short"><canvas id="rates"></canvas></div></div>` : '<div></div>'}
        ${csi ? `<div><h2 style="font-size:14px">주택가격전망 CSI</h2>${legend([['주택가격전망 CSI', css('--series-1')], ['기준선 100', css('--muted')]])}<div class="chart-box short"><canvas id="csi"></canvas></div></div>` : ''}
      </div>
    </div>`;
  const labels = yms.map(fmtYm);
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, stepped: false, spanGaps: true, ...extra });
  const base = (fmt) => ({
    interaction: { mode: 'index', intersect: false },
    scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: { ticks: { callback: fmt } } },
    plugins: { tooltip: { filter: (i) => i.dataset.endLabel !== false, callbacks: { label: (c) => ` ${c.dataset.label} ${fmt(c.raw)}` } } },
  });
  if (rates.length) {
    makeChart(document.getElementById('rates'), {
      type: 'line',
      data: { labels, datasets: rates.map((x, i) => line(x.name, vals(x), colors[i], x.id === 'baseRate' ? { stepped: 'before' } : {})) },
      options: { ...base((v) => `${Number(v).toFixed(2)}%`), layout: { padding: { right: 110 } } },
      plugins: [endLabels],
    });
  }
  if (csi) {
    makeChart(document.getElementById('csi'), {
      type: 'line',
      data: { labels, datasets: [
        line('주택가격전망 CSI', vals(csi), css('--series-1')),
        line('기준선', yms.map(() => 100), css('--muted'), { borderWidth: 1.5, borderDash: [4, 4], endLabel: false }),
      ] },
      options: base((v) => `${Math.round(v)}`),
    });
  }
}

function phaseMap(canvas) {
  const quadrants = {
    id: 'quadrants',
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x, y } } = c;
      ctx.save();
      const x0 = x.getPixelForValue(0), y0 = y.getPixelForValue(0);
      // 가격이 오른 위쪽은 옅은 빨강, 내린 아래쪽은 옅은 파랑으로 깔아 국면 경계(0)가 한눈에 보이게
      ctx.fillStyle = alpha(css('--up'), 0.04); ctx.fillRect(a.left, a.top, a.right - a.left, y0 - a.top);
      ctx.fillStyle = alpha(css('--down'), 0.04); ctx.fillRect(a.left, y0, a.right - a.left, a.bottom - y0);
      // 국면 경계 십자선: 격자보다 진하게
      ctx.strokeStyle = css('--muted'); ctx.lineWidth = 1;
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
      // 이동 경로. 마우스를 올린 지역은 6개월 전 → 3개월 전 → 지금 전체를, 전체 보기는 25개 선이 엉키지 않게
      // 최근 구간(3개월 전 → 지금)만 화살표로. 오래된 구간일수록 옅고 가늘게, 강조 중엔 나머지를 흐리게 (축 밖은 잘림)
      ctx.save();
      ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
      ctx.strokeStyle = css('--series-1'); ctx.fillStyle = css('--series-1'); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const hover = c.$hover;
      const paths = c.data.datasets[0].data.filter((p) => p.trail?.length && (state.trail || p.code === hover));
      paths.sort((p, q) => (p.code === hover) - (q.code === hover)); // 강조할 지역은 맨 위에
      for (const p of paths) {
        const one = p.code === hover, dim = hover != null && !one;
        const trail = one ? p.trail : p.trail.slice(-1);
        const px = [...trail, p].map((t) => [x.getPixelForValue(t.x), y.getPixelForValue(t.y)]);
        const n = px.length - 1;
        let head = null;
        for (let i = 0; i < n; i++) {
          const k = (i + 1) / n; // 1에 가까울수록 최근 구간 (전체 보기의 한 구간은 1)
          let [x1, y1] = px[i], [x2, y2] = px[i + 1];
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (i === n - 1) { // 마지막 구간은 지금 점(반지름 5 + 테두리) 앞에서 멈추고 화살표
            if (len < 14) continue;
            const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
            x2 -= ux * 9; y2 -= uy * 9;
            head = [x2, y2, ux, uy];
          }
          ctx.globalAlpha = (one ? 0.35 + 0.6 * k : 0.55) * (dim ? 0.3 : 1);
          ctx.lineWidth = one ? 1.5 + k : 1.25;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        if (head) {
          const [tx, ty, ux, uy] = head, s1 = one ? 7 : 5, w = s1 * 0.6;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - ux * s1 - uy * w, ty - uy * s1 + ux * w);
          ctx.lineTo(tx - ux * s1 + uy * w, ty - uy * s1 - ux * w);
          ctx.closePath(); ctx.fill();
        }
        if (one) { // 과거 위치: 빈 원 + 시점 (배경색 테두리로 선 위에서도 읽히게)
          ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
          ctx.font = `11px ${Chart.defaults.font.family}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          p.trail.forEach((t, i) => {
            const [cx, cy] = px[i];
            ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, 7);
            ctx.fillStyle = css('--surface'); ctx.fill(); ctx.stroke();
            ctx.lineWidth = 3; ctx.strokeStyle = css('--surface'); ctx.strokeText(fmtYm(t.ym), cx, cy - 6);
            ctx.fillStyle = css('--ink-2'); ctx.fillText(fmtYm(t.ym), cx, cy - 6);
            ctx.lineWidth = 1.5; ctx.strokeStyle = css('--series-1');
          });
          ctx.fillStyle = css('--series-1');
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
      { data: [], pointRadius: 0, pointHoverRadius: 0 }, // 점은 그리지 않는다 (경로는 플러그인이 그림)
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
  showLoading(`<div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div><h1>${esc(region.name)}</h1>${skeleton(`실거래 ${months}개월치 불러오는 중… (처음 보는 기간은 국토부 API 호출로 30초 정도 걸릴 수 있어요)`)}`);
  const d = await getRegion(code, months, brokerOnly);
  if (isStale(id)) return;
  destroyCharts();
  const ind = d.indicators;
  const s = d.series;
  app.innerHTML = `
    <div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div>
    <div class="row"><h1>${esc(region.name)}</h1>${phaseChip(ind.phase)}<span class="spacer"></span>${kindSeg(brokerOnly)}${monthsSeg(months, opts)}</div>
    <p class="lead">${regionLead(region.name.replace(/ \(.+\)/, ''), ind)} ${tip('평당가 = 전용면적 기준 거래가 ÷ 평 (중위값). 이동평균은 거래된 단지 구성이 달라 생기는 착시를 보정한 값이고, 최근 지표는 신고가 끝난 달까지로 계산해요. 통매각 같은 일괄 거래는 빼고 계산해요.')}</p>
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
      <div class="tv-head">
        <div class="tv-label">평당 매매가 <span class="muted">3개월 이동평균 · 구성 보정 · 만원/3.3㎡</span> ${tip('아래 칸은 월별 매매 거래량이고, 점선은 장기 평균(36개월 중위)이에요. 마지막 달(옅은 막대)은 신고 진행 중이라 덜 잡혀요. 노란 막대는 통매각 같은 일괄 거래로 지표 계산에서 뺐어요. 휠·핀치로 확대하고 끌어서 이동할 수 있어요.')}</div>
        <div class="tv-value num" id="pvValue"></div>
        <div class="tv-sub num" id="pvSub"></div>
      </div>
      <div class="row tv-ctrl">
        ${rangeSeg('pvRange', s.length)}
        <span class="spacer"></span>
        <div class="chips" id="pvToggle">
          <span class="chip-static"><i id="pvSwatch"></i>매매 3개월 이동평균</span>
          <button data-s="median" class="${state.pv.median ? 'on' : ''}" title="눌러서 켜고 끄기"><i class="dot" style="background:${css('--series-1-soft')}"></i>매매 월 중위값</button>
          <button data-s="jeonse" class="${state.pv.jeonse ? 'on' : ''}" title="눌러서 켜고 끄기"><i style="background:${css('--series-2')}"></i>전세 3개월 이동평균</button>
        </div>
      </div>
      <div class="tv-box" id="pv"></div>
      <p class="muted tv-note">아래 칸은 월별 매매 거래량 (점선 = 장기 평균 ${ind.volLong ?? '–'}건/월)${s.some((r) => r.bulk) ? ' · 노란 막대 = 일괄 거래(지표에서 제외)' : ''} · 휠·핀치로 확대</p>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>거래 온도 ${tip('같은 단지·평형의 이전 거래와 비교한 비율 (3개월 이동평균). 신고가·상승 비율이 오르면 과열, 하락 비율이 상승 비율을 넘으면 꺾이는 신호예요.')}</h2>
        ${legend([['신고가', css('--up')], ['직전보다 오름', css('--series-2')], ['직전보다 내림', css('--down')]])}
        <div class="chart-box short"><canvas id="heat"></canvas></div>
      </div>
      <div class="card">
        <h2>전세가율 추이 ${tip('평당 전세가 ÷ 평당 매매가 (3개월 이동평균). 오르면 매매가와 전세가의 갭이 좁아져 갭투자 수요가 들어오기 쉬워요.')}</h2>
        ${legend([['전세가율', css('--series-2')]])}
        <div class="chart-box short"><canvas id="jr"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지별 시세</h2><span class="spacer"></span><span id="aptSort"></span><input type="search" id="q" placeholder="단지명·동 검색"></div>
      <div class="table-wrap mcards"><table><thead></thead><tbody></tbody></table></div>
    </div>`;
  bindMonths(`region.${code}`);
  bindKind();

  priceVolumeChart(s, ind);

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
    document.getElementById('aptSort').innerHTML = sortSelect(cols, 'apts', state.sort.apts);
    tbody.innerHTML = sortRows(rows, cols, state.sort.apts).slice(0, 300)
      .map((r) => `<tr class="link" data-href="#/a/${code}/${encodeURIComponent(r.key)}">${cells(cols, r, (i) => i < 2)}</tr>`).join('');
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
  showLoading(`<div class="crumb"><a href="#/r/${code}">${esc(region.name)}</a> ›</div>${skeleton('불러오는 중… (처음 보는 기간은 30초 정도 걸릴 수 있어요)')}`);
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
        <div class="tv-head">
          <div class="tv-label">${areaSel}㎡ 매매가 <span class="muted">6개월 이동평균</span> ${tip('점 하나가 실거래 1건이고, 빨간 테두리는 신고가(같은 평형 이전 최고가를 넘은 거래)예요. 점을 누르면 그 거래의 상세 정보가 나오고, 카드에서 기준으로 잡으면 다른 거래·시점의 등락률을 보여줘요. 월봉은 그 달 첫 거래→마지막 거래가 몸통, 최저~최고가 꼬리예요 (전세 월봉은 오른 달은 채움, 내린 달은 속 빈 막대). 아래 칸은 월별 매매 건수. 1~3층을 끄면 점·월봉·건수에서만 빠지고 이동평균은 그대로예요.')}</div>
          <div class="tv-value num" id="apValue"></div>
          <div class="tv-sub num" id="apSub"></div>
        </div>
        <div class="row tv-ctrl">
          ${rangeSeg('apRange', sel.series.length)}
          <div class="seg" id="apMode">${[['dots', '실거래'], ['candle', '월봉']].map(([m, l]) => `<button data-m="${m}" class="${state.ap.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <div class="chips" id="apToggle">
            <span class="chip-static"><i id="apSwatch"></i>매매 6개월 이동평균</span>
            <span class="chip-static"><i class="dot" style="background:${css('--series-1')}"></i><span id="apKind">${state.ap.mode === 'dots' ? '매매 실거래' : '매매 월봉'}</span></span>
            <button data-s="jeonse" class="${state.ap.jeonse ? 'on' : ''}" title="눌러서 켜고 끄기"><i class="dot" style="background:${css('--series-2')}"></i><span id="apJKind">${state.ap.mode === 'dots' ? '전세 실거래·이동평균' : '전세 월봉·이동평균'}</span></button>
            <button data-s="low" class="${state.ap.low ? 'on' : ''}" title="저층(1~3층·지하)은 시세보다 낮게 거래되는 경우가 많아요. 눌러서 켜고 끄기">1~3층 포함</button>
          </div>
        </div>
        <div class="tv-stage"><div class="tv-box" id="ap"></div><div class="tv-pop" id="apPop" hidden></div></div>
        <p class="muted tv-note">점이나 월봉을 누르면 상세 정보가 나와요 · <span class="up">빨간 테두리</span> = 신고가</p>
      </div>
      <div class="grid2">
        <div class="card table-wrap"><h2>최근 매매</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>거래가</th><th>평당가</th><th class="l">유형</th></tr></thead><tbody>
          ${all.slice(-25).reverse().map((t) => `<tr${t.bulk ? ' class="muted"' : ''}><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.price)}</td><td>${fmtMan(t.price / (t.area / PYEONG))}</td><td class="l muted">${esc(t.kind)}${t.bulk ? ` · <span class="tag" title="같은 날 직거래 ${BULK_HINT}">일괄</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="card table-wrap"><h2>최근 전세</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>보증금</th></tr></thead><tbody>
          ${jeonse.slice(-25).reverse().map((t) => `<tr><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.deposit)}</td></tr>`).join('') || '<tr><td class="l muted" colspan="3">전세 거래 없음</td></tr>'}
        </tbody></table></div>
      </div>`;

    aptChart(sel, trades, jeonse);
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
  app.innerHTML = `<h1>관심단지 ${tip("주력 평형 기준이에요. 눌러서 상세를 볼 수 있고, 지난번 확인 뒤 들어온 실거래는 '새 거래'로 표시돼요.")}</h1><div class="watch-grid">${list.map((w, i) => `
    <div class="card" data-href="#/a/${w.code}/${encodeURIComponent(w.key)}" id="w${i}">
      <div class="row"><b>${esc(w.name)}</b><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
      <div class="muted">불러오는 중…</div>
    </div>`).join('')}</div>
    ${list.length > 1 ? `<div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지 비교 — 주력 평형</h2><span class="spacer"></span>
        <div class="seg" id="cmpMode"><button data-m="ppy" class="on">평당가</button><button data-m="idx">상승률 (3년 전 = 100)</button></div></div>
      <p class="muted" style="margin:0 0 8px;font-size:12px">6개월 이동평균 · 평형이 달라도 비교할 수 있게 평당가로 맞췄어요${list.length > CMP_MAX ? ` · 처음 ${CMP_MAX}개 단지만 보여요` : ''}</p>
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
