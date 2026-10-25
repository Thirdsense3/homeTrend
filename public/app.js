/* homeTrend 프론트엔드 — 해시 라우팅 + Chart.js */
const app = document.getElementById('app');
const state = { meta: null, overview: {}, raw: {}, charts: [], sort: { overview: ['chg3m', -1], overviewJ: ['chg3m', -1], apts: ['count12m', -1] }, deal: 'sale', pv: { median: true, jeonse: true, policy: true }, ap: { mode: 'dots', jeonse: true, low: true, policy: true } };
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
// 주간 가격지수·매입자 거주지 (한국부동산원). 키가 없어 파일이 없으면 null → 해당 칸·카드를 그리지 않는다
const getReb = () => (state.rebPromise ||= api(STATIC ? 'data/reb.json' : '/api/reb').then((d) => (state.reb = d)).catch(() => (state.reb = null)));
const rebInd = (code) => state.reb?.regions?.[code]?.ind;
// 변화 파일 (scripts/build.js, lib/changes.js): 오늘 확인된 변화와 최근 30일 삭제·급등·국면 변화. 이력이 없는 빌드·로컬 서버는 null
const getChanges = () => (state.changesPromise ||= (STATIC && state.meta?.buildNo ? api('data/changes.json') : Promise.reject()).catch(() => null));
const getRecent = () => (state.recentPromise ||= (STATIC && state.meta?.buildNo ? api('data/changes-30d.json') : Promise.reject()).catch(() => null));
// 정책 자료 (data/policies.json, 로드맵 9번). 없거나 실패하면 null → 차트 표식·타임라인을 그리지 않는다
const getPolicies = () => (state.policyPromise ||= api(STATIC ? 'data/policies.json' : '/api/policies').then((d) => (state.policies = d)).catch(() => (state.policies = null)));
const getForecasts = () => (state.forecastPromise ||= api(STATIC ? 'data/forecasts.json' : '/api/forecasts').then((d) => (state.forecasts = d)).catch(() => (state.forecasts = { status: 'unavailable', regions: {}, validation: {} })));

// ---------- 방문 측정 (개인정보처리방침 #/privacy, 규칙은 infra/functions/metrics/metrics.mjs) ----------
// 무작위 기기 ID와 행동 종류만 보낸다. 검색어·단지 이름·관심 목록은 보내지 않는다. API 주소(meta.api)가 없으면 아무것도 보내지 않는다
const metrics = {
  queue: [], timer: 0,
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* 저장 불가 */ } },
  available: () => !!state.meta?.api && !!window.crypto?.randomUUID,
  off() { return this.get('homeTrend.metricsOff') === '1'; },
  setOff(off) { this.set('homeTrend.metricsOff', off ? '1' : null); if (off) this.queue = []; },
  device() {
    let d = this.get('homeTrend.device');
    if (!/^[0-9a-f-]{36}$/.test(d || '')) {
      d = crypto.randomUUID();
      this.set('homeTrend.device', d);
      if (this.get('homeTrend.device') !== d) return null; // 저장할 수 없는 브라우저는 매번 새 기기가 되므로 보내지 않는다
    }
    return d;
  },
  // 첫 방문 시각. 기기 기록이 서버에서 지워진 뒤 돌아와도 신규로 세지 않게 브라우저에 둔다.
  // 측정 전부터 관심단지·좋아요·테마를 저장해 둔 브라우저는 기존 사용자로 표시한다
  firstVisit() {
    let fv = this.get('homeTrend.firstVisit');
    if (!fv) {
      const old = ['homeTrend.watch', 'homeTrend.regionLikes', 'homeTrend.theme'].some((k) => this.get(k) != null);
      fv = old ? '2020-01-01T00:00:00.000Z' : new Date().toISOString();
      this.set('homeTrend.firstVisit', fv);
    }
    return fv;
  },
  track(type, p) {
    if (!this.available() || this.off()) return;
    this.queue.push({ id: crypto.randomUUID(), type, ...(p && { p }) });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  },
  flush() {
    clearTimeout(this.timer);
    if (!this.queue.length || !this.available() || this.off()) return;
    const d = this.device();
    if (!d) { this.queue = []; return; }
    const fv = this.firstVisit(), m = matchMedia('(pointer: coarse)').matches ? 1 : 0;
    // text/plain 본문이라 사전 요청(CORS preflight) 없이 보낸다. 실패해도 화면에는 영향 없음
    while (this.queue.length) {
      fetch(`${state.meta.api}/events`, { method: 'POST', body: JSON.stringify({ d, fv, m, e: this.queue.splice(0, 30) }), keepalive: true }).catch(() => {});
    }
  },
  // 이 기기 기록 삭제: 서버 기록을 지우고 기기 ID를 새로 만든다
  async remove() {
    this.queue = [];
    const d = this.get('homeTrend.device');
    if (d) {
      const r = await fetch(`${state.meta.api}/devices/${d}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(r.statusText || String(r.status));
    }
    this.set('homeTrend.device', null);
  },
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') metrics.flush(); });
// 첫 방문 판별은 이번 방문에서 관심단지·테마를 저장하기 전, 스크립트를 읽을 때 한 번 확정한다
metrics.firstVisit();
const buildId = () => (state.meta?.build ? `${state.meta.build.runNumber}.${state.meta.build.runAttempt}` : undefined);

const dateStr = (n) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
function unpack(p, months, code) {
  const yms = p.yms.slice(-months);
  const from = Number(yms[0] + '01');
  const apts = p.apts;
  // 조회 기간 밖 단지도 포함해 옛 링크와 관심단지의 주소를 확인한다.
  (state.complexes ||= {})[code] = apts.map(([dong, apt, built, jibun]) => ({ dong, apt, jibun }));
  // firstSeen: 이 거래를 처음 확인한 데이터 빌드 번호 (0 = 이력을 쌓기 전부터 있던 거래)
  // 조회 기간(완성된 달) 뒤의 거래는 이번 달(신고 진행 중) 거래다. 지표·차트에 섞이지 않게 partial로 따로 둔다
  const to = Number(p.yms[p.yms.length - 1] + '31');
  const tradeRows = p.t.filter((r) => r[1] >= from).map(([i, d, a, floor, price, direct, source, firstSeen]) => ({
    dong: apts[i][0], apt: apts[i][1], built: apts[i][2], jibun: apts[i][3],
    sourceApt: p.names?.[source] || apts[i][1],
    date: dateStr(d), area: a / 100, floor, price, kind: direct ? '직거래' : '중개거래', firstSeen: firstSeen || 0, partial: d > to,
  }));
  const trades = tradeRows.filter((t) => !t.partial), partial = tradeRows.filter((t) => t.partial);
  const rents = p.j.filter((r) => r[1] >= from).map(([i, d, a, floor, deposit, source]) => ({
    dong: apts[i][0], apt: apts[i][1], built: apts[i][2], jibun: apts[i][3],
    sourceApt: p.names?.[source] || apts[i][1],
    date: dateStr(d), area: a / 100, floor, deposit, monthly: 0,
  }));
  return { yms, trades: A.normalizeRows(code, trades), partial: A.normalizeRows(code, partial), rents: A.normalizeRows(code, rents) };
}
// 지역 원본은 한 번 받아 메모리에 두고, 지역·단지 화면 모두 여기서 계산
async function getRaw(code, months) {
  const k = `${code}:${months}`;
  if (!state.raw[k]) {
    state.raw[k] = (STATIC
      ? (state.raw[code] ||= api(`data/region/${code}.json`)).then((p) => unpack(p, months, code))
      : api(`/api/raw/${code}?months=${months}`).then((p) => unpack(p, months, code))
    ).catch((e) => { delete state.raw[k]; delete state.raw[code]; throw e; });
  }
  return state.raw[k];
}
// brokerOnly: 직거래(가족 간 거래 등 시세와 동떨어질 수 있는 거래)를 빼고 계산
// jeonse: 단지 목록을 전세 거래(보증금)로 만든다. 같은 날 몰린 전세(일괄)는 지역 전세 지표처럼 뺀다
async function getRegion(code, months, brokerOnly, jeonse) {
  const raw = await getRaw(code, months);
  const trades = brokerOnly ? raw.trades.filter((t) => t.kind !== '직거래') : raw.trades;
  const summary = A.regionSummary(raw.yms, trades, raw.rents);
  summary.indicators.candidate = hasMissing(code) ? null : A.candidateScore(summary.indicators, summary.series);
  if (jeonse) return { ...summary, apartments: A.apartmentList(raw.rents.filter(A.isJeonse), 'deposit', () => true) };
  const partial = brokerOnly ? raw.partial.filter((t) => t.kind !== '직거래') : raw.partial;
  return { ...summary, apartments: withPartial(A.apartmentList(trades), partial) };
}
// 단지 목록에 이번 달(신고 진행 중) 거래를 더한다: 거래 수와 최근 거래만. 평당가·시세·최고가는 지난달까지로 둔다.
// 이번 달에만 거래가 있는 단지도 목록에 넣고 가격 칸은 비워 둔다
function withPartial(list, partial) {
  const by = new Map();
  for (const t of A.markBulk(partial)) {
    if (t.bulk) continue;
    const k = A.aptKey(t);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const latest = (ts) => ts.reduce((a, b) => (b.date > a.date ? b : a));
  const out = list.map((r) => {
    const p = by.get(r.key);
    if (!p) return r;
    by.delete(r.key);
    const last = latest(p);
    return { ...r, partialCount: p.length, count12m: r.count12m + p.length, lastDate: last.date, lastPrice: last.price, lastArea: last.area, lastPartial: true };
  });
  for (const [key, p] of by) {
    const last = latest(p);
    out.push({
      key, apt: last.apt, dong: last.dong, built: last.built, jibun: last.jibun, count: p.length, count12m: p.length, partialCount: p.length,
      mainArea: null, recentPrice: null, peakPrice: null, peakDate: null, fromPeak: null, ppy: null,
      lastDate: last.date, lastPrice: last.price, lastArea: last.area, lastPartial: true, bulk: 0,
    });
  }
  return out;
}
// partial: 이번 달(신고 진행 중) 거래. 시세·차트·지표에는 쓰지 않고 목록에서만 따로 표시한다
// jeonseOk: 전세 보기. 매매가 없거나 일괄 거래뿐이어도 전세 거래가 있으면 단지를 보여 준다
async function getApt(code, key, months, jeonseOk) {
  const { yms, trades, partial, rents } = await getRaw(code, months);
  key = A.canonicalKey(code, key, state.complexes?.[code]);
  const both = A.markBulk([...trades, ...partial].filter((x) => A.aptKey(x) === key)).sort((a, b) => a.date.localeCompare(b.date));
  const t = both.filter((x) => !x.partial);
  const r = rents.filter((x) => A.aptKey(x) === key).sort((a, b) => a.date.localeCompare(b.date));
  const jn = r.filter(A.isJeonse).length;
  if (!(jeonseOk && jn)) {
    const hint = jn ? ` (전세 ${jn}건은 위에서 '전세'로 바꾸면 볼 수 있어요)` : '';
    if (!t.length && both.length) throw new Error(`이번 달(신고 진행 중) 거래 ${both.length}건만 있는 단지예요. 시세·차트는 신고가 끝나는 다음 달부터 계산해요${hint}`);
    if (!t.length) throw new Error(`해당 기간에 ${jn ? '매매 ' : ''}거래가 없는 단지입니다${hint}`);
    if (t.every((x) => x.bulk)) throw new Error(`해당 기간에 일괄 거래(통매각)만 있어 시세를 계산할 수 없는 단지입니다${hint}`);
  }
  const last = t[t.length - 1] || r[r.length - 1];
  const cur = both.filter((x) => x.partial);
  // 평형 목록: 시세·차트는 지난달까지로 계산하되, 이번 달에만 거래가 있는 평형도 고를 수 있게 뒤에 붙인다 (partialOnly)
  const { areas } = A.apartmentDetail(yms, t, r);
  const curCount = (area) => cur.filter((x) => A.areaKey(x.area) === area).length;
  areas.forEach((a) => { a.partialCount = curCount(a.area); });
  for (const area of new Set(cur.map((x) => A.areaKey(x.area)))) {
    if (!areas.some((a) => a.area === area)) areas.push({ area, count: 0, partialCount: curCount(area), partialOnly: true });
  }
  return {
    apt: { key, name: last.apt, dong: last.dong, jibun: last.jibun, built: last.built },
    areas,
    trades: t,
    partial: cur,
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
const fmtDate = (d) => (d ? `${d.slice(2, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}` : '–'); // 2026-10-05 → 26.10.05
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

// 관심단지 (브라우저 저장). checked: 마지막으로 확인한 데이터 빌드 번호(meta.buildNo)
// → 그 뒤 빌드에서 처음 확인된 거래를 '새로 확인된 거래'로 표시한다 (계약일이 지난 거래가 늦게 신고돼도 잡힌다)
// 예전 seen(마지막으로 본 계약일)은 버리고, 전환 뒤 첫 방문의 빌드부터 다시 센다 (adopt)
// area: 관심 평형(A.areaKey 값). 없으면 주력 평형으로 요약한다. months: 단지 화면 조회 기간
// 동기화 코드를 연결했으면 저장할 때마다 서버에 맞춘다 (sync). quiet: 서버에서 받은 목록을 쓸 때
const isArea = (a) => typeof a === 'string' && /^\d+(\.\d+)?$/.test(a);
const watch = {
  list() {
    try {
      const raw = JSON.parse(localStorage.getItem('homeTrend.watch'));
      if (!Array.isArray(raw)) return [];
      const merged = new Map();
      for (const w of raw) {
        if (!w || typeof w.code !== 'string' || typeof w.key !== 'string') continue;
        const key = A.canonicalKey(w.code, w.key, w.jibun ? [{ dong: w.key.split('|')[0], apt: w.key.split('|').slice(1).join('|'), jibun: w.jibun }] : state.complexes?.[w.code]);
        const old = merged.get(`${w.code}:${key}`);
        const checked = [old?.checked, w.checked].filter(Number.isInteger);
        const area = isArea(w.area) ? w.area : isArea(old?.area) ? old.area : undefined;
        merged.set(`${w.code}:${key}`, { ...w, key, name: key.split('|').slice(1).join('|'), checked: checked.length ? Math.min(...checked) : undefined, area });
      }
      return [...merged.values()];
    } catch (_) { return []; }
  },
  save(l, quiet) { try { localStorage.setItem('homeTrend.watch', JSON.stringify(l)); } catch (_) { /* 저장 불가 */ } if (!quiet) sync.schedule(); },
  get(code, key) { key = A.canonicalKey(code, key, state.complexes?.[code]); return this.list().find((w) => w.code === code && w.key === key) || null; },
  has(code, key) { return !!this.get(code, key); },
  toggle(item) {
    item = { ...item, key: A.canonicalKey(item.code, item.key, state.complexes?.[item.code]), checked: state.meta?.buildNo || undefined };
    let l = this.list();
    l = this.has(item.code, item.key) ? l.filter((w) => !(w.code === item.code && w.key === item.key)) : [...l, item];
    this.save(l);
    const on = this.has(item.code, item.key);
    // a: 관심 평형까지 골라 저장했는지 (어떤 평형인지는 보내지 않는다)
    metrics.track(on ? 'watch_add' : 'watch_remove', { n: this.list().length, ...(on && { a: item.area ? 1 : 0 }) });
    return on;
  },
  // 관심 평형 저장·변경 (저장된 단지만)
  setArea(code, key, area) {
    key = A.canonicalKey(code, key, state.complexes?.[code]);
    const l = this.list();
    const w = l.find((x) => x.code === code && x.key === key);
    if (!w || w.area === area) return;
    w.area = area;
    this.save(l);
    metrics.track('watch_area');
  },
  // 단지 화면에서 고른 조회 기간을 기억한다 (저장된 단지만)
  setMonths(code, key, months) {
    key = A.canonicalKey(code, key, state.complexes?.[code]);
    const l = this.list();
    const w = l.find((x) => x.code === code && x.key === key);
    if (!w || w.months === months) return;
    w.months = months;
    this.save(l);
  },
  // 확인 표시: 이 빌드까지 들어온 거래는 본 것으로 한다 (code 없이 부르면 전체)
  markChecked(code, key, no) {
    if (!no) return;
    if (code) key = A.canonicalKey(code, key, state.complexes?.[code]);
    const l = this.list();
    let changed = false;
    for (const w of l) if ((!code || (w.code === code && w.key === key)) && !(w.checked >= no)) { w.checked = no; changed = true; }
    if (changed) this.save(l);
  },
  // 빌드 번호로 바꾸기 전에 저장한 항목(seen만 있음)은 지금 빌드부터 센다. 전환 첫날 늦은 신고가 한꺼번에 새 거래로 뜨지 않게
  adopt(no) {
    if (!no) return;
    let raw;
    try { raw = JSON.parse(localStorage.getItem('homeTrend.watch')); } catch (_) { return; }
    if (!Array.isArray(raw) || !raw.some((w) => w && (!Number.isInteger(w.checked) || 'seen' in w))) return;
    this.save(this.list().map(({ seen, ...w }) => ({ ...w, checked: Number.isInteger(w.checked) ? w.checked : no })));
  },
};

// ---------- 관심 목록 동기화 코드 (로드맵 5번, 규칙은 infra/functions/sync/sync.mjs) ----------
// 브라우저 목록이 먼저 저장되고 서버는 나중에 맞춘다. 서버가 없거나 실패해도 저장은 그대로이고, 다음 동기화 때 다시 보낸다.
// 항목: 관심단지 w:<지역>:<단지 키> = { name, jibun, region, area, months }, 좋아요한 지역 r:<지역> = {}. 마지막 확인 빌드(checked)는 기기마다 따로
// homeTrend.sync: { code, rev: 마지막으로 받은 서버 리비전, snap: 그때 서버 목록 { id: { r, v } | { r, d } }, at: 받은 시각(표시용) }
// → 지금 목록과 snap의 차이가 보낼 변경이고, 항목마다 snap의 리비전(from)을 함께 보내 서버가 충돌을 판정한다. 기기 시각으로 정하지 않는다
// homeTrend.syncHeld: { reason, changes: [{ id, v, name }] } 서버에 바로 반영하지 않고 사용자 확인을 기다리는 이 기기 변경
//   conflict: 같은 항목을 다른 기기가 먼저 바꿈 / stale: 오래 동기화하지 않아 서버 목록을 먼저 받음 / link: 연결할 때 이 기기에만 있던 항목
const SYNC_MONTHS = [36, 60, 120, 192]; // APT_MONTHS
const SYNC_BATCH = 100; // 요청 하나에 담는 변경 수 (서버 MAX_CHANGES 300·본문 64KB 안)
const syncSame = (a, b) => JSON.stringify(a ?? null, Object.keys(a ?? {}).sort()) === JSON.stringify(b ?? null, Object.keys(b ?? {}).sort());
const fmtCode = (c) => c.replace(/(.{5})(?=.)/g, '$1-');
const sync = {
  KEY: 'homeTrend.sync', HELD: 'homeTrend.syncHeld',
  timer: 0, busy: null, again: false, lastRun: 0, status: '', notice: '',
  read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  write(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* 저장 불가 */ } },
  available: () => !!state.meta?.api,
  conf() { const c = this.read(this.KEY); return c && typeof c.code === 'string' && c.snap && typeof c.snap === 'object' ? c : null; },
  held() { const h = this.read(this.HELD); return h && Array.isArray(h.changes) && h.changes.length ? h : null; },
  // 지금 브라우저 목록 → 동기화 항목. 서버가 받지 않는 형식은 빼서 요청 전체가 거부되지 않게 한다
  local() {
    const m = new Map();
    for (const w of watch.list()) {
      if (!/^\d{5}$/.test(w.code) || !w.key || w.key.length > 120 || !w.name || w.name.length > 100) continue;
      const v = { name: w.name };
      for (const k of ['jibun', 'region']) if (typeof w[k] === 'string' && w[k].length <= 40) v[k] = w[k];
      if (isArea(w.area) && /^\d{1,4}(\.\d{1,2})?$/.test(w.area)) v.area = w.area;
      if (SYNC_MONTHS.includes(w.months)) v.months = w.months;
      m.set(`w:${w.code}:${w.key}`, v);
    }
    for (const c of regionLikes.list()) if (/^\d{5}$/.test(c)) m.set(`r:${c}`, {});
    return m;
  },
  // 동기화 항목 → 브라우저 목록. 기존 순서를 지키고 새 항목은 뒤에 붙인다. 새로 받은 단지는 지금 빌드부터 새 거래를 센다
  setLocal(items) {
    const old = new Map(watch.list().map((w) => [`w:${w.code}:${w.key}`, w]));
    const no = state.meta?.buildNo || undefined;
    const ids = [...old.keys(), ...regionLikes.list().map((c) => `r:${c}`), ...items.keys()];
    const list = [], likes = [];
    for (const id of new Set(ids)) {
      if (!items.has(id)) continue;
      const [kind, code, ...rest] = id.split(':');
      if (kind === 'r') likes.push(code);
      else list.push({ code, key: rest.join(':'), ...items.get(id), checked: old.get(id)?.checked ?? no });
    }
    watch.save(list, true);
    regionLikes.save(likes, true);
  },
  serverItems(items) { return new Map(Object.entries(items || {}).filter(([, it]) => !it.d).map(([id, it]) => [id, it.v])); },
  pending(c, local = this.local()) {
    const out = [];
    for (const id of new Set([...local.keys(), ...Object.keys(c.snap)])) {
      const s = c.snap[id];
      const v = local.has(id) ? local.get(id) : null;
      if (!syncSame(v, s && !s.d ? s.v : null)) out.push({ id, v, from: s?.r || 0 });
    }
    return out;
  },
  async call(op, body) {
    const text = JSON.stringify(body);
    // text/plain 본문이라 사전 요청(CORS preflight) 없이 보낸다. 코드는 주소가 아니라 본문에만 담는다
    const r = await fetch(`${state.meta.api}/sync/${op}`, { method: 'POST', body: text, keepalive: text.length < 60000 });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText || String(r.status)); e.status = r.status; throw e; }
    return j;
  },
  // 바뀐 게 있을 때만 잠시 모아서 보낸다
  schedule() {
    const c = this.conf();
    if (!c || !this.available() || !this.pending(c).length) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 1500);
  },
  run() {
    clearTimeout(this.timer);
    if (!this.conf() || !this.available()) return Promise.resolve();
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.push().finally(() => {
      this.busy = null;
      if (this.again) { this.again = false; this.run(); }
    });
    return this.busy;
  },
  async push() {
    const c = this.conf();
    const sent = this.local();
    const all = this.pending(c, sent);
    // 변경이 많으면 나눠 보낸다. 삭제를 먼저 보내 중간 상태에서도 서버 항목 수 상한을 넘지 않게 한다
    const changes = [...all.filter((x) => !x.v), ...all.filter((x) => x.v)].slice(0, SYNC_BATCH);
    this.lastRun = Date.now();
    this.setStatus('syncing');
    let j;
    try {
      j = await this.call('push', { code: c.code, base: c.rev, changes });
    } catch (e) {
      if (this.conf()?.code !== c.code) return; // 그 사이 다른 코드로 연결했다. 이전 코드의 오류로 새 연결을 끊지 않는다
      if (e.status === 404) this.drop('이 동기화 코드는 재발급·삭제됐거나 1년간 쓰지 않아 없어졌어요. 연결을 끊었고, 목록은 이 브라우저에 그대로 있어요.');
      else this.setStatus('error');
      return;
    }
    if (this.conf()?.code !== c.code) return; // 그 사이 연결을 바꿨다
    const byId = new Map(changes.map((x) => [x.id, x]));
    // 오래된 기기: 아직 보내지 않은 변경까지 모두 확인을 받는다 (다음 묶음이 확인 없이 적용되지 않게)
    const unsent = j.stale ? new Set() : new Set(all.filter((x) => !byId.has(x.id)).map((x) => x.id));
    const conflicts = new Set(j.stale ? [] : (j.conflicts || []).map((x) => x.id).filter((id) => byId.has(id)));
    if (j.stale) this.hold('stale', all, c);
    else if (conflicts.size) {
      // 보내는 동안 또 바꿨으면 그 값을 기다리게 한다
      const now = this.local();
      this.hold('conflict', [...conflicts].map((id) => ({ id, v: now.get(id) ?? null })), c);
      metrics.track('sync', { k: 'conflict' });
    }
    this.adopt(c.code, j, sent, { batch: new Set(byId.keys()), unsent, conflicts });
    if (unsent.size) this.again = true; // 남은 묶음을 이어서 보낸다
    this.setStatus('ok');
  },
  // 서버 목록을 받아 브라우저 목록에 쓴다. 보내는 동안 이 기기에서 또 바꾼 항목과 아직 보내지 않은 항목(unsent)은 그대로 두고 다음에 보낸다.
  // 이번 묶음(batch)에 없던 그런 항목은 snap에 원래 기준 리비전을 남긴다. 최신 리비전으로 바꾸면 다음 요청이 다른 기기의 변경을 충돌 없이 덮어쓴다.
  // 충돌 난 항목(conflicts)은 서버 값을 보여 주고, 이 기기 값은 hold로 확인을 기다린다
  adopt(code, j, sent, { batch = new Set(), unsent = new Set(), conflicts = new Set() } = {}) {
    const now = this.local();
    const next = this.serverItems(j.items);
    const before = this.conf()?.snap || {};
    const snap = { ...j.items };
    // 아직 보내지 않은 삭제는 지금 목록에도 보낸 목록에도 없으므로 unsent도 함께 본다
    for (const id of new Set([...now.keys(), ...sent.keys(), ...unsent])) {
      if (conflicts.has(id) || (!unsent.has(id) && syncSame(now.get(id), sent.get(id)))) continue;
      if (now.has(id)) next.set(id, now.get(id)); else next.delete(id);
      if (!batch.has(id)) { if (before[id]) snap[id] = before[id]; else delete snap[id]; }
    }
    this.write(this.KEY, { code, rev: j.rev, snap, at: Date.now() });
    const changed = next.size !== now.size || [...next].some(([id, v]) => !now.has(id) || !syncSame(v, now.get(id)));
    if (changed) this.setLocal(next);
    this.schedule();
    if (changed && location.hash.startsWith('#/watch')) route();
  },
  // 사용자 확인을 기다리는 변경. 이름은 지금(서버 값으로 바뀌기 전) 목록에서 찾아 둔다
  hold(reason, changes, c) {
    if (!changes.length) return;
    const local = this.local();
    const named = changes.map(({ id, v }) => {
      const s = c?.snap?.[id];
      return { id, v, name: id.startsWith('r:') ? regionOf(id.slice(2))?.name || id.slice(2) : (v || local.get(id) || (s && s.v))?.name || id.split(':').slice(2).join(':') };
    });
    // 같은 항목이 이미 기다리고 있으면 새 변경으로 바꾼다
    const prev = (this.held()?.changes || []).filter((x) => !named.some((n) => n.id === x.id));
    this.write(this.HELD, { reason, changes: [...prev, ...named] });
  },
  // 기다리던 변경 적용: 브라우저 목록에 쓰고 보낸다 (snap에 지금 서버 리비전이 있으므로 이번에는 적용된다)
  applyHeld() {
    const h = this.held();
    this.write(this.HELD, null);
    if (!h) return;
    const next = this.local();
    for (const { id, v } of h.changes) { if (v) next.set(id, v); else next.delete(id); }
    this.setLocal(next);
    this.run();
  },
  discardHeld() { this.write(this.HELD, null); },
  // 새 코드: 지금 목록을 올린다
  async create() {
    const j = await this.call('create', { changes: [...this.local()].map(([id, v]) => ({ id, v, from: 0 })) });
    this.write(this.KEY, { code: j.code, rev: j.rev, snap: j.items, at: Date.now() });
    this.write(this.HELD, null);
    metrics.track('sync', { k: 'create' });
  },
  // 다른 기기의 코드에 연결: 서버 목록을 받고, 이 기기에만 있거나 값이 다른 항목은 합칠지 묻는다
  async link(input) {
    const code = normalizeSyncCode(input);
    if (!code) throw new Error('코드 형식이 맞지 않아요. 26자를 그대로 넣어 주세요');
    let j;
    try {
      j = await this.call('push', { code, base: 0, changes: [] });
    } catch (e) {
      throw e.status === 404 ? new Error('없는 코드예요. 재발급·삭제됐거나 1년간 쓰지 않은 코드일 수 있어요') : e;
    }
    const server = this.serverItems(j.items);
    const extra = [...this.local()].filter(([id, v]) => !syncSame(v, server.get(id))).map(([id, v]) => ({ id, v }));
    this.write(this.HELD, null);
    this.hold('link', extra);
    this.write(this.KEY, { code, rev: j.rev, snap: j.items, at: Date.now() });
    this.setLocal(server);
    this.notice = '';
    metrics.track('sync', { k: 'link' });
  },
  async rotate() {
    const c = this.conf();
    await this.run();
    const j = await this.call('rotate', { code: c.code });
    this.write(this.KEY, { ...this.conf(), code: j.code });
    metrics.track('sync', { k: 'rotate' });
  },
  async remove() {
    const c = this.conf();
    try { await this.call('delete', { code: c.code }); } catch (e) { if (e.status !== 404) throw e; }
    this.drop('');
    metrics.track('sync', { k: 'delete' });
  },
  // 이 기기만 연결 해제 (서버 목록과 다른 기기는 그대로)
  unlink() { this.drop(''); metrics.track('sync', { k: 'unlink' }); },
  drop(notice) {
    clearTimeout(this.timer);
    this.write(this.KEY, null);
    this.write(this.HELD, null);
    this.notice = notice;
    this.setStatus('');
  },
  setStatus(s) { this.status = s; document.dispatchEvent(new Event('ht:sync')); },
};
// sync.mjs normalizeCode와 같은 규칙: 대소문자·하이픈·공백 무시, i·l → 1, o → 0
function normalizeSyncCode(s) {
  const c = String(s || '').toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  return /^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(c) ? c : null;
}

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
// label: 축 라벨에 붙일 이름('매매'), swatch: 선 색을 따라 바뀌는 범례 표시, extra: 함께 그릴 표식(정책 발표일)
function trackRange(chart, s, ma, line, onChange, label, swatch, extra = () => []) {
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
    markers.setMarkers([...ext.map(([i, , color]) => ({ time: ymSec(s[i].ym), position: 'inBar', shape: 'circle', color, size: 0.6 })), ...extra()].sort((x, y) => x.time - y.time));
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

// 정책 발표일 (로드맵 9번): 발표한 달의 선 위에 작은 ▼. 같은 달 여러 건은 표식 하나로 두고 설명 줄에 적는다.
// 이동평균이 없는 달(처음 몇 달·신고 진행 중인 달)은 표식 없이 설명 줄에만 나온다
function policyLayer(s, list, ma) {
  const byYm = new Map();
  list.forEach((p) => { const ym = p.announced.slice(0, 4) + p.announced.slice(5, 7); byYm.set(ym, [...(byYm.get(ym) || []), p]); });
  return {
    any: s.some((r) => byYm.has(r.ym)),
    at: (ym) => byYm.get(ym) || [],
    markers: () => s.flatMap((r, i) => (byYm.has(r.ym) && ma[i] != null ? [{ time: ymSec(r.ym), position: 'aboveBar', shape: 'arrowDown', color: css('--ink-2'), size: 0.5 }] : [])),
  };
}
const policyHead = (ps) => (ps.length ? `<span class="pol-mark">▼</span> ${esc(ps[0].title)}${ps.length > 1 ? ` 외 ${ps.length - 1}건` : ''}` : '');
const policyChip = (on) => `<button data-s="policy" class="${on ? 'on' : ''}" title="정책 발표일을 차트에 표시해요. 눌러서 켜고 끄기"><span class="pol-mark">▼</span>정책 발표</button>`;
const policyNote = (code) => ` · <span class="pol-mark">▼</span> = 정책 발표 (<a href="#/policy/${code}">이 지역 정책 타임라인</a>)`;

// 전세 보기의 시계열: 전세 이동평균·중위값·건수를 매매 자리에 넣어 같은 차트로 그린다 (겹쳐 그릴 전세선은 없음)
const jeonseView = (s) => s.map((r) => ({ ...r, ma: r.jeonseMa, median: r.jeonse, count: r.jeonseCount, bulk: 0, jeonseMa: null }));
// 지역 평당가 + 거래량. 토스증권처럼 위의 큰 숫자가 십자선을 따라 바뀐다. L: 주 시리즈 이름('매매'·'전세')
function priceVolumeChart(s, ind, L = '매매', pols = []) {
  const chart = tvChart(document.getElementById('pv'));
  const last = s.length - 1; // 신고 진행 중인 달: 이동평균은 그리지 않고(지표와 같은 기준) 거래량만 옅게
  const ma = s.map((r, i) => (i < last ? r.ma : null));
  const pol = policyLayer(s, pols, ma);
  const pt = (r, v) => (v == null ? { time: ymSec(r.ym) } : { time: ymSec(r.ym), value: v });
  const manFmt = { type: 'custom', minMove: 1, formatter: fmtMan };
  const price = chart.addSeries(LWC.AreaSeries, { title: L, lineWidth: 2, priceFormat: manFmt, priceLineStyle: LWC.LineStyle.Dotted, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: css('--surface') });
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
      state.pv.median && r.median != null ? `${L} 월 중위 ${fmtMan(r.median)}` : '',
      state.pv.jeonse && k < last && r.jeonseMa != null ? `전세 이동평균 ${fmtMan(r.jeonseMa)}` : '',
      `${L} 거래 ${r.count}건${r.bulk ? ` (+일괄 ${r.bulk})` : ''}${k === last ? ' · 신고 진행 중' : ''}`,
      state.pv.policy ? policyHead(pol.at(r.ym)) : '',
    ]);
  };
  const onRange = trackRange(chart, s, ma, price, (a1, b1) => { [a, b] = [a1, b1]; showHead(null); }, L, document.getElementById('pvSwatch'), () => (state.pv.policy ? pol.markers() : []));
  const byTime = new Map(s.map((r, i) => [ymSec(r.ym), i]));
  chart.subscribeCrosshairMove((p) => showHead(p.time != null ? byTime.get(p.time) ?? null : null));

  const series = { median, jeonse };
  app.querySelectorAll('#pvToggle button').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.s;
    state.pv[k] = !state.pv[k];
    btn.classList.toggle('on', state.pv[k]);
    if (k === 'policy') onRange();
    else series[k].applyOptions({ visible: state.pv[k] });
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
// 점(월봉 모드에선 그 달)을 누르면 상세 카드가 뜨고, 카드에서 그 거래를 '기준'으로 잡으면 큰 숫자 옆 등락률이 기준 대비로 바뀐다.
// 전세 보기는 L = '전세'로 부르고 전세 거래를 allTrades(price = 보증금), 전세 이동평균을 sel.series의 ma에 넣어 준다 (겹쳐 그릴 전세는 없음)
function aptChart(sel, allTrades, allJeonse, L = '매매', pols = []) {
  const s = sel.series, last = s.length - 1;
  const o = state.ap;
  const ymOf = (t) => t.date.slice(0, 4) + t.date.slice(5, 7);
  // 신고가: 조회 시작 1년 뒤부터, 같은 평형의 이전 최고가를 넘은 매매 (처음 1년은 비교 대상이 적어 빼고)
  const warm = allTrades.length ? `${+allTrades[0].date.slice(0, 4) + 1}${allTrades[0].date.slice(4)}` : '';
  let top = -Infinity;
  const tradePts = allTrades.map((t, n) => {
    const high = L === '매매' && t.date >= warm && t.price > top, prevTop = top > 0 ? top : null; // 신고가 표시는 매매만
    top = Math.max(top, t.price);
    return { id: n, y: t.price, dx: dayOffset(t.date), ym: ymOf(t), t, kind: L, high, prevTop };
  });
  const jeonsePts = allJeonse.map((t, n) => ({ id: 1e6 + n, y: t.deposit, dx: dayOffset(t.date), ym: ymOf(t), t, kind: '전세' }));
  const low = (p) => p.t.floor <= 3; // 저층(지하 포함)은 시세보다 낮게 거래되는 경우가 많다

  const chart = tvChart(document.getElementById('ap'));
  chart.applyOptions({ crosshair: { mode: LWC.CrosshairMode.Normal } });
  const eokFmt = { type: 'custom', minMove: 1, formatter: fmtEok };
  const ma = s.map((r, i) => (i < last ? r.ma : null));
  const pol = policyLayer(s, pols, ma);
  const pt = (r, v) => (v == null ? { time: ymSec(r.ym) } : { time: ymSec(r.ym), value: v });
  const line = chart.addSeries(LWC.AreaSeries, { title: L, lineWidth: 2, priceFormat: eokFmt, priceLineStyle: LWC.LineStyle.Dotted, crosshairMarkerVisible: false });
  line.setData(s.map((r, i) => pt(r, ma[i])));
  const jLine = chart.addSeries(LWC.LineSeries, { title: '전세', color: css('--series-2'), lineWidth: 2, priceFormat: eokFmt, priceLineVisible: false, crosshairMarkerVisible: false });
  jLine.setData(s.map((r, i) => pt(r, i < last ? r.jeonseMa : null)));
  const dotOpts = { priceFormat: eokFmt, ring: css('--up'), focus: css('--ink') };
  const jView = new DotsView(), tView = new DotsView();
  const jDots = chart.addCustomSeries(jView, { ...dotOpts, color: css('--series-2') });
  const tDots = chart.addCustomSeries(tView, { ...dotOpts, color: css(L === '매매' ? '--series-1' : '--series-2') });
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
        anchor && anchor !== dot ? vs(dot.y) : (dot.kind === L && m ? `${delta(dot.y / m - 1)} <span class="muted">${L} 6개월 이동평균 대비</span>` : ''),
        dot.kind === L ? `평당 ${fmtMan(dot.y / (t.area / PYEONG))}` : '',
      ]);
      return;
    }
    const i = k ?? b, r = s[i], v = ma[i];
    const ts = shownT.filter((p) => p.ym === r.ym), js = shownJ.filter((p) => p.ym === r.ym);
    headValue.innerHTML = v != null ? fmtEok(v) : '<span class="muted">이동평균 없음</span>';
    headSub.innerHTML = headJoin([
      `<b>${fmtYm(r.ym)}</b>`,
      v != null && anchor ? vs(v) : v != null && i > a ? `${delta(v / ma[a] - 1)} <span class="muted">${fmtYm(s[a].ym)} 대비</span>` : '',
      ts.length ? `${L} ${ts.length}건 ${range(ts)}` : `${L} 없음`,
      js.length ? `전세 ${js.length}건 ${range(js)}` : '',
      i === last ? '신고 진행 중' : '',
      o.policy ? policyHead(pol.at(r.ym)) : '',
    ]);
  };
  const onRange = trackRange(chart, s, ma, line, (a1, b1) => { [a, b] = [a1, b1]; showHead(null); }, L, document.getElementById('apSwatch'), () => (o.policy ? pol.markers() : []));

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
    const same = (dot.kind === L ? shownT : shownJ).filter((q) => q.ym === dot.ym);
    const isAnchor = anchor === dot;
    return `<div class="pop-head"><span class="pop-kind"><i class="dot" style="background:${css(dot.kind === '매매' ? '--series-1' : '--series-2')}"></i>${dot.kind}</span><span class="muted">${t.date.replace(/-/g, '.')}</span><button type="button" class="pop-x" aria-label="닫기">×</button></div>
      <div class="pop-value num">${fmtEok(dot.y)}${dot.high ? ' <span class="tag high">신고가</span>' : ''}</div>
      <dl class="pop-rows num">
        ${row('층 · 전용', `${t.floor}층 · ${t.area}㎡`)}
        ${dot.kind === L ? row('평당가', fmtMan(dot.y / (t.area / PYEONG))) : ''}
        ${dot.kind === L && t.kind ? row('거래 유형', esc(t.kind)) : ''}
        ${dot.kind === L && m ? row('6개월 이동평균 대비', delta(dot.y / m - 1)) : ''}
        ${dot.kind === L && dot.prevTop ? row(L === '매매' ? '직전 최고가 대비' : '직전 최고 보증금 대비', `${delta(dot.y / dot.prevTop - 1)} <span class="muted">${fmtEok(dot.prevTop)}</span>`) : ''}
        ${L === '매매' && dot.kind === '전세' && m ? row('매매 이동평균 대비 (전세가율)', fmtPct(dot.y / m, 0)) : ''}
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
      <div class="pop-value num">${ma[i] != null ? fmtEok(ma[i]) : '–'} <span class="muted" style="font-size:12px;font-weight:400">${L} 6개월 이동평균</span></div>
      <dl class="pop-rows num">${part(L, ts)}${o.jeonse && L === '매매' ? part('전세', js) : ''}</dl>`;
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
    document.getElementById('apKind').textContent = o.mode === 'dots' ? `${L} 실거래` : `${L} 월봉`;
    const jk = document.getElementById('apJKind');
    if (jk) jk.textContent = o.mode === 'dots' ? '전세 실거래·이동평균' : '전세 월봉·이동평균';
    openCard(null);
    app.querySelectorAll('#apMode button').forEach((x) => x.classList.toggle('on', x === btn));
    apply(); showHead(null);
  }));
  app.querySelectorAll('#apToggle button').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.s;
    o[k] = !o[k];
    btn.classList.toggle('on', o[k]);
    if (k === 'policy') onRange();
    apply(); showHead(null);
    if (pinned?.dot && !(pinned.dot.kind === L ? shownT : shownJ).includes(pinned.dot)) openCard(null);
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
      initRegionJump();
      watch.adopt(state.meta.buildNo);
      document.dispatchEvent(new Event('ht:meta')); // 먼저 눌러 둔 검색창이 이어서 목록을 받도록
      metrics.track('visit', isJ() ? { j: 1 } : undefined);
      sync.run(); // 동기화 코드를 연결했으면 다른 기기에서 바꾼 목록을 받는다
    }
    let parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    // 동기화 링크: 코드가 방문 기록에 남지 않게 주소를 관심단지로 바꾸고 연결한다
    if (parts[0] === 'sync') {
      history.replaceState(null, '', '#/watch');
      linkFromUrl(parts[1]);
      parts = ['watch'];
    }
    const view = parts[0];
    const tab = view === 'r' || view === 'a' ? regionOf(parts[1])?.group
      : view === 'watch' ? 'watch'
      : view === 'privacy' ? null
      : view === 'policy' ? 'policy'
      : view === 'g' && parts[1] ? parts[1] : '서울';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    // 화면 종류만 기록 (기간·테마·매매/전세 보기를 바꿔 다시 그려도 같은 화면으로 센다. 집계는 기기 수 기준)
    const j = isJ() && view !== 'privacy' ? { j: 1 } : undefined;
    // 정책 타임라인은 측정 행동 종류(infra/functions/metrics)에 아직 없어 보내지 않는다
    if (!state.keepView && !state.dealSwitch && view !== 'policy') metrics.track(view === 'r' ? 'view_region' : view === 'a' ? 'view_apt' : view === 'watch' ? 'view_watch' : view === 'privacy' ? 'view_privacy' : 'view_overview', view === 'watch' ? { n: watch.list().length, ...j } : j);
    state.dealSwitch = false;
    if (view === 'r') await viewRegion(parts[1], id);
    else if (view === 'a') await viewApt(parts[1], parts.slice(2).join('/'), id);
    else if (view === 'watch') await viewWatch(id);
    else if (view === 'privacy') viewPrivacy();
    else if (view === 'policy') await viewPolicy(parts[1], id);
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
const getSearch = () => (state.search ||= api(STATIC ? 'data/search.json' : '/api/search').then(async (idx) => {
  // v1 검색 목록에는 주소가 없다. 별칭이 있는 지역만 원본으로 확인해 중복을 없앤다.
  await Promise.all(Object.entries(idx.regions).map(async ([code, entries]) => {
    if (!entries.some(([dong, apt, , jibun]) => jibun === undefined && window.ComplexAliases.some((a) => a.code === code && a.dong === dong && a.names.includes(apt)))) return;
    try { idx.regions[code] = A.searchEntries((await getRaw(code, 36)).trades); } catch (_) { /* 원본 조회 실패 시 기존 검색 결과 유지 */ }
  }));
  return idx;
}).catch((e) => { state.search = null; throw e; }));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
function searchFlat(idx) {
  return state.meta.regions.flatMap((r) => {
    const entries = idx.regions[r.code] || [];
    const grouped = new Map();
    for (const [dong, name, cnt, jibun] of entries) {
      const key = A.aptKey(A.normalizeRows(r.code, [{ dong, apt: name, jibun }])[0]);
      const apt = key.slice(dong.length + 1);
      const old = grouped.get(key);
      if (old) { old.cnt += cnt; continue; }
      grouped.set(key, { r, dong, apt, cnt, na: norm(A.apartmentNames(r.code, dong, apt, jibun).join(' ')), nd: norm(dong) });
    }
    return [...grouped.values()];
  });
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
  // open: 사용자가 결과창을 열어 둔 상태. 목록 로딩·meta 도착으로 다시 그릴 때 닫은 창을 열지 않게 따로 둔다
  let flat = null, items = [], sel = 0, partial = false, failed = false, loading = false, open = false;
  const href = (it) => (it.apt ? `#/a/${it.r.code}/${encodeURIComponent(`${it.dong}|${it.apt}`)}` : `#/r/${it.r.code}`);
  const close = () => { open = false; list.hidden = true; };
  const draw = () => {
    const q = input.value;
    list.hidden = !open || !q.trim();
    if (list.hidden) return;
    if (!state.meta) { // 첫 화면을 불러오기 전 (모바일에서 흔함)
      items = [];
      list.innerHTML = '<div class="gs-msg muted">불러오는 중…</div>';
      return;
    }
    items = searchMatch(flat || [], q);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = (items.length
      ? items.map((it, i) => `<a class="gs-item${i === sel ? ' on' : ''}" href="${href(it)}" data-i="${i}">${it.apt
        ? `<b>${highlight(it.apt, q)}</b><span class="muted">${esc(it.r.name)} ${highlight(it.dong, q)} · 거래 ${it.cnt}건</span>`
        : `<b>${highlight(it.r.name, q)}</b><span class="muted">지역 · ${esc(it.r.group)}</span>`}</a>`).join('')
      : '<div class="gs-msg">찾는 단지가 없어요</div>')
      + (!flat ? `<div class="gs-msg muted">${failed ? '단지 목록을 불러오지 못했어요. 지역은 바로 선택할 수 있어요.' : '단지 목록 불러오는 중…'}</div>` : '')
      + (partial ? '<div class="gs-msg muted">로컬 서버에선 받아 둔 지역의 단지만 검색돼요</div>' : '');
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  // 단지 목록 받기. 첫 화면 전이면 meta가 온 뒤(ht:meta) 다시 불린다
  const load = () => {
    if (flat || loading || !state.meta) return;
    loading = true; failed = false;
    getSearch().then((idx) => { flat = searchFlat(idx); partial = !!idx.partial; }, () => { failed = true; })
      .finally(() => { loading = false; draw(); });
  };
  input.addEventListener('focus', () => { open = true; load(); draw(); });
  input.addEventListener('input', () => { open = true; sel = 0; load(); draw(); });
  document.addEventListener('ht:meta', () => { if (open) { load(); draw(); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      open = true; draw();
    } else if (e.key === 'Enter' && items[sel] && !list.hidden) {
      metrics.track('search', { k: items[sel].apt ? 'apt' : 'region' });
      location.hash = href(items[sel]);
      input.value = ''; close(); input.blur();
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });
  list.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    metrics.track('search', { k: items[a.dataset.i]?.apt ? 'apt' : 'region' });
    input.value = ''; close();
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close(); });
  // '/' 키로 검색창으로
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
}());

// ---------- 개요: 지역별 비교 ----------
const hasMissing = (code) => (state.meta?.missing || []).some((m) => m.startsWith(`${code}/`));
const tradeMissing = (code) => (state.meta?.missing || []).some((m) => m.startsWith(`${code}/trade/`)) || !!state.meta?.partial?.missing.includes(code);
const candidateCell = (r) => {
  const c = hasMissing(r.code) ? null : r.ind?.candidate;
  return c ? `<span title="${esc(c.factors.map((f) => `${f.name} ${f.points}점`).join(' · '))}">${c.score}점</span>` : '<span class="muted">–</span>';
};
function forecastFor(code, horizon) {
  const data = state.forecasts;
  if (!data || data.version !== 2 || data.source !== 'live' || (state.meta.source || state.meta.mode) !== 'live' || hasMissing(code)) return null;
  if (state.meta.yms && state.meta.yms[state.meta.yms.length - 2] !== data.asOf) return null;
  return data.regions?.[code]?.[horizon] || null;
}
function forecastCell(r, horizon) {
  const f = forecastFor(r.code, horizon);
  if (f?.status !== 'available') return '<span class="muted" title="검증 기준 미달·표본 부족·수집 누락 시 예측을 보류합니다">보류</span>';
  return `<span title="${fmtYm(f.asOf)} → ${fmtYm(f.targetYm)} · 오차 참고 범위 ${fmtPct(f.lower)} ~ ${fmtPct(f.upper)}">${delta(f.change)}<br><small class="muted">${fmtPct(f.lower)} ~ ${fmtPct(f.upper)}</small></span>`;
}
function forecastNote() {
  const data = state.forecasts;
  if (!data) return '단기 예측 데이터를 확인하는 중입니다.';
  if (data.status === 'unavailable') return '단기 예측 데이터를 불러오지 못했습니다.';
  if (data.source !== 'live' || (state.meta.source || state.meta.mode) !== 'live') return '실거래 데이터와 검증 결과가 있을 때 단기 예측을 표시합니다. 데모에서는 표시하지 않습니다.';
  if (state.meta.yms && state.meta.yms[state.meta.yms.length - 2] !== data.asOf) return '예측 기준월이 현재 데이터와 달라 수치를 표시하지 않습니다.';
  if (data.version !== 2) return '예측 데이터가 갱신되면 표시합니다.';
  const available = Object.values(data.validation || {}).filter((v) => v.status === 'passed');
  return available.length ? `${fmtYm(data.asOf)} 기준월 이후 3·6개월의 구성 보정 평당가(3개월 이동평균) 변화를 검증하며, 통과한 기간·지역의 예측만 표시합니다. 범위는 과거 오차를 참고한 값이며 향후 포함 확률을 보장하지 않습니다.` : '현재 검증 기준을 통과한 단기 예측이 없어 수치를 보류합니다.';
}
function forecastReason(code, horizon) {
  const f = forecastFor(code, horizon);
  if (hasMissing(code)) return '수집 누락이 있어 예측을 보류합니다.';
  if (f?.reason === 'regional_validation_failed') return '이 지역에서는 가격 유지 기준보다 오차가 작지 않아 보류합니다.';
  if (f?.reason === 'validation_failed') return state.forecasts.validation[horizon]?.intervalCoverage < 0.7
    ? '오차 범위 검증을 통과하지 못해 예측을 보류합니다.' : '가격 유지 기준과 비교한 검증을 통과하지 못해 보류합니다.';
  return '실거래 이력과 검증 결과가 충분할 때 표시합니다.';
}
function forecastCard(code, brokerOnly) {
  const horizons = [3, 6];
  return `<section class="card" id="shortForecast"><h2>단기 가격 예측 (실험)</h2><p class="muted">${esc(forecastNote())}</p>${brokerOnly
    ? '<p class="muted">단기 예측은 전체 거래 기준에서만 표시됩니다.</p>'
    : `<div class="kpis">${horizons.map((h) => {
      const f = forecastFor(code, h);
      return f?.status === 'available' ? `<div class="kpi"><div class="label">${h}개월 뒤 · ${fmtYm(f.targetYm)}</div><div class="value num">${delta(f.change)}</div><div class="hint">오차 참고 범위 ${fmtPct(f.lower)} ~ ${fmtPct(f.upper)}</div><div class="hint">지역 평균 오차 ${(f.regionalMae * 100).toFixed(1)}%p (${f.regionalSamples}개 기준월)</div><div class="hint">전체 검증 평균 오차 ${(f.validation.mae * 100).toFixed(1)}%p (${f.validation.sampleCount}개 지역·시점)</div><div class="hint">통과 판정과 같은 표본의 지역 오차라 낙관적일 수 있습니다.</div><div class="hint">범위 산정 ${fmtYm(f.intervalStart)}~${fmtYm(f.intervalEnd)} · ${f.intervalSamples}개 지역·시점</div></div>` : `<div class="kpi"><div class="label">${h}개월 뒤</div><div class="value muted">예측 보류</div><div class="hint">${esc(forecastReason(code, h))}</div></div>`;
    }).join('')}</div>`}<details><summary>검증 기준과 한계</summary><p>과거 결과가 확인된 표본만 학습에 사용하고, 모델 선택 기간과 최종 검증 기간을 분리합니다. 최종 6개 기준월·200개 지역·시점 이상에서 가격 유지 기준보다 평균 오차가 5% 이상 작고, 오차 범위의 실제 포함률이 70% 이상일 때 표시합니다. 각 지역도 가격 유지 기준보다 오차가 작아야 합니다. 지역별 통과 판정과 지역 평균 오차는 같은 6개 기준월에서 계산하므로, 통과 지역의 오차가 낙관적으로 보일 수 있습니다.</p><p>과거 신고일·정정·취소 이력이 없어 당시 공개된 정보만의 검증은 아닙니다. 인접 월과 지역은 독립 표본이 아니며, 공급·금리·교통·정비사업과 향후 정책 변화는 반영하지 않았습니다. 단지별 매매가나 급등 확률을 뜻하지 않습니다.</p></details></section>`;
}
const regionLikes = {
  list() { try { const v = JSON.parse(localStorage.getItem('homeTrend.regionLikes')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; } },
  has(code) { return this.list().includes(code); },
  save(list, quiet) { try { localStorage.setItem('homeTrend.regionLikes', JSON.stringify(list)); } catch (_) {} if (!quiet) sync.schedule(); },
  toggle(code) { const list = this.list(); this.save(list.includes(code) ? list.filter((x) => x !== code) : [...list, code]); },
};
function initRegionJump() {
  const select = document.getElementById('regionJump');
  select.innerHTML = '<option value="">지역 바로가기</option>' + ['서울', '경기'].map((group) => `<optgroup label="${group}">${state.meta.regions.filter((r) => r.group === group).sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((r) => `<option value="${r.code}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('');
  select.onchange = () => { if (select.value) location.hash = `#/r/${select.value}`; select.value = ''; };
}
const OV_COLS = [
  ['name', '지역', (r) => r.name, (r) => `<button class="star ${r.liked ? 'on' : ''}" data-like-region="${r.code}" aria-label="${esc(r.name)} 좋아요" aria-pressed="${!!r.liked}">♥</button> <a href="#/r/${r.code}">${esc(r.name)}</a>`],
  ['current', '평당가 (3개월 평균)', (r) => r.ind?.current, (r) => fmtMan(r.ind?.current)],
  ['eq84', '84㎡ 환산', (r) => r.ind?.current, (r) => (r.ind?.current ? fmtEok(Math.round(r.ind.current * 84 / PYEONG / 100) * 100) : '–')],
  ['chg3m', '3개월', (r) => r.ind?.chg3m, (r) => delta(r.ind?.chg3m)],
  ['chg12m', '12개월', (r) => r.ind?.chg12m, (r) => delta(r.ind?.chg12m)],
  ['fromPeak', '5년 고점 대비', (r) => r.ind?.fromPeak, (r) => (r.ind ? `${delta(r.ind.fromPeak)} <span class="muted">${fmtYm(r.ind.peakYm)}</span>` : '–')],
  ['volVsAvg', '거래량 (장기평균 대비)', (r) => r.ind?.volVsAvg, (r) => (r.ind ? `${r.ind.volRecent}건/월 ${delta(r.ind.volVsAvg, 0)}` : '–')],
  ['newHighShare', '신고가 비율', (r) => r.ind?.newHighShare, (r) => fmtPct(r.ind?.newHighShare, 0)],
  ['jeonseRatio', '전세가율', (r) => r.ind?.jeonseRatio, (r) => fmtPct(r.ind?.jeonseRatio, 0)],
  ['weekly4w', '주간지수 4주 (부동산원)', (r) => rebInd(r.code)?.weekly?.chg4w, (r) => { const w = rebInd(r.code)?.weekly; return w ? `<span title="${fmtDate(w.date)} 주 기준 · 1주 ${fmtPct(w.chg1w, 2)}">${delta(w.chg4w, 2)}</span>` : '<span class="muted">–</span>'; }],
  ['outside', '외지인 매입 (3개월)', (r) => rebInd(r.code)?.buyers?.outsideShare, (r) => outsideCell(rebInd(r.code)?.buyers)],
  ['phase', '국면', (r) => r.ind?.phase?.id, (r) => (r.error ? `<span class="err" title="${esc(r.error)}">오류</span>` : r.ind ? phaseChip(r.ind.phase) : '<span class="muted">불러오는 중…</span>')],
  ['candidate', '상승 후보 (실험)', (r) => hasMissing(r.code) ? null : r.ind?.candidate?.score, candidateCell],
  ['forecast3', '3개월 예측 (실험)', null, (r) => forecastCell(r, 3)],
  ['forecast6', '6개월 예측 (실험)', null, (r) => forecastCell(r, 6)],
  ['spark', '24개월 추이', null, (r) => (r.series ? sparkline(r.series.slice(-24).map((s) => s.ma)) : '')],
];
// 전세 보기의 지역 표: 전세 거래로 계산한 지표(ind.jeonse)와 부동산원 주간 전세지수.
// 신고가 비율·외지인 매입·국면·후보 점수·예측은 매매 기준이라 뺀다
const jInd = (r) => r.ind?.jeonse;
const OV_J_COLS = [
  OV_COLS[0],
  ['current', '평당 전세가 (3개월 평균)', (r) => jInd(r)?.current, (r) => (r.error ? `<span class="err" title="${esc(r.error)}">오류</span>` : r.ind ? fmtMan(jInd(r)?.current) : '<span class="muted">불러오는 중…</span>')],
  ['eq84', '84㎡ 환산', (r) => jInd(r)?.current, (r) => (jInd(r)?.current ? fmtEok(Math.round(jInd(r).current * 84 / PYEONG / 100) * 100) : '–')],
  ['chg3m', '3개월', (r) => jInd(r)?.chg3m, (r) => delta(jInd(r)?.chg3m)],
  ['chg12m', '12개월', (r) => jInd(r)?.chg12m, (r) => delta(jInd(r)?.chg12m)],
  ['fromPeak', '5년 고점 대비', (r) => jInd(r)?.fromPeak, (r) => (jInd(r) ? `${delta(jInd(r).fromPeak)} <span class="muted">${fmtYm(jInd(r).peakYm)}</span>` : '–')],
  ['volVsAvg', '전세 거래량 (장기평균 대비)', (r) => jInd(r)?.volVsAvg, (r) => (jInd(r) ? `${jInd(r).volRecent}건/월 ${delta(jInd(r).volVsAvg, 0)}` : '–')],
  OV_COLS.find(([k]) => k === 'jeonseRatio'),
  ['weekly4w', '주간 전세지수 4주 (부동산원)', (r) => rebInd(r.code)?.weekly?.jeonseChg4w, (r) => { const w = rebInd(r.code)?.weekly; return w?.jeonseChg4w != null ? `<span title="${fmtDate(w.date)} 주 기준${w.jeonseChg1w != null ? ` · 1주 ${fmtPct(w.jeonseChg1w, 2)}` : ''}">${delta(w.jeonseChg4w, 2)}</span>` : '<span class="muted">–</span>'; }],
  ['spark', '24개월 추이', null, (r) => (r.series ? sparkline(r.series.slice(-24).map((s) => s.jeonseMa)) : '')],
];

// 외지인(다른 시·구 거주자) 매입 비중과 장기 평균(36개월) 대비 차이(%p)
function outsideCell(b) {
  if (b?.outsideShare == null) return '<span class="muted">–</span>';
  const d = b.outsideLong == null ? null : Math.round((b.outsideShare - b.outsideLong) * 1000) / 10;
  const diff = d == null ? '' : `<br><small class="${d > 0 ? 'up' : d < 0 ? 'down' : 'muted'}">${d > 0 ? '+' : ''}${d.toFixed(1)}%p</small>`;
  return `<span title="${fmtYm(b.ym)}까지 3개월 ${b.count3m.toLocaleString()}건 · 장기 평균 ${fmtPct(b.outsideLong, 0)}">${fmtPct(b.outsideShare, 0)}${diff}</span>`;
}
// 개요 상단: 부동산원 주간지수로 본 서울·경기 최근 흐름 (실거래보다 빠름)
function rebLead(group) {
  const w = state.reb?.groups?.[group]?.ind?.weekly;
  if (!w) return '';
  // delta(x, 2)가 0.00%로 표시하는 범위만 보합으로 본다
  const word = (x) => (x == null ? '–' : Math.abs(x) * 100 < 0.005 ? '보합' : delta(x, 2));
  const [c4, c1] = isJ() ? [w.jeonseChg4w, w.jeonseChg1w] : [w.chg4w, w.chg1w];
  return `한국부동산원 주간지수(${fmtDate(w.date)} 주)로는 ${esc(group)} 아파트 ${dealName()}가가 최근 4주 ${word(c4)}, 지난주 ${word(c1)}예요. ${tip('한국부동산원이 매주 표본 아파트의 시세를 조사해 낸 지수예요. 실거래가 아니라 조사 가격이라 실거래 지표와 다를 수 있지만, 신고를 기다리지 않아 1~2개월 더 빨리 흐름을 보여줘요.')}`;
}

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

// ---------- 첫 화면: 오늘 들어온 거래 (data/changes.json) ----------
// 새로 확인된 거래 = 이번 데이터 갱신에서 처음 확인된 거래. 계약일·신고일과 다르다
const FEED_ROWS = 8;
const FEED_HELP = '이 날 데이터 갱신에서 처음 확인된 매매 거래예요. 신고일과는 다를 수 있고, 계약일이 지난 거래가 늦게 신고되면 여기에 들어와요. 삭제는 지난 갱신에 있던 거래가 사라진 것으로, 해제·정정을 구분하지 않아요. 해제·정정은 최근 12개월 매매만 다시 확인해요. 이번 달 계약도 신고되는 대로 보여 주지만, 신고가 진행 중이라 지역 지표·차트에는 다음 달부터 반영해요. 급등은 이미 신고된 거래와 공개 지수 기준이며 앞으로의 가격을 뜻하지 않아요.';
const flagTags = (x) => `${isPartialDate(x.date) ? ` ${partialTag}` : ''}${x.flags?.includes('surge') ? ' <span class="tag high">급등</span>' : x.flags?.includes('highPrice') ? ' <span class="tag">높은 가격</span>' : ''}${x.flags?.includes('high') ? ' <span class="tag high">신고가</span>' : ''}${x.direct ? ' <span class="tag">직거래</span>' : ''}`;
const aptLink = (x) => `<a href="#/a/${x.code}/${encodeURIComponent(x.key)}">${esc(x.name)}</a>`;
const regionShort = (code) => (regionOf(code)?.name || code).replace(/ \(.+\)/, '');
const phaseLabel = (id) => `${id ? `${id}국면 ` : ''}${A.PHASES[id]?.name || ''}`;
function eventLine(x) {
  const region = `<a href="#/r/${x.code}">${esc(regionShort(x.code))}</a>`;
  if (x.type === 'surge') return `<span class="up">급등</span> ${region} ${aptLink(x)} ${x.area}㎡ — ${fmtEok(x.price)} (${fmtDate(x.date)}) · ${surgeBasis(x.basis)}`;
  if (x.type === 'regionSurge') {
    const b = x.basis, why = [b.weekly && `주간 매매지수 2주 연속 ${b.weekly.map((c) => delta(c, 2)).join('·')} (${md(b.week)} 기준)`, b.chg3m != null && `3개월 평당가 ${delta(b.chg3m)} (${fmtYm(b.ym)} 완성월까지)`].filter(Boolean);
    return `<span class="up">지역 급등</span> ${region} — ${why.join(', ')}`;
  }
  if (x.type === 'phase') return `<span>국면 변화</span> ${region} — ${esc(phaseLabel(x.from))} → <b>${esc(phaseLabel(x.to))}</b>`;
  return '';
}

async function renderFeed(group, id) {
  const el = document.getElementById('feed');
  const c = await getChanges();
  if (isStale(id) || !el || !c) return;
  const codes = new Set(state.meta.regions.filter((r) => r.group === group).map((r) => r.code));
  const items = c.items.filter((x) => codes.has(x.code));
  const news = items.filter((x) => x.type === 'new' && !x.bulk);
  const dels = items.filter((x) => x.type === 'del');
  const events = items.filter((x) => ['surge', 'regionSurge', 'phase'].includes(x.type));
  const regs = [...codes].map((code) => ({ code, ...c.regions[code] }));
  const pols = c.items.filter((x) => x.type === 'policy' && x.regions.some((r) => r === 'all' || r === group || codes.has(r)));
  const polList = pols.length ? `<ul class="changes">${pols.map((x) => `<li><span>새 정책</span> <a href="#/policy">${esc(x.title)}</a> <span class="muted">${esc(x.category)} · ${fullDate(x.announced)} 발표</span></li>`).join('')}</ul>` : '';
  // 빌드·배포가 밀려 마지막 갱신이 오늘(KST)이 아니면 그 날짜로 부른다
  const isToday = c.date === new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day = isToday ? '오늘은' : `${md(c.date)}에는`;
  const head = `<div class="row"><h2 style="margin:0">${isToday ? '오늘' : md(c.date)} 들어온 거래 ${tip(FEED_HELP)}</h2><span class="spacer"></span><span class="muted" style="font-size:12px">${md(c.date)} 갱신</span></div>`;
  if (c.status === 'bootstrap' && !items.length) {
    el.innerHTML = `<div class="card feed">${head}<p class="muted">거래 이력을 쌓기 시작했어요. 다음 데이터 갱신부터 새로 확인된 거래를 보여 드려요.</p></div>`;
    return;
  }
  const notes = [];
  const failed = regs.filter((r) => r.failed);
  if (failed.length) notes.push(`${failed.length <= 3 ? failed.map((r) => esc(regionShort(r.code))).join('·') : `${failed.length}개 지역`}은 일부 달을 받지 못해 그 달은 비교하지 않았어요`);
  if (news.some((x) => isPartialDate(x.date))) notes.push(`'이번 달 · 신고 진행 중' 거래는 지역 지표·차트에는 다음 달부터 반영돼요`);
  const opened = [...new Set(regs.flatMap((r) => r.opened || []))];
  if (opened.length) notes.push(`${opened.map((ym) => `${+ym.slice(4)}월`).join('·')} 거래가 처음 반영돼 한꺼번에 들어왔어요`);
  // 관심단지 중 아직 확인하지 않은 새 거래 (관심단지 화면과 같은 기준: 마지막 확인 빌드 뒤).
  // 피드 파일은 지역마다 일부 거래만 담으므로 건수 대신 있는지만 알린다
  const watched = watch.list();
  const mineNew = news.some((x) => watched.some((w) => w.code === x.code && w.key === x.key && x.b > (w.checked ?? state.meta.buildNo) && (!w.area || A.areaKey(x.area) === w.area)));
  const watchLine = mineNew ? `<p><a href="#/watch">관심단지에 새로 확인된 거래가 있어요 →</a></p>` : '';
  const foot = notes.length ? `<p class="muted" style="font-size:12px;margin:8px 0 0">${notes.join(' · ')}</p>` : '';
  // 건수는 지역별 집계로 센다 (피드 파일의 거래 목록은 지역마다 눈에 띄는 거래와 최근 계약 일부만 담는다)
  const total = regs.reduce((n, r) => n + (r.added || 0), 0);
  if (!total && !dels.length && !events.length) {
    // 변화가 없으면 마지막으로 새 거래가 확인된 날과 가장 최근 계약일을 보여 준다 (지역 흐름은 아래 요약 문장)
    const lastDay = regs.map((r) => r.lastAdded?.d).filter(Boolean).sort().pop();
    const lastN = lastDay ? regs.filter((r) => r.lastAdded?.d === lastDay).reduce((n, r) => n + r.lastAdded.n, 0) : 0;
    const lastTrade = regs.map((r) => r.lastTrade).filter(Boolean).sort().pop();
    el.innerHTML = `<div class="card feed">${head}<p class="muted">${day} ${esc(group)}에서 새로 확인된 거래가 없어요.${lastDay ? ` 마지막으로 새 거래가 확인된 날은 ${md(lastDay)}(${lastN.toLocaleString()}건)이고,` : ''}${lastTrade ? ` 가장 최근 계약일은 ${md(lastTrade)}예요.` : ''}</p>${polList}${watchLine}${foot}</div>`;
    return;
  }
  const highs = news.filter((x) => x.flags?.includes('high')).length;
  const top = regs.filter((r) => r.added).sort((a, b) => b.added - a.added);
  // 눈에 띄는 거래(급등·신고가·높은 가격) 먼저, 그다음 최근 계약 순
  const rank = (x) => (x.flags?.includes('surge') ? 3 : 0) + (x.flags?.includes('high') ? 2 : 0) + (x.flags?.includes('highPrice') ? 1 : 0);
  const sorted = news.slice().sort((a, b) => rank(b) - rank(a) || b.date.localeCompare(a.date) || b.price - a.price);
  const row = (x) => `<li><span class="muted">${esc(regionShort(x.code))}</span> ${aptLink(x)} · ${tradeLine(x)}${flagTags(x)}</li>`;
  el.innerHTML = `<div class="card feed">${head}
    <p>${esc(group)}에서 새로 확인된 매매 <b class="num">${total.toLocaleString()}건</b>${highs ? ` · <span class="up">신고가 ${highs}건</span>` : ''}${dels.length ? ` · 삭제 ${dels.length}건` : ''}</p>
    ${top.length ? `<p class="feed-regions">${top.slice(0, 10).map((r) => `<a href="#/r/${r.code}">${esc(regionShort(r.code))} <span class="num">${r.added}</span></a>`).join('')}${top.length > 10 ? `<span class="muted">외 ${top.length - 10}곳</span>` : ''}</p>` : ''}
    ${watchLine}
    ${polList}
    ${events.length ? `<ul class="changes">${events.map((x) => `<li>${eventLine(x)}</li>`).join('')}</ul>${events.some((x) => x.type !== 'phase') ? `<p class="muted" style="font-size:12px;margin:4px 0 0">급등: ${SURGE_NOTE}</p>` : ''}` : ''}
    ${sorted.length ? `<ul class="changes">${sorted.slice(0, FEED_ROWS).map(row).join('')}</ul>` : ''}
    ${sorted.length > FEED_ROWS || dels.length ? `<details><summary>${sorted.length > FEED_ROWS ? `거래 더 보기` : ''}${sorted.length > FEED_ROWS && dels.length ? ' · ' : ''}${dels.length ? `삭제된 거래 ${dels.length}건` : ''}</summary>
      ${sorted.length > FEED_ROWS ? `<ul class="changes">${sorted.slice(FEED_ROWS).map(row).join('')}${total > sorted.length ? `<li class="muted">지역마다 최근 계약 일부만 보여요. 나머지 ${(total - sorted.length).toLocaleString()}건은 지역 화면에서 보세요</li>` : ''}</ul>` : ''}
      ${dels.length ? `<ul class="changes muted">${dels.slice(0, 100).map((x) => `<li>${esc(regionShort(x.code))} ${aptLink(x)} · <s>${tradeLine(x)}</s></li>`).join('')}</ul>` : ''}
    </details>` : ''}
    ${foot}
  </div>`;
}

// ---------- 첫 방문 안내: 검색 → 단지 선택 → 관심 평형 저장 → 요약 확인 ----------
// 관심단지가 하나도 없을 때 개요 위에 보여 준다. 닫으면 이 브라우저에서는 다시 띄우지 않는다
const guide = {
  off() { try { return localStorage.getItem('homeTrend.guideOff') === '1'; } catch (_) { return false; } },
  close() { try { localStorage.setItem('homeTrend.guideOff', '1'); } catch (_) { /* 저장 불가 */ } },
};
function guideSteps() {
  return `<ol class="steps">
    <li><b>단지 검색</b><span>아파트 이름이나 동네 이름으로 찾아요. <button type="button" class="btn" data-guide-search>검색하기</button></span></li>
    <li><b>평형 고르고 ★ 저장</b><span>단지 화면에서 전용면적을 고르고 ★를 눌러요. 고를 수 있는 면적은 실제 거래가 있었던 면적이에요.</span></li>
    <li><b>관심단지에서 확인</b><span>저장한 평형의 시세와 새로 확인된 거래·신고가를 한 화면에서 봐요. 데이터는 매일 갱신돼요.</span></li>
  </ol>
  <p class="muted" style="font-size:12px;margin:8px 0 0">가입·로그인 없이 이 브라우저에 저장돼요.</p>`;
}
// 안내 안의 '검색하기': 상단 검색창으로
function bindGuideSearch(root) {
  root.querySelector('[data-guide-search]')?.addEventListener('click', () => {
    metrics.track('guide', { k: 'search' });
    window.scrollTo(0, 0);
    document.getElementById('gq').focus();
  });
}
function renderGuide() {
  const el = document.getElementById('guide');
  if (!el || watch.list().length || guide.off()) return;
  el.innerHTML = `<section class="card guide">
    <div class="row"><h2 style="margin:0">처음이라면 관심단지부터 저장해 보세요</h2><span class="spacer"></span><button type="button" class="pop-x" data-guide-close aria-label="안내 닫기">×</button></div>
    ${guideSteps()}
  </section>`;
  bindGuideSearch(el);
  el.querySelector('[data-guide-close]').addEventListener('click', () => {
    guide.close();
    metrics.track('guide', { k: 'close' });
    el.innerHTML = '';
  });
  metrics.track('guide', { k: 'show' });
}

async function viewOverview(group, id) {
  const J = isJ();
  const I = (r) => (J ? jInd(r) : r.ind); // 가격·거래량 지표 (전세 보기는 전세 거래로 계산한 값)
  const cols = J ? OV_J_COLS : OV_COLS, sortKey = J ? 'overviewJ' : 'overview';
  const regions = state.meta.regions.filter((r) => r.group === group);
  // 지난번에 실패한 지역은 다시 시도
  regions.forEach((r) => { if (state.overview[r.code]?.error) delete state.overview[r.code]; });
  app.innerHTML = `
    <h1>${esc(group)} 지역별 ${J ? '전세' : '시세'} 트렌드 ${tip(J
      ? '전세 실거래 평당 보증금의 3개월 이동평균 기준 (단지 구성 보정, 신고 진행 중인 지난달·같은 날 몰린 일괄 계약 제외). 월세·반전세는 넣지 않아요. 거래량은 최근 3개월 전세 계약 수를 36개월 평균과 비교해요. 전세가율은 평당 전세가 ÷ 평당 매매가예요.'
      : '실거래 평당가의 3개월 이동평균 기준 (단지 구성 보정, 신고 진행 중인 지난달·통매각 같은 일괄 거래 제외). 거래량은 최근 3개월을 36개월 평균과 비교해요. 신고가 비율은 최근 3개월 거래 중 같은 단지·평형의 이전 최고가를 넘은 거래 비중으로, 시장이 달아오르면 가장 먼저 올라가요.')}</h1>
    <div id="guide"></div>
    ${J ? `<p class="muted">${SALE_ONLY_NOTE}</p>` : '<div id="feed"></div>'}
    <div class="card region-filter"><label>구·시 찾기 <input id="regionQuery" type="search" placeholder="예: 성북구"></label>
      <label><input type="checkbox" id="likedRegions"> 좋아요한 지역만</label>
      <details><summary>비교할 지역 선택</summary><div class="region-options">${regions.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((r) => `<label><input type="checkbox" name="regionCode" value="${r.code}">${esc(r.name)}</label>`).join('')}</div></details>
      <button id="resetRegions">필터 초기화</button></div>
    <p class="muted">♥ 좋아요는 이 브라우저에 저장됩니다. 단지는 ★ 관심단지로 저장할 수 있어요.</p>
    <p class="lead" id="ovLead"></p>
    <p class="muted" id="rebLead"></p>
    ${J ? '' : `<p class="muted" id="forecastNote"></p>
    <details class="card candidate-note"><summary>상승 후보 점수 (실험) — 계산 기준</summary><p>가격 흐름 50점 · 거래량 30점 · 전세가율 20점으로 현재 관측 지표를 비교합니다. 점수가 높을수록 최근 상승·거래 신호가 강합니다. 5년 후 급등 확률이나 예상 수익률은 아니며, 장기 예측 성능은 아직 검증되지 않았습니다.</p><p>완성월 36개월 이상, 거래가 있는 달 30개월 이상, 최근 월평균 거래 10건 이상일 때 표시합니다. 수집 누락이 있는 지역은 점수를 표시하지 않습니다. 공급·교통·정비사업은 아직 반영하지 않았습니다.</p></details>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">국면 지도 — 가격 변화 × 거래량 ${tip('벌집순환모형: 거래량이 먼저 움직이고 가격이 따라와요. 오른쪽 아래(불황) → 가운데 오른쪽(회복진입) → 오른쪽 위(회복) 순서로 옮겨가는 지역을 주목하세요. 점에 마우스를 올리면 6개월 전 → 3개월 전 → 지금 이동 경로가 보이고, 누르면 지역 화면으로 가요. ‘모든 지역 최근 이동 방향’을 켜면 지역마다 3개월 전 → 지금 움직임을 화살표로 보여줘요.')}</h2><span class="spacer"></span><label class="muted" style="font-size:12px"><input type="checkbox" id="trail" ${state.trail ? 'checked' : ''}> 모든 지역 최근 이동 방향</label></div>
      <div class="chart-box tall"><canvas id="phaseMap"></canvas></div>
    </div>`}
    <div id="macro"></div>
    <div class="card"><div class="row"><h2 style="margin:0">지역별 지표</h2><span class="spacer"></span><span id="ovSort"></span></div><div class="table-wrap mcards"><table><thead></thead><tbody></tbody></table></div></div>`;
  renderGuide();
  renderMacro(id);
  if (!J) renderFeed(group, id);

  const rows = regions.map((r) => ({ ...r, ...(state.overview[r.code] || {}) }));
  const thead = app.querySelector('thead'), tbody = app.querySelector('tbody');
  const visibleRows = () => {
    const query = norm(document.getElementById('regionQuery').value);
    const selected = [...app.querySelectorAll('input[name="regionCode"]:checked')].map((x) => x.value);
    const liked = new Set(regionLikes.list());
    return rows.map((r) => ({ ...r, liked: liked.has(r.code) })).filter((r) => norm(r.name).includes(query) && (!document.getElementById('likedRegions').checked || liked.has(r.code)) && (!selected.length || selected.includes(r.code)));
  };
  const render = () => {
    const rows = visibleRows();
    if (!J) document.getElementById('forecastNote').textContent = forecastNote();
    document.getElementById('rebLead').innerHTML = rebLead(group);
    thead.innerHTML = tableHead(cols, sortKey, state.sort[sortKey]);
    document.getElementById('ovSort').innerHTML = sortSelect(cols, sortKey, state.sort[sortKey]);
    tbody.innerHTML = sortRows(rows, cols, state.sort[sortKey])
      .map((r) => `<tr class="link" data-href="#/r/${r.code}">${cells(cols, r, (i) => i === 0)}</tr>`).join('');
    bindSort(app, sortKey, render);
    // 한 줄 요약: 3개월 새 오른 지역 수와 가장 많이 오른 곳.
    // 지역이 하나씩 들어올 때마다 숫자가 바뀌면 오류처럼 보이므로, 다 불러온 뒤에 한 번만 문장을 정한다
    const lead = document.getElementById('ovLead');
    if (!rows.length) { lead.textContent = '조건에 맞는 지역이 없습니다. 필터를 변경해 주세요.'; return; }
    const pending = rows.filter((r) => !r.ind && !r.error).length;
    if (pending) {
      const done = rows.length - pending;
      lead.innerHTML = `<span class="muted">${esc(group)} ${rows.length}개 지역의 실거래를 불러오는 중이에요 · ${done}/${rows.length}</span><span class="lead-progress"><i style="width:${(done / rows.length) * 100}%"></i></span>`;
      return;
    }
    const ok = rows.filter((r) => I(r)?.chg3m != null);
    // 빠진 지역은 3곳까지 이름으로, 그보다 많으면 개수로 밝힌다
    const failed = rows.filter((r) => r.error), thin = rows.filter((r) => r.ind && I(r)?.chg3m == null);
    const who = (rs) => (rs.length <= 3 ? `${rs.map((r) => esc(r.name)).join('·')}${topic(rs[rs.length - 1].name)}` : `${rs.length}곳은`);
    const notes = [failed.length ? `${who(failed)} 불러오지 못해 빼고 계산했어요` : '', thin.length ? `${who(thin)} 거래가 적어 뺐어요` : ''].filter(Boolean);
    const note = notes.length ? ` <span class="muted">(${notes.join(' · ')})</span>` : '';
    if (!ok.length) {
      lead.innerHTML = `<span class="err">지역 데이터를 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.</span>${note}`;
      return;
    }
    const up = ok.filter((r) => I(r).chg3m > 0.003).length, down = ok.filter((r) => I(r).chg3m < -0.003).length;
    const best = ok.reduce((a, b) => (I(b).chg3m > I(a).chg3m ? b : a));
    const hot = ok.filter((r) => I(r).volVsAvg > 0.2).length;
    lead.innerHTML = `최근 3개월 ${J ? '전세가는 ' : ''}${esc(group)} ${ok.length}개 지역 중 ${up ? `<span class="up">${up}곳이 올랐고</span>` : '오른 곳은 없고'} ${down ? `<span class="down">${down}곳이 내렸어요</span>` : '내린 곳은 없어요'}. 가장 많이 오른 곳은 <a href="#/r/${best.code}">${esc(best.name)}</a>(${delta(I(best).chg3m)})이고, ${J ? '전세 거래가' : '거래량이'} 장기 평균보다 20% 넘게 늘어난 곳은 ${hot}곳이에요.${note}`;
  };
  tbody.addEventListener('click', (e) => { const like = e.target.closest('[data-like-region]'); if (like) { regionLikes.toggle(like.dataset.likeRegion); render(); refreshMap(); return; } const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });

  const mapEl = document.getElementById('phaseMap'), map = mapEl && phaseMap(mapEl); // 국면 지도는 매매 보기에만
  const refreshMap = () => {
    if (!map) return;
    const pts = visibleRows().filter((r) => r.ind?.chg3m != null && r.ind?.volVsAvg != null)
      .map((r) => ({ x: r.ind.volVsAvg * 100, y: r.ind.chg3m * 100, label: r.name.replace(/ \(.+\)/, ''), code: r.code, phase: r.ind.phase,
        trail: (r.ind.trail || []).map((t) => ({ x: t.volVsAvg * 100, y: t.chg3m * 100, ym: t.ym })) }));
    map.data.datasets[0].data = pts;
    map.data.datasets[1].data = state.trail ? pts.flatMap((p) => p.trail.slice(-1)) : []; // 전체 보기에서 그리는 3개월 전 위치만 축 범위에 넣는다
    map.update('none');
  };
  document.getElementById('trail')?.addEventListener('change', (e) => { state.trail = e.target.checked; refreshMap(); });
  for (const el of app.querySelectorAll('#regionQuery, #likedRegions, input[name="regionCode"]')) el.addEventListener(el.id === 'regionQuery' ? 'input' : 'change', () => { render(); refreshMap(); });
  document.getElementById('resetRegions').addEventListener('click', () => { document.getElementById('regionQuery').value = ''; document.getElementById('likedRegions').checked = false; app.querySelectorAll('input[name="regionCode"]').forEach((x) => { x.checked = false; }); render(); refreshMap(); });
  render(); refreshMap();
  getForecasts().then(() => { if (!isStale(id)) render(); });
  getReb().then(() => { if (!isStale(id)) render(); });

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
  ['count12m', '최근 1년 거래', (r) => r.count12m, (r) => `${r.count12m}건${r.partialCount ? ` <span class="muted" title="${PARTIAL_HELP}">(이번 달 ${r.partialCount}건 포함)</span>` : ''}`],
  ['mainArea', '주력 평형', (r) => r.mainArea, (r) => (r.mainArea ? `${r.mainArea}㎡` : '–')],
  ['ppy', '평당가', (r) => r.ppy, (r) => fmtMan(r.ppy)],
  ['recentPrice', '최근 시세', (r) => r.recentPrice, (r) => fmtEok(r.recentPrice)],
  ['peakPrice', '기간 내 최고가', (r) => r.peakPrice, (r) => (r.peakPrice ? `${fmtEok(r.peakPrice)} <span class="muted">${r.peakDate.slice(2, 7).replace('-', '.')}</span>` : '–')],
  ['fromPeak', '최고가 대비', (r) => r.fromPeak, (r) => delta(r.fromPeak)],
  ['lastDate', '최근 거래일', (r) => r.lastDate, (r) => `${r.lastDate.slice(2).replace(/-/g, '.')}${r.lastPartial ? ` ${partialTag}` : ''}`],
];
// 전세 보기의 단지 목록: 같은 칸을 보증금으로 (A.apartmentList(전세, 'deposit'))
const APT_J_COLS = [
  ['apt', '단지', (r) => r.apt, (r) => esc(r.apt)],
  ...APT_COLS.filter(([k]) => k === 'dong' || k === 'built'),
  ['count12m', '최근 1년 전세', (r) => r.count12m, (r) => `${r.count12m}건`],
  APT_COLS.find(([k]) => k === 'mainArea'),
  ['ppy', '평당 전세가', (r) => r.ppy, (r) => fmtMan(r.ppy)],
  ['recentPrice', '최근 전세가', (r) => r.recentPrice, (r) => fmtEok(r.recentPrice)],
  ['peakPrice', '기간 내 최고 보증금', (r) => r.peakPrice, (r) => (r.peakPrice ? `${fmtEok(r.peakPrice)} <span class="muted">${r.peakDate.slice(2, 7).replace('-', '.')}</span>` : '–')],
  APT_COLS.find(([k]) => k === 'fromPeak'),
  ['lastDate', '최근 계약일', (r) => r.lastDate, (r) => r.lastDate.slice(2).replace(/-/g, '.')],
];

function monthsSeg(cur, opts) {
  return `<div class="seg" id="months">${opts.map(([m, l]) => `<button data-m="${m}" class="${m === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function getMonths(view, opts, def) {
  let v = null;
  try { v = Number(sessionStorage.getItem(`homeTrend.months.${view}`)); } catch (_) { /* 저장소 사용 불가 */ }
  return opts.some(([m]) => m === v) ? v : def;
}
function bindMonths(view, onPick) {
  app.querySelectorAll('#months button').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('on')) return;
    try { sessionStorage.setItem(`homeTrend.months.${view}`, b.dataset.m); } catch (_) { /* 무시 */ }
    onPick?.(Number(b.dataset.m));
    b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.keepView = true; // 다시 그릴 때 현재 화면을 지우지 않고 흐리게 유지
    route();
  }));
}
// 매매/전세 보기: 상단에서 고르고 이 브라우저에 기억한다. 기본은 매매(지금까지의 화면)
// 전세 보기는 전세 거래로 계산한 시세·거래량만 보여 주고, 매매로만 정의한 것(국면·신고가·새로 확인된 거래·후보 점수·예측)은 숨긴다
function getDeal() { try { return localStorage.getItem('homeTrend.deal') === 'jeonse' ? 'jeonse' : 'sale'; } catch (_) { return 'sale'; } }
const isJ = () => state.deal === 'jeonse';
const dealName = () => (isJ() ? '전세' : '매매');
const SALE_ONLY_NOTE = '새로 확인된 거래·신고가·급등 표시와 국면·예측은 아직 매매만 다뤄요. 위에서 매매로 바꾸면 볼 수 있어요.';
function initDeal() {
  state.deal = getDeal();
  const seg = document.getElementById('deal');
  const paint = () => seg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.d === state.deal);
    b.setAttribute('aria-pressed', String(b.dataset.d === state.deal));
  });
  paint();
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (!b || b.dataset.d === state.deal) return;
    state.deal = b.dataset.d;
    try { localStorage.setItem('homeTrend.deal', state.deal); } catch (_) { /* 저장 불가: 이번 방문에만 */ }
    paint();
    metrics.track('deal', { k: state.deal });
    if (!state.meta) return; // 첫 화면을 그리는 중이면 그 화면이 바뀐 보기로 그린다
    state.dealSwitch = true;
    route();
  });
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

// 전세 보기의 지역 머리: 전세 거래로 계산한 지표(ind.jeonse)와 전세가율
function regionJeonseTop(region, ind) {
  const j = ind.jeonse || {};
  const name = esc(region.name.replace(/ \(.+\)/, ''));
  const lead = [
    j.chg3m == null ? '' : Math.abs(j.chg3m) < 0.003 ? `${name} 평당 전세가는 최근 3개월 거의 그대로이고` : `${name} 평당 전세가는 최근 3개월 ${pctSpan(j.chg3m)} ${j.chg3m > 0 ? '올랐고' : '내렸고'}`,
    j.volVsAvg == null ? '' : Math.abs(j.volVsAvg) < 0.05 ? '전세 거래는 장기 평균 수준이에요.' : `전세 거래는 장기 평균보다 ${pctSpan(j.volVsAvg, 0)} ${j.volVsAvg > 0 ? '많아요.' : '적어요.'}`,
    ind.jeonseRatio != null ? `전세가율은 <b>${fmtPct(ind.jeonseRatio, 0)}</b>예요.` : '',
  ].filter(Boolean).join(' ');
  return `<p class="lead">${lead} ${tip('평당 전세가 = 전용면적 기준 전세 보증금 ÷ 평 (중위값). 이동평균은 거래된 단지 구성이 달라 생기는 착시를 보정한 값이고, 최근 지표는 신고가 끝난 달까지로 계산해요. 월세·반전세와 같은 날 한 단지에 몰린 일괄 계약은 빼요.')}</p>
    <p class="muted">${SALE_ONLY_NOTE}</p>
    <div class="kpis">
      <div class="kpi"><div class="label">평당 전세가</div><div class="value num">${fmtMan(j.current)}</div><div class="hint">${fmtYm(j.currentYm)} 기준 · 84㎡ 환산 ${j.current ? fmtEok(Math.round(j.current * 84 / PYEONG / 100) * 100) : '–'}</div></div>
      <div class="kpi"><div class="label">3개월 변화</div><div class="value num">${delta(j.chg3m)}</div><div class="hint">12개월 ${delta(j.chg12m)}</div></div>
      <div class="kpi"><div class="label">기간 내 고점 대비</div><div class="value num">${delta(j.fromPeak)}</div><div class="hint">고점 ${fmtYm(j.peakYm)} · ${fmtMan(j.peak)}</div></div>
      <div class="kpi"><div class="label">고점 이후 저점 대비</div><div class="value num">${delta(j.fromLow)}</div><div class="hint">${j.lowYm ? `저점 ${fmtYm(j.lowYm)} · ${fmtMan(j.low)}` : '현재가 고점'}</div></div>
      <div class="kpi"><div class="label">월 전세 거래 (최근 3개월)</div><div class="value num">${j.volRecent ?? '–'}건</div><div class="hint">장기평균 ${delta(j.volVsAvg, 0)} · 직전 3개월 ${delta(j.volChg, 0)}</div></div>
      <div class="kpi"><div class="label">전세가율 (최근 6개월)</div><div class="value num">${fmtPct(ind.jeonseRatio, 0)}</div><div class="hint">평당 전세가 ÷ 평당 매매가 · 매매 ${fmtMan(ind.current)}</div></div>
    </div>`;
}

async function viewRegion(code, id) {
  const region = requireRegion(code);
  const opts = monthOpts(REGION_MONTHS);
  const months = getMonths(`region.${code}`, opts, Math.min(60, state.meta.months || 60));
  const J = isJ();
  const brokerOnly = !J && getKind() === 'broker'; // 직거래 구분은 매매에만 있다
  showLoading(`<div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div><h1>${esc(region.name)}</h1>${skeleton(`실거래 ${months}개월치 불러오는 중… (처음 보는 기간은 국토부 API 호출로 30초 정도 걸릴 수 있어요)`)}`);
  const [d] = await Promise.all([getRegion(code, months, brokerOnly, J), getForecasts(), getPolicies()]);
  if (isStale(id)) return;
  destroyCharts();
  const ind = d.indicators;
  const s = d.series;
  const L = dealName();
  const pols = policyFor(code);
  app.innerHTML = `
    <div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> ›</div>
    <div class="row"><h1>${esc(region.name)}</h1>${J ? '' : phaseChip(ind.phase)}<span class="spacer"></span>${J ? '' : kindSeg(brokerOnly)}${monthsSeg(months, opts)}</div>
    ${J ? regionJeonseTop(region, ind) : `<p class="lead">${regionLead(region.name.replace(/ \(.+\)/, ''), ind)} ${tip('평당가 = 전용면적 기준 거래가 ÷ 평 (중위값). 이동평균은 거래된 단지 구성이 달라 생기는 착시를 보정한 값이고, 최근 지표는 신고가 끝난 달까지로 계산해요. 통매각 같은 일괄 거래는 빼고 계산해요.')}</p>
    <div class="kpis">
      <div class="kpi"><div class="label">평당 매매가</div><div class="value num">${fmtMan(ind.current)}</div><div class="hint">${fmtYm(ind.currentYm)} 기준 · 84㎡ 환산 ${ind.current ? fmtEok(Math.round(ind.current * 84 / PYEONG / 100) * 100) : '–'}</div></div>
      <div class="kpi"><div class="label">3개월 변화</div><div class="value num">${delta(ind.chg3m)}</div><div class="hint">12개월 ${delta(ind.chg12m)}</div></div>
      <div class="kpi"><div class="label">기간 내 고점 대비</div><div class="value num">${delta(ind.fromPeak)}</div><div class="hint">고점 ${fmtYm(ind.peakYm)} · ${fmtMan(ind.peak)}</div></div>
      <div class="kpi"><div class="label">고점 이후 저점 대비</div><div class="value num">${delta(ind.fromLow)}</div><div class="hint">${ind.lowYm ? `저점 ${fmtYm(ind.lowYm)} · ${fmtMan(ind.low)}` : '현재가 고점'}</div></div>
      <div class="kpi"><div class="label">월 거래량 (최근 3개월)</div><div class="value num">${ind.volRecent ?? '–'}건</div><div class="hint">장기평균 ${delta(ind.volVsAvg, 0)} · 직전 3개월 ${delta(ind.volChg, 0)}${brokerOnly ? '' : ` · 직거래 ${fmtPct(ind.directShare, 0)}`}</div></div>
      <div class="kpi"><div class="label">전세가율 (최근 6개월)</div><div class="value num">${fmtPct(ind.jeonseRatio, 0)}</div><div class="hint">평당 전세가 ÷ 평당 매매가</div></div>
      <div class="kpi"><div class="label">신고가 비율 (최근 3개월)</div><div class="value num">${fmtPct(ind.newHighShare, 0)}</div><div class="hint">직전 거래보다 ${ind.upShare != null ? `오름 ${fmtPct(ind.upShare, 0)} · 내림 ${fmtPct(ind.downShare, 0)}` : '–'}</div></div>
    </div>
    ${forecastCard(code, brokerOnly)}
    ${ind.phase ? `<p class="phase-note card">${ind.phase.id ? `${ind.phase.id}국면 ` : ''}<b>${esc(ind.phase.name)}</b> — ${esc(ind.phase.note)}</p>` : ''}`}
    <div class="card">
      <div class="tv-head">
        <div class="tv-label">평당 ${L}가 <span class="muted">3개월 이동평균 · 구성 보정 · 만원/3.3㎡</span> ${tip(J
          ? '전세 보증금 ÷ 평의 월 중위값이에요. 아래 칸은 월별 전세 계약 수이고, 점선은 장기 평균(36개월 중위)이에요. 마지막 달(옅은 막대)은 신고 진행 중이라 덜 잡혀요. 같은 날 한 단지에 몰린 일괄 계약은 뺐어요. 휠·핀치로 확대하고 끌어서 이동할 수 있어요.'
          : '아래 칸은 월별 매매 거래량이고, 점선은 장기 평균(36개월 중위)이에요. 마지막 달(옅은 막대)은 신고 진행 중이라 덜 잡혀요. 노란 막대는 통매각 같은 일괄 거래로 지표 계산에서 뺐어요. 휠·핀치로 확대하고 끌어서 이동할 수 있어요.')}</div>
        <div class="tv-value num" id="pvValue"></div>
        <div class="tv-sub num" id="pvSub"></div>
      </div>
      <div class="row tv-ctrl">
        ${rangeSeg('pvRange', s.length)}
        <span class="spacer"></span>
        <div class="chips" id="pvToggle">
          <span class="chip-static"><i id="pvSwatch"></i>${L} 3개월 이동평균</span>
          <button data-s="median" class="${state.pv.median ? 'on' : ''}" title="눌러서 켜고 끄기"><i class="dot" style="background:${css('--series-1-soft')}"></i>${L} 월 중위값</button>
          ${J ? '' : `<button data-s="jeonse" class="${state.pv.jeonse ? 'on' : ''}" title="눌러서 켜고 끄기"><i style="background:${css('--series-2')}"></i>전세 3개월 이동평균</button>`}
          ${pols.length ? policyChip(state.pv.policy) : ''}
        </div>
      </div>
      <div class="tv-box" id="pv"></div>
      <p class="muted tv-note">아래 칸은 월별 ${L} 거래량 (점선 = 장기 평균 ${(J ? ind.jeonse : ind).volLong ?? '–'}건/월)${!J && s.some((r) => r.bulk) ? ' · 노란 막대 = 일괄 거래(지표에서 제외)' : ''} · 휠·핀치로 확대${pols.length ? policyNote(code) : ''}</p>
    </div>
    <div class="${J ? '' : 'grid2'}">
      ${J ? '' : `<div class="card">
        <h2>거래 온도 ${tip('같은 단지·평형의 이전 거래와 비교한 비율 (3개월 이동평균). 신고가·상승 비율이 오르면 과열, 하락 비율이 상승 비율을 넘으면 꺾이는 신호예요.')}</h2>
        ${legend([['신고가', css('--up')], ['직전보다 오름', css('--series-2')], ['직전보다 내림', css('--down')]])}
        <div class="chart-box short"><canvas id="heat"></canvas></div>
      </div>`}
      <div class="card">
        <h2>전세가율 추이 ${tip('평당 전세가 ÷ 평당 매매가 (3개월 이동평균). 오르면 매매가와 전세가의 갭이 좁아져 갭투자 수요가 들어오기 쉬워요.')}</h2>
        ${legend([['전세가율', css('--series-2')]])}
        <div class="chart-box short"><canvas id="jr"></canvas></div>
      </div>
    </div>
    <div id="rebCards"></div>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지별 시세</h2><span class="spacer"></span><span id="aptSort"></span><input type="search" id="q" placeholder="단지명·동 검색"></div>
      <p class="muted" id="aptPartialNote" style="font-size:12px;margin:0 0 8px" hidden>최근 1년 거래·최근 거래일은 이번 달(신고 진행 중) 거래를 포함해요. 평당가·최근 시세·최고가는 신고가 끝난 지난달까지의 거래로 계산해요.</p>
      <div class="table-wrap mcards"><table><thead></thead><tbody></tbody></table></div>
    </div>`;
  bindMonths(`region.${code}`);
  bindKind();

  if (J) priceVolumeChart(jeonseView(s), ind.jeonse, L, pols);
  else priceVolumeChart(s, ind, '매매', pols);

  const roll3 = (xs) => xs.map((_, i) => { const w = xs.slice(Math.max(0, i - 2), i + 1).filter((v) => v != null); return w.length === 3 ? w.reduce((a, b) => a + b) / 3 : null; });
  const done = s.slice(0, -1); // 신고 진행 중인 마지막 달 제외
  const pctAxis = { ticks: { callback: (v) => `${Math.round(v * 100)}%` } };
  const lineDs = (label, data, color) => ({ label, data, borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true });
  const lineOpts = { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: pctAxis },
    plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${fmtPct(c.raw, 0)}` } } } };
  if (!J) makeChart(document.getElementById('heat'), {
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

  // 부동산원 지표는 선택 사항이라 실거래 화면을 먼저 그리고, 받아지면 카드만 덧붙인다
  getReb().then(() => {
    const box = document.getElementById('rebCards');
    if (isStale(id) || !box) return;
    box.innerHTML = rebCards(code, region);
    rebCharts(code, region, lineDs, lineOpts);
  });

  const thead = app.querySelector('thead'), tbody = app.querySelector('tbody'), q = document.getElementById('q');
  let watched = new Set();
  const cols = [...(J ? APT_J_COLS : APT_COLS), ['star', '', null, (r) => `<button class="star ${watched.has(r.key) ? 'on' : ''}" data-key="${esc(r.key)}" title="관심단지에 좋아요 (이 브라우저에 저장)">★</button>`]];
  const render = () => {
    watched = new Set(watch.list().filter((w) => w.code === code).map((w) => w.key));
    const term = q.value.trim();
    const rows = d.apartments.filter((r) => !term || A.apartmentNames(code, r.dong, r.apt, r.jibun).some((n) => norm(n).includes(norm(term))) || norm(r.dong).includes(norm(term)));
    thead.innerHTML = tableHead(cols, 'apts', state.sort.apts);
    document.getElementById('aptSort').innerHTML = sortSelect(cols, 'apts', state.sort.apts);
    tbody.innerHTML = sortRows(rows, cols, state.sort.apts).slice(0, 300)
      .map((r) => `<tr class="link" data-href="#/a/${code}/${encodeURIComponent(r.key)}">${cells(cols, r, (i) => i < 2)}</tr>`).join('');
    document.getElementById('aptPartialNote').hidden = !d.apartments.some((r) => r.partialCount);
    bindSort(app, 'apts', render);
  };
  q.addEventListener('input', render);
  tbody.addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (star) {
      const a = d.apartments.find((x) => x.key === star.dataset.key);
      star.classList.toggle('on', watch.toggle({ code, key: a.key, name: a.apt, jibun: a.jibun, region: region.name }));
      return;
    }
    const tr = e.target.closest('tr[data-href]');
    if (tr) location.hash = tr.dataset.href;
  });
  render();
}

// ---------- 지역 상세: 한국부동산원 주간지수·매입자 거주지 ----------
// 전세 보기: 주간 전세지수만 보이고, 매매 기준인 외지인 매입 비중은 뺀다
function rebCards(code, region) {
  const r = state.reb?.regions?.[code];
  if (!r) return '';
  const w = r.ind?.weekly, b = r.ind?.buyers, J = isJ();
  const gg = region.group === '경기';
  return `<div class="grid2">
      ${r.weekly?.dates.length ? `<div class="card">
        <h2>주간 아파트 ${J ? '전세' : '가격'}지수 (한국부동산원) ${tip('한국부동산원이 매주 표본 아파트 시세를 조사한 지수예요 (2026.07.06 = 100). 실거래가 아니라 조사 가격이라 위 실거래 평당가와 다를 수 있지만, 신고를 기다리지 않아 최근 흐름을 더 빨리 보여줘요.')}</h2>
        <p class="muted" style="margin:-6px 0 8px;font-size:13px">${fmtDate(w?.date)} 주 · ${J
          ? `전세 1주 ${delta(w?.jeonseChg1w, 2)} · 4주 ${delta(w?.jeonseChg4w, 2)} · 12주 ${delta(w?.jeonseChg12w, 2)}`
          : `매매 1주 ${delta(w?.chg1w, 2)} · 4주 ${delta(w?.chg4w, 2)} · 12주 ${delta(w?.chg12w, 2)} · 전세 4주 ${delta(w?.jeonseChg4w, 2)}`}</p>
        ${J ? '' : legend([['매매', css('--series-1')], ['전세', css('--series-2')]])}
        <div class="chart-box short"><canvas id="rebWeekly"></canvas></div>
      </div>` : '<div></div>'}
      ${r.buyers?.yms.length && !J ? `<div class="card">
        <h2>외지인 매입 비중 ${tip(`이 지역 아파트를 산 사람 중 다른 시·구에 사는 사람의 비중이에요 (한국부동산원 매입자 거주지별 거래, 3개월 이동 합계). 장기 평균보다 높아지면 외부 수요(투자·갈아타기)가 몰리고 있다는 뜻이에요.${gg ? ' 서울 거주자 비중도 함께 보여줘요.' : ''}`)}</h2>
        <p class="muted" style="margin:-6px 0 8px;font-size:13px">${fmtYm(b?.ym)}까지 3개월 ${fmtPct(b?.outsideShare, 0)}${b?.outsideLong != null ? ` · 장기 평균 ${fmtPct(b.outsideLong, 0)}` : ''}${gg && b?.seoulShare != null ? ` · 서울 거주자 ${fmtPct(b.seoulShare, 0)}` : ''}</p>
        ${legend([['외지인', css('--series-4')], ...(gg ? [['서울 거주자', css('--series-1')]] : [])])}
        <div class="chart-box short"><canvas id="rebBuyers"></canvas></div>
      </div>` : '<div></div>'}
    </div>`;
}
function rebCharts(code, region, lineDs, lineOpts) {
  const r = state.reb?.regions?.[code];
  const wEl = document.getElementById('rebWeekly'), bEl = document.getElementById('rebBuyers');
  if (wEl) {
    makeChart(wEl, {
      type: 'line',
      data: { labels: r.weekly.dates.map(fmtDate), datasets: [...(isJ() ? [] : [lineDs('매매', r.weekly.sale, css('--series-1'))]), lineDs('전세', r.weekly.jeonse, css('--series-2'))] },
      options: { ...lineOpts, scales: { ...lineOpts.scales, y: { ticks: { callback: (v) => Number(v).toFixed(0) } } },
        plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${c.raw == null ? '–' : c.raw.toFixed(2)}` } } } },
    });
  }
  if (bEl) {
    const b = r.buyers;
    // 3개월 이동 합계 비중 (월별 건수가 적은 지역의 출렁임을 줄인다)
    const roll = (key) => b.yms.map((_, i) => {
      if (i < 2) return null;
      const t = b.total.slice(i - 2, i + 1).reduce((a, x) => a + (x || 0), 0);
      const v = key === 'outside' ? t - b.local.slice(i - 2, i + 1).reduce((a, x) => a + (x || 0), 0) : b[key].slice(i - 2, i + 1).reduce((a, x) => a + (x || 0), 0);
      return t ? v / t : null;
    });
    const n = Math.min(b.yms.length, 36);
    const ds = [lineDs('외지인', roll('outside').slice(-n), css('--series-4'))];
    if (region.group === '경기') ds.push(lineDs('서울 거주자', roll('seoul').slice(-n), css('--series-1')));
    makeChart(bEl, { type: 'line', data: { labels: b.yms.slice(-n).map(fmtYm), datasets: ds }, options: lineOpts });
  }
}

// ---------- 단지 상세 ----------
async function viewApt(code, key, id) {
  const region = requireRegion(code);
  const opts = monthOpts(APT_MONTHS);
  const monthView = `apt.${code}.${key}`;
  // 관심단지에 기억한 조회 기간이 이 탭의 선택보다 먼저다. 다른 기기에서 바꾼 기간도 반영되고, 이 화면에서 고르면 함께 바뀐다(setMonths)
  const savedMonths = watch.get(code, key)?.months;
  const months = opts.some(([m]) => m === savedMonths) ? savedMonths : getMonths(monthView, opts, 36);
  showLoading(`<div class="crumb"><a href="#/r/${code}">${esc(region.name)}</a> ›</div>${skeleton('불러오는 중… (처음 보는 기간은 30초 정도 걸릴 수 있어요)')}`);
  const J = isJ();
  const [d] = await Promise.all([getApt(code, key, months, J), getPolicies()]);
  if (isStale(id)) return;
  const pols = policyFor(code);
  destroyCharts();
  const { apt } = d;
  key = apt.key;
  const areaKey = `${code}:${key}`; // 다른 구에 같은 동·단지명이 있을 수 있어 지역 코드까지 포함
  // 평형별 전세 건수. 전세 보기는 전세가 많은 평형부터 보이고, 이번 달 매매만 있는 평형은 뺀다
  const jCount = new Map();
  d.rents.filter(A.isJeonse).forEach((t) => jCount.set(A.areaKey(t.area), (jCount.get(A.areaKey(t.area)) || 0) + 1));
  const areas = J ? d.areas.filter((a) => !a.partialOnly).sort((a, b) => (jCount.get(b.area) || 0) - (jCount.get(a.area) || 0)) : d.areas;
  // 이번 방문에서 고른 평형 → 저장한 관심 평형 → 주력 평형(전세 보기는 전세가 가장 많은 평형) 순
  const has = (a) => areas.some((x) => x.area === a);
  let areaSel = [state.aptArea?.[areaKey], watch.get(code, key)?.area].find(has) || areas[0].area;

  // 네이버는 통합검색의 부동산 박스(매물 수·호가)가 가장 확실하고, 호갱노노는 단지명 검색을 URL로 받는다.
  // KB·국토부는 검색어를 URL로 넘길 수 없어 클릭할 때 단지명을 복사해 붙여넣게 한다
  const regionName = region.name.replace(/ \(.+\)/, '');
  const naverQ = encodeURIComponent(`${regionName} ${apt.name} 아파트`);
  const hogangQ = encodeURIComponent(apt.name);
  app.innerHTML = `
    <div class="crumb"><a href="#/g/${esc(region.group)}">${esc(region.group)}</a> › <a href="#/r/${code}">${esc(region.name)}</a> ›</div>
    <div class="row">
      <h1>${esc(apt.name)}</h1>
      <button class="star ${watch.has(code, key) ? 'on' : ''}" id="star" title="관심단지에 저장 (지금 고른 평형을 관심 평형으로, 이 브라우저에 저장)" style="font-size:22px">★</button>
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
    <div class="row" style="margin-bottom:16px"><span class="muted">전용면적</span><div class="seg" id="areas">${areas.map((a) => `<button data-a="${a.area}" class="${a.area === areaSel ? 'on' : ''}">${a.area}㎡ <span class="muted">(${J ? `전세 ${jCount.get(a.area) || 0}건` : a.partialOnly ? `이번 달 ${a.partialCount}건 · 신고 진행 중` : `매매 ${a.count}건${a.partialCount ? ` · 이번 달 ${a.partialCount}건` : ''}`})</span></button>`).join('')}</div></div>
    <p class="watch-note" id="watchNote"></p>
    <p class="muted">조회 기간에 매매 또는 전세 거래가 있는 전용면적이에요. 거래가 없던 면적은 고를 수 없고, 조회 기간을 늘리면 더 오래전에 거래된 면적도 보여요. 원본 면적을 소수 둘째 자리까지 구분합니다.${!J && d.areas.some((a) => a.partialCount) ? ' 매매 건수는 지난달까지이고, 이번 달(신고 진행 중) 거래는 따로 셉니다.' : ''}${A.apartmentNames(code, apt.dong, apt.name, apt.jibun).length > 1 ? ` 원본 명칭: ${esc(A.apartmentNames(code, apt.dong, apt.name, apt.jibun).filter((n) => n !== apt.name).join(', '))}` : ''}</p><div id="areaView"></div>`;
  bindMonths(monthView, (m) => watch.setMonths(code, key, m));
  app.querySelectorAll('.copy-name').forEach((a) => a.addEventListener('click', () => {
    navigator.clipboard?.writeText(apt.name).then(() => {
      document.getElementById('copied').textContent = `'${apt.name}' 복사됨 — 검색창에 붙여넣으세요`;
    }, () => {});
  }));
  watch.markChecked(code, key, state.meta.buildNo); // 단지 화면을 열면 새로 확인된 거래 표시를 지운다
  // 관심 평형 안내: 저장 전에는 ★가 지금 고른 평형으로 저장된다고, 저장 뒤에는 관심 평형과 요약 화면 링크를 보여 준다
  const note = document.getElementById('watchNote');
  const renderWatch = () => {
    const w = watch.get(code, key);
    document.getElementById('star').classList.toggle('on', !!w);
    document.querySelectorAll('#areas button').forEach((x) => x.classList.toggle('saved', !!w && x.dataset.a === w.area));
    const sel = `<b>${areaSel}㎡</b>`;
    const toWatch = '<a href="#/watch">관심단지에서 요약 보기 →</a>';
    note.innerHTML = !w
      ? `★를 누르면 ${sel}를 관심 평형으로 관심단지에 저장해요. 관심단지에서 이 평형의 시세와 새로 확인된 거래를 모아 봐요. 가입 없이 이 브라우저에 저장돼요.`
      : w.area === areaSel
        ? `<span class="star on" aria-hidden="true">★</span> 관심 평형 ${sel}로 저장했어요. ${toWatch}`
        : `<span class="star on" aria-hidden="true">★</span> ${w.area ? `관심 평형은 <b>${w.area}㎡</b>예요` : '관심 평형을 고르지 않아 주력 평형으로 요약해요'}. <button type="button" class="btn" id="setArea">${areaSel}㎡를 관심 평형으로</button> ${toWatch}`;
    document.getElementById('setArea')?.addEventListener('click', () => { watch.setArea(code, key, areaSel); renderWatch(); });
  };
  document.getElementById('star').addEventListener('click', () => {
    watch.toggle({ code, key, name: apt.name, jibun: apt.jibun, region: region.name, area: areaSel, months });
    renderWatch();
  });
  document.querySelectorAll('#areas button').forEach((b) => b.addEventListener('click', () => {
    areaSel = b.dataset.a;
    state.aptArea = { ...(state.aptArea || {}), [areaKey]: areaSel };
    document.querySelectorAll('#areas button').forEach((x) => x.classList.toggle('on', x === b));
    renderWatch();
    renderArea();
  }));
  renderWatch();

  function renderArea() {
    destroyCharts();
    const sel = d.areas.find((a) => a.area === areaSel);
    if (J) { renderJeonseArea(sel); return; }
    // 이번 달에만 거래가 있는 평형: 시세·차트 없이 신고 진행 중인 거래와 전세만 보여 준다
    if (sel.partialOnly) {
      const cur = d.partial.filter((t) => A.areaKey(t.area) === areaSel);
      const jeonse = d.rents.filter((t) => A.areaKey(t.area) === areaSel && t.monthly === 0);
      document.getElementById('areaView').innerHTML = `
        <p class="card muted">이 평형은 이번 달(신고 진행 중) 매매만 있어요. ${PARTIAL_HELP}</p>
        <div class="grid2">
          <div class="card table-wrap"><h2>최근 매매</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>거래가</th><th>평당가</th><th class="l">유형</th></tr></thead><tbody>
            ${cur.slice().reverse().map((t) => `<tr${t.bulk ? ' class="muted"' : ''}><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.price)}</td><td>${fmtMan(t.price / (t.area / PYEONG))}</td><td class="l muted">${partialTag} ${esc(t.kind)}${t.bulk ? ` · <span class="tag" title="같은 날 직거래 ${BULK_HINT}">일괄</span>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="card table-wrap"><h2>최근 전세</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>보증금</th><th class="l">원본 명칭</th></tr></thead><tbody>
            ${jeonse.slice(-25).reverse().map((t) => `<tr><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.deposit)}</td><td class="l muted">${esc(t.sourceApt || t.apt)}</td></tr>`).join('') || '<tr><td class="l muted" colspan="4">전세 거래 없음</td></tr>'}
          </tbody></table></div>
        </div>`;
      return;
    }
    const ind = sel.indicators;
    const all = d.trades.filter((t) => A.areaKey(t.area) === areaSel);
    const trades = all.filter((t) => !t.bulk);
    const jeonse = d.rents.filter((t) => A.areaKey(t.area) === areaSel && t.monthly === 0);
    const recent = median(trades.slice(-3).map((t) => t.price));
    const max = trades.length ? trades.reduce((a, b) => (b.price > a.price ? b : a)) : null;
    const last = trades[trades.length - 1];
    const jRecent = median(jeonse.slice(-5).map((t) => t.deposit));
    const cur = d.partial.filter((t) => A.areaKey(t.area) === areaSel); // 이번 달(신고 진행 중): 목록에만

    document.getElementById('areaView').innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="label">최근 시세 (최근 3건 중위)</div><div class="value num">${fmtEok(recent)}</div><div class="hint">마지막 ${last ? `${last.date.slice(2).replace(/-/g, '.')} · ${last.floor}층 ${fmtEok(last.price)}` : '해당 기간 매매 거래 없음'}</div></div>
        <div class="kpi"><div class="label">기간 내 최고가</div><div class="value num">${fmtEok(max?.price)}</div><div class="hint">${max ? `${max.date.slice(2).replace(/-/g, '.')} · ${max.floor}층` : '해당 기간 매매 거래 없음'}</div></div>
        <div class="kpi"><div class="label">최고가 대비</div><div class="value num">${delta(recent && max ? recent / max.price - 1 : null)}</div><div class="hint">6개월 이동평균 3개월 변화 ${delta(ind.chg3m)}</div></div>
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
            ${pols.length ? policyChip(state.ap.policy) : ''}
          </div>
        </div>
        <div class="tv-stage"><div class="tv-box" id="ap"></div><div class="tv-pop" id="apPop" hidden></div></div>
        <p class="muted tv-note">점이나 월봉을 누르면 상세 정보가 나와요 · <span class="up">빨간 테두리</span> = 신고가${cur.length ? ` · 이번 달 거래 ${cur.length}건은 신고 진행 중이라 차트·시세에 넣지 않았어요 (아래 최근 매매에 표시)` : ''}${pols.length ? policyNote(code) : ''}</p>
      </div>
      <div class="grid2">
        <div class="card table-wrap"><h2>최근 매매</h2>${cur.length ? `<p class="muted" style="font-size:12px;margin:0 0 8px">${PARTIAL_HELP}</p>` : ''}<table><thead><tr><th class="l">계약일</th><th>층</th><th>거래가</th><th>평당가</th><th class="l">유형</th></tr></thead><tbody>
          ${[...all.slice(-25), ...cur].reverse().map((t) => `<tr${t.bulk ? ' class="muted"' : ''}><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.price)}</td><td>${fmtMan(t.price / (t.area / PYEONG))}</td><td class="l muted">${t.partial ? `${partialTag} ` : ''}${esc(t.kind)}${t.sourceApt && t.sourceApt !== apt.name ? ` · ${esc(t.sourceApt)}` : ''}${t.bulk ? ` · <span class="tag" title="같은 날 직거래 ${BULK_HINT}">일괄</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="card table-wrap"><h2>최근 전세</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>보증금</th><th class="l">원본 명칭</th></tr></thead><tbody>
          ${jeonse.slice(-25).reverse().map((t) => `<tr><td class="l">${t.date.slice(2).replace(/-/g, '.')}</td><td>${t.floor}</td><td>${fmtEok(t.deposit)}</td><td class="l muted">${esc(t.sourceApt || t.apt)}</td></tr>`).join('') || '<tr><td class="l muted" colspan="4">전세 거래 없음</td></tr>'}
        </tbody></table></div>
      </div>`;

    aptChart(sel, trades, jeonse, '매매', pols);
  }
  // 전세 보기: 이 평형의 전세 시세·차트·최근 전세만. 매매는 전세가율·갭 계산에만 쓴다
  function renderJeonseArea(sel) {
    const el = document.getElementById('areaView');
    const jeonse = d.rents.filter((t) => A.areaKey(t.area) === areaSel && A.isJeonse(t));
    if (!jeonse.length) {
      el.innerHTML = `<p class="card muted">이 평형은 조회 기간에 전세 거래가 없어요. 다른 평형을 고르거나 조회 기간을 늘려 보세요. 위에서 매매로 바꾸면 매매 거래를 볼 수 있어요.</p>`;
      return;
    }
    const ind = sel.indicators, jind = A.jeonseIndicators(sel.series);
    const sales = d.trades.filter((t) => !t.bulk && A.areaKey(t.area) === areaSel);
    const recent = median(jeonse.slice(-3).map((t) => t.deposit));
    const sRecent = median(sales.slice(-3).map((t) => t.price));
    const max = jeonse.reduce((a, b) => (b.deposit > a.deposit ? b : a));
    const last = jeonse[jeonse.length - 1];
    const dd = (date) => date.slice(2).replace(/-/g, '.');
    el.innerHTML = `
      <p class="muted">${SALE_ONLY_NOTE}</p>
      <div class="kpis">
        <div class="kpi"><div class="label">최근 전세 (최근 3건 중위)</div><div class="value num">${fmtEok(recent)}</div><div class="hint">마지막 ${dd(last.date)} · ${last.floor}층 ${fmtEok(last.deposit)}</div></div>
        <div class="kpi"><div class="label">기간 내 최고 보증금</div><div class="value num">${fmtEok(max.deposit)}</div><div class="hint">${dd(max.date)} · ${max.floor}층</div></div>
        <div class="kpi"><div class="label">최고 보증금 대비</div><div class="value num">${delta(recent / max.deposit - 1)}</div><div class="hint">6개월 이동평균 3개월 변화 ${delta(jind.chg3m)}</div></div>
        <div class="kpi"><div class="label">전세가율</div><div class="value num">${fmtPct(ind.jeonseRatio, 0)}</div><div class="hint">매매 최근 3건 중위 ${fmtEok(sRecent)} · 갭 ${recent && sRecent ? fmtEok(sRecent - recent) : '–'}</div></div>
      </div>
      <div class="card">
        <div class="tv-head">
          <div class="tv-label">${areaSel}㎡ 전세가 <span class="muted">6개월 이동평균</span> ${tip('점 하나가 전세 실거래 1건이에요. 점을 누르면 그 거래의 상세 정보가 나오고, 카드에서 기준으로 잡으면 다른 거래·시점의 등락률을 보여줘요. 월봉은 그 달 첫 거래→마지막 거래가 몸통, 최저~최고가 꼬리예요. 아래 칸은 월별 전세 건수. 1~3층을 끄면 점·월봉·건수에서만 빠지고 이동평균은 그대로예요.')}</div>
          <div class="tv-value num" id="apValue"></div>
          <div class="tv-sub num" id="apSub"></div>
        </div>
        <div class="row tv-ctrl">
          ${rangeSeg('apRange', sel.series.length)}
          <div class="seg" id="apMode">${[['dots', '실거래'], ['candle', '월봉']].map(([m, l]) => `<button data-m="${m}" class="${state.ap.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <div class="chips" id="apToggle">
            <span class="chip-static"><i id="apSwatch"></i>전세 6개월 이동평균</span>
            <span class="chip-static"><i class="dot" style="background:${css('--series-2')}"></i><span id="apKind">${state.ap.mode === 'dots' ? '전세 실거래' : '전세 월봉'}</span></span>
            <button data-s="low" class="${state.ap.low ? 'on' : ''}" title="저층(1~3층·지하)은 시세보다 낮게 거래되는 경우가 많아요. 눌러서 켜고 끄기">1~3층 포함</button>
            ${pols.length ? policyChip(state.ap.policy) : ''}
          </div>
        </div>
        <div class="tv-stage"><div class="tv-box" id="ap"></div><div class="tv-pop" id="apPop" hidden></div></div>
        <p class="muted tv-note">점이나 월봉을 누르면 상세 정보가 나와요${pols.length ? policyNote(code) : ''}</p>
      </div>
      <div class="card table-wrap"><h2>최근 전세</h2><table><thead><tr><th class="l">계약일</th><th>층</th><th>보증금</th><th>평당 전세가</th><th class="l">원본 명칭</th></tr></thead><tbody>
        ${jeonse.slice(-40).reverse().map((t) => `<tr><td class="l">${dd(t.date)}</td><td>${t.floor}</td><td>${fmtEok(t.deposit)}</td><td>${fmtMan(t.deposit / (t.area / PYEONG))}</td><td class="l muted">${esc(t.sourceApt || t.apt)}</td></tr>`).join('')}
      </tbody></table></div>`;
    // 전세 거래를 차트의 주 시리즈로: 보증금을 price 자리에, 전세 이동평균을 ma 자리에
    aptChart({ ...sel, series: sel.series.map((r) => ({ ...r, ma: r.jeonseMa, jeonseMa: null })) }, jeonse.map((t) => ({ ...t, price: t.deposit })), [], '전세', pols);
  }
  renderArea();
}

// ---------- 개인정보처리방침 ----------
const PRIVACY_UPDATED = '2026-10-25';
function viewPrivacy() {
  const on = metrics.available();
  app.innerHTML = `<article class="card prose">
    <h1>개인정보처리방침</h1>
    <p class="muted">시행일 ${PRIVACY_UPDATED}</p>
    <p>homeTrend는 회원가입·로그인 없이 쓰는 사이트예요. 이름·전화번호·이메일을 받지 않고, 쿠키나 외부 분석 도구(구글 애널리틱스 등)를 쓰지 않아요.
    사이트를 더 쓸모 있게 고치려고, 어떤 화면이 쓰이고 다시 찾아오는지를 아래 범위에서만 직접 측정해요.</p>

    <h2>브라우저에만 저장하는 것</h2>
    <ul>
      <li>관심단지(★)와 관심 평형, 좋아요한 지역(♥) — 동기화 코드를 만들거나 연결하지 않으면 서버로 보내지 않아요(아래).</li>
      <li>테마, 화면 설정(매매/전세 보기, 첫 방문 안내를 닫았는지 포함), 관심단지별 마지막 확인 시점 — 서버로 보내지 않아요.</li>
      <li>무작위 기기 ID와 첫 방문 시각 — 측정에 써요(아래).</li>
    </ul>

    <h2>동기화 코드를 쓸 때 서버에 저장하는 것</h2>
    <p>관심단지 화면에서 동기화 코드를 만들거나 다른 기기의 코드로 연결한 경우에만 저장해요.</p>
    <ul>
      <li><b>관심 목록</b>: 관심단지(단지 이름·지번·지역, 관심 평형, 단지 화면 조회 기간)와 좋아요한 지역, 항목별 변경 순번, 지운 항목의 삭제 표시(90일 보관 뒤 삭제), 만든·고친 시각.</li>
      <li><b>동기화 코드</b>: 무작위로 만든 128비트 값이에요. 서버에는 코드 원문이 아니라 해시(SHA-256)만 저장하고, 코드는 주소가 아닌 요청 본문으로만 받아요. 측정용 기기 ID와 연결하지 않아요.</li>
      <li>코드나 링크를 아는 사람은 누구나 목록을 보고 고칠 수 있어요. 공유에 주의하고, 알려졌다면 재발급하세요. 재발급하면 이전 코드는 바로 무효가 돼요.</li>
      <li><b>보관과 삭제</b>: 1년간 어느 기기에서도 열지 않으면 코드와 목록을 자동으로 지워요. 관심단지 화면의 '코드 관리 → 서버에서 삭제'로 바로 지울 수도 있어요.</li>
    </ul>

    <h2>측정을 위해 보내는 것</h2>
    <ul>
      <li><b>무작위 기기 ID</b>: 이 브라우저에서 처음 만든 임의의 값이에요. 사람이나 기기 정보와 연결되지 않고, 다른 브라우저·기기와 공유되지 않아요.</li>
      <li><b>행동 종류</b>: 방문, 화면 종류(개요·지역·단지·관심단지), 검색 결과 선택(지역인지 단지인지만), 관심단지 추가·삭제와 개수, 관심 평형을 골랐는지 여부(어떤 평형인지는 보내지 않아요), 첫 방문 안내를 보거나 닫거나 검색을 시작했는지, 관심단지의 새 거래 유무·건수와 확인 여부, 동기화 코드 만들기·연결·재발급·삭제·해제와 충돌 여부(코드는 보내지 않아요), 매매/전세 보기를 바꿨는지와 전세 보기에서 본 화면인지.</li>
      <li><b>첫 방문 시각, 모바일 여부</b>, 서버가 받은 시각, 측정 방식 버전.</li>
    </ul>

    <h2>보내지 않는 것</h2>
    <ul>
      <li>측정 기록에는 검색어, 어떤 지역·단지를 봤거나 저장했는지(관심 목록 내용)를 담지 않아요.</li>
      <li>이름·연락처·이메일, 쿠키, 브라우저 지문.</li>
      <li>IP 주소: 과도한 요청을 막는 판정에만 잠깐 쓰고 저장하지 않아요.</li>
    </ul>

    <h2>보관 기간</h2>
    <ul>
      <li>행동 기록과 날짜별 요약: 받은 날부터 90일 뒤 자동 삭제.</li>
      <li>기기별 요약(첫 방문·관심단지 저장·재방문 날짜): 마지막 방문부터 90일 뒤 자동 삭제.</li>
      <li>날짜별 합계(예: "10월 15일 방문 기기 120대")는 기기를 알아볼 수 없는 숫자라서 계속 보관해요.</li>
    </ul>

    <h2>처리 장소</h2>
    <p>측정 기록과 동기화 목록은 Amazon Web Services 서울 리전(ap-northeast-2)의 운영자 계정에 저장돼요. 사이트 파일은 GitHub Pages로 제공되며, GitHub이 접속 기록을 따로 처리할 수 있어요(<a href="https://docs.github.com/ko/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">GitHub 개인정보처리방침</a>).</p>

    <h2>측정 끄기와 기록 삭제</h2>
    ${on ? `<p>측정을 끄면 이 브라우저는 더 이상 아무것도 보내지 않아요. 기록 삭제는 서버에 있는 이 기기의 기록을 바로 지우고 기기 ID를 새로 만들어요.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button type="button" class="btn" id="metricsToggle"></button>
      <button type="button" class="btn" id="metricsDelete">이 기기 기록 삭제</button>
    </div>
    <p class="muted" id="metricsMsg" role="status" style="font-size:13px"></p>` : '<p>지금 이 사이트(또는 이 브라우저)에서는 측정이 켜져 있지 않아 보내는 기록이 없어요. 브라우저 저장소를 지우면 기기 ID도 함께 지워져요.</p>'}
    <p>브라우저 설정에서 이 사이트의 저장 데이터를 지우면 관심단지와 함께 기기 ID·동기화 코드도 지워져요. 이 경우 서버의 기록은 위 보관 기간이 지나면 삭제돼요. 동기화 코드를 다른 곳에 적어 두었다면 그 코드로 목록을 다시 받을 수 있어요.</p>

    <h2>문의</h2>
    <p><a href="https://github.com/Thirdsense3/homeTrend/issues" target="_blank" rel="noopener">GitHub 이슈</a>로 알려 주세요. 측정·동기화 항목이나 보관 기간이 바뀌면 이 페이지와 시행일을 먼저 고쳐요.</p>
  </article>`;
  if (!on) return;
  const toggle = document.getElementById('metricsToggle'), msg = document.getElementById('metricsMsg');
  const draw = () => { toggle.textContent = metrics.off() ? '측정 다시 켜기' : '이 브라우저에서 측정 끄기'; };
  draw();
  toggle.addEventListener('click', () => {
    metrics.setOff(!metrics.off());
    draw();
    msg.textContent = metrics.off() ? '측정을 껐어요. 이 브라우저는 더 이상 기록을 보내지 않아요.' : '측정을 다시 켰어요.';
  });
  document.getElementById('metricsDelete').addEventListener('click', async (e) => {
    e.target.disabled = true;
    msg.textContent = '삭제하는 중…';
    try {
      await metrics.remove();
      msg.textContent = '이 기기의 서버 기록을 지웠어요.' + (metrics.off() ? '' : ' 측정이 켜져 있으면 다음 방문부터 새 기기 ID로 기록돼요.');
    } catch (err) {
      msg.textContent = `삭제하지 못했어요 (${err.message}). 잠시 뒤 다시 시도해 주세요.`;
    }
    e.target.disabled = false;
  });
}

// ---------- 정책 타임라인 (로드맵 9번, 자료 형식은 lib/policies.js) ----------
// 발표일·시행일과 원문만 보여 준다. 가격 변화의 원인으로 해석하지 않는다
const POLICY_CATEGORIES = ['대출', '규제지역', '토지거래허가', '세제', '공급'];
const POLICY_NOTE = '요약은 참고용이에요. 정확한 조건은 원문에서 확인하세요. 발표 뒤의 가격 변화가 정책 때문이라는 뜻은 아니에요.';
// 이 지역에 해당하는 정책 (lib/policies.js appliesTo와 같은 규칙)
const policyApplies = (p, code) => p.regions.some((x) => x === 'all' || x === regionOf(code)?.group || x === code);
const policyFor = (code) => (state.policies?.items || []).filter((p) => policyApplies(p, code));
// 대상 지역 이름. 지역 코드가 많으면 몇 곳만 적는다
function policyRegions(p) {
  const names = p.regions.map((x) => (x === 'all' ? '전국' : regionOf(x) ? regionShort(x) : x));
  return names.length > 6 ? `${names.slice(0, 5).join('·')} 외 ${names.length - 5}곳` : names.join('·');
}
const fullDate = (d) => d.replace(/-/g, '.');

async function viewPolicy(code, id) {
  const region = code ? requireRegion(code) : null;
  showLoading(`<h1>정책 타임라인</h1>${skeleton()}`);
  const data = await getPolicies();
  if (isStale(id)) return;
  if (!data) { app.innerHTML = '<div class="card err">정책 자료를 불러오지 못했습니다.</div>'; return; }
  const all = (region ? policyFor(code) : data.items).slice().sort((a, b) => b.announced.localeCompare(a.announced) || a.id.localeCompare(b.id));
  const cats = POLICY_CATEGORIES.filter((c) => all.some((p) => p.category === c));
  app.innerHTML = `
    ${region ? `<div class="crumb"><a href="#/r/${code}">${esc(region.name)}</a> ›</div>` : ''}
    <div class="row"><h1>${region ? `${esc(regionShort(code))} 정책 타임라인` : '정책 타임라인'}</h1><span class="spacer"></span>
      <select id="polRegion" aria-label="지역 고르기"><option value="">전체 지역</option>${state.meta.regions.map((r) => `<option value="${r.code}" ${r.code === code ? 'selected' : ''}>${esc(r.group)} ${esc(r.name)}</option>`).join('')}</select>
    </div>
    <p class="lead">주택 대출·규제지역·토지거래허가·세제·공급 정책의 발표일과 원문이에요. ${POLICY_NOTE}</p>
    <div class="row" style="margin-bottom:12px"><div class="seg" id="polCat"><button data-c="" class="on">전체</button>${cats.map((c) => `<button data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
    <div class="card"><ol class="timeline" id="polList"></ol></div>
    <p class="muted" style="font-size:12px">마지막 수정 ${fullDate(data.updated)} · 지역·단지 차트의 <span class="pol-mark">▼</span>는 발표한 달이에요. 해제·변경된 정책도 지우지 않고 남겨요. 빠졌거나 틀린 내용은 <a href="https://github.com/Thirdsense3/homeTrend/issues" target="_blank" rel="noopener">GitHub 이슈</a>로 알려 주세요.</p>`;
  const render = (cat) => {
    const list = all.filter((p) => !cat || p.category === cat);
    let year = '';
    document.getElementById('polList').innerHTML = list.map((p) => {
      const y = p.announced.slice(0, 4), head = y !== year ? `<li class="tl-year">${y}</li>` : '';
      year = y;
      return `${head}<li class="tl-item">
        <div class="tl-date num">${fullDate(p.announced).slice(5)}</div>
        <div class="tl-body">
          <div><span class="tag">${esc(p.category)}</span> <b>${esc(p.title)}</b>${p.ended ? ' <span class="tag">종료</span>' : ''}</div>
          <p class="muted tl-meta">${[`발표 ${fullDate(p.announced)}`, p.effective && `시행 ${fullDate(p.effective)}`, p.ended && `종료 ${fullDate(p.ended)}`, `대상 ${esc(policyRegions(p))}`].filter(Boolean).join(' · ')}</p>
          <p>${esc(p.summary)}</p>
          <a href="${esc(p.source)}" target="_blank" rel="noopener">원문 보기</a>
        </div>
      </li>`;
    }).join('') || '<li class="muted">해당하는 정책이 없어요.</li>';
  };
  app.querySelectorAll('#polCat button').forEach((btn) => btn.addEventListener('click', () => {
    app.querySelectorAll('#polCat button').forEach((x) => x.classList.toggle('on', x === btn));
    render(btn.dataset.c);
  }));
  document.getElementById('polRegion').addEventListener('change', (e) => { location.hash = e.target.value ? `#/policy/${e.target.value}` : '#/policy'; });
  render('');
}

// ---------- 관심단지 ----------
// 이번 달(신고 진행 중) 거래 표시. 시세·차트·지표에는 넣지 않고 목록에서만 이 표시와 함께 보여 준다
const PARTIAL_HELP = '이번 달 계약은 신고 기한(계약 후 30일)이 남아 거래가 계속 늘어나요. 그래서 시세·차트·지역 지표에는 넣지 않고, 다음 달부터 반영해요.';
const partialTag = `<span class="tag partial" title="${PARTIAL_HELP}">이번 달 · 신고 진행 중</span>`;
const isPartialDate = (date) => !!state.meta?.partial && date.slice(0, 4) + date.slice(5, 7) === state.meta.partial.ym;
// 빌드 번호 → 그 빌드의 날짜 (meta.builds). 0이나 모르는 번호는 null
const buildDate = (no) => state.meta?.builds?.[no] || null;
const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '–'); // 2026-10-05 → 10/5
const tradeLine = (t) => `${fmtDate(t.date)} · ${t.area}㎡ ${t.floor}층 · <b class="num">${fmtEok(t.price)}</b>`;
const SURGE_NOTE = '과거 거래 기준이며 앞으로의 가격을 뜻하지 않아요';
const surgeBasis = (b) => `직전 6개월 중위값 ${fmtEok(b.median)} 대비 ${delta(b.rise)} · 기준 거래 ${b.n}건 · 최근 60일 높은 거래 ${b.count}건`;

// ---------- 동기화 코드 화면 (관심단지 화면: 위에 확인 대기 변경, 아래에 코드 카드) ----------
const QR_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const syncLink = (code) => `${location.origin}${location.pathname}#/sync/${code}`;
const fmtTime = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// 서버 주소가 없으면(측정·동기화 서버를 쓰지 않는 배포, 로컬 서버) 동기화 화면을 그리지 않는다
const syncSlots = () => (sync.available() ? ['<div id="syncHeld"></div>', '<section class="card sync" id="sync"></section>'] : ['', '']);

// 동기화 링크(#/sync/<코드>)로 들어옴: 주소에서 코드를 지운 뒤 연결한다
async function linkFromUrl(input) {
  const code = normalizeSyncCode(input);
  const c = sync.conf();
  if (!sync.available()) sync.notice = '지금은 동기화를 쓸 수 없어요. 목록은 이 브라우저에만 저장돼요.';
  else if (!code) sync.notice = '링크의 동기화 코드 형식이 맞지 않아요. 링크를 다시 복사해 열어 주세요.';
  else if (c?.code === code) sync.notice = '이미 이 코드로 동기화하고 있어요.';
  else if (c && !confirm('이 기기는 다른 동기화 코드에 연결돼 있어요. 링크의 코드로 바꿀까요? 지금 코드의 목록은 서버에 그대로 남아요.')) return;
  else {
    // 상태만 바꾸고 알리지 않는다 (알리면 카드가 먼저 다시 그려지며 안내를 써 버린다). 아래 route()가 다시 그린다
    sync.status = 'syncing';
    try {
      await sync.link(code);
      sync.notice = '연결했어요. 이제 이 기기에서도 같은 목록을 봐요.';
      sync.status = 'ok';
    } catch (e) {
      sync.notice = `연결하지 못했어요: ${e.message}`;
      sync.status = e.status ? '' : 'error';
    }
  }
  if (location.hash.startsWith('#/watch')) route();
}

function renderSync() {
  renderHeld();
  const el = document.getElementById('sync');
  if (!el) return;
  const c = sync.conf();
  el.dataset.code = c?.code || '';
  const notice = sync.notice ? `<p class="sync-notice" role="status">${esc(sync.notice)}</p>` : '';
  sync.notice = '';
  el.innerHTML = !c
    ? `<h2>다른 기기에서도 보기</h2>${notice}
      <p class="muted">동기화 코드를 만들면 관심단지(관심 평형·조회 기간 포함)와 좋아요한 지역을 서버에 저장하고, 링크나 QR로 휴대폰·다른 브라우저를 연결해요. 가입·로그인은 필요 없어요. 만들지 않으면 지금처럼 이 브라우저에만 저장돼요.</p>
      <div class="row sync-row"><button type="button" class="btn" data-sync="create">동기화 코드 만들기</button></div>
      <form class="row sync-row" id="syncForm"><input type="text" id="syncInput" placeholder="다른 기기에서 받은 코드" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="동기화 코드"><button class="btn">연결</button></form>
      <p class="muted sync-msg" id="syncMsg" role="status"></p>`
    : `<div class="row"><h2 style="margin:0">다른 기기에서도 보기</h2><span class="tag new">동기화 켜짐</span></div>${notice}
      <p>다른 기기에서 아래 링크를 열거나 QR을 찍으면 같은 목록을 봐요. 어느 기기에서 바꿔도 서로 맞춰져요.</p>
      <div class="sync-code num" aria-label="동기화 코드">${fmtCode(c.code)}</div>
      <div class="row sync-row"><button type="button" class="btn" data-sync="copy">링크 복사</button><button type="button" class="btn" data-sync="qr">QR 보기</button><button type="button" class="btn" data-sync="now">지금 동기화</button></div>
      <div class="sync-qr" id="syncQr" hidden></div>
      <p class="sync-warn">코드나 링크를 아는 사람은 누구나 이 목록을 보고 고칠 수 있어요. 공개된 곳에 올리지 말고, 다른 사람이 알게 됐다면 재발급하세요.</p>
      <p class="muted sync-msg" id="syncStatus"></p>
      <p class="muted sync-msg" id="syncMsg" role="status"></p>
      <details><summary>코드 관리</summary>
        <div class="row sync-row"><button type="button" class="btn" data-sync="rotate">코드 재발급</button><span class="muted">새 코드를 만들고 지금 코드는 바로 무효가 돼요. 다른 기기는 새 링크로 다시 연결해야 해요.</span></div>
        <div class="row sync-row"><button type="button" class="btn" data-sync="unlink">이 기기 연결 해제</button><span class="muted">목록은 이 브라우저에 남고, 서버와 다른 기기는 그대로예요.</span></div>
        <div class="row sync-row"><button type="button" class="btn" data-sync="delete">서버에서 삭제</button><span class="muted">서버의 목록과 코드를 바로 지워요. 이 브라우저 목록은 남아요. 1년간 어느 기기에서도 열지 않으면 자동으로 지워져요.</span></div>
      </details>`;
  drawSyncStatus();
  const msg = document.getElementById('syncMsg');
  el.onclick = async (e) => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const act = b.dataset.sync;
    if (act === 'copy') {
      const link = syncLink(sync.conf().code);
      navigator.clipboard?.writeText(link).then(() => { msg.textContent = '링크를 복사했어요. 다른 기기에서 열어 주세요.'; }, () => { msg.textContent = link; });
      return;
    }
    if (act === 'qr') {
      const box = document.getElementById('syncQr');
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? 'QR 보기' : 'QR 닫기';
      if (!box.hidden && !box.innerHTML) showQr(box, syncLink(sync.conf().code)).catch((err) => { box.hidden = true; msg.textContent = err.message; });
      return;
    }
    if (act === 'rotate' && !confirm('코드를 재발급할까요? 지금 코드와 링크는 바로 무효가 되고, 다른 기기는 새 링크로 다시 연결해야 해요.')) return;
    if (act === 'delete' && !confirm('서버의 목록과 코드를 지울까요? 이 브라우저 목록은 남지만, 이 코드로 연결한 다른 기기는 더 이상 맞춰지지 않아요.')) return;
    b.disabled = true;
    msg.textContent = '처리하는 중…';
    try {
      if (act === 'create') await sync.create();
      else if (act === 'now') { await sync.run(); msg.textContent = ''; b.disabled = false; return; }
      else if (act === 'rotate') { await sync.rotate(); sync.notice = '새 코드를 만들었어요. 다른 기기는 새 링크로 다시 연결해 주세요.'; }
      else if (act === 'unlink') { sync.unlink(); sync.notice = '이 기기의 연결을 해제했어요. 목록은 이 브라우저에 그대로 있어요.'; }
      else if (act === 'delete') { await sync.remove(); sync.notice = '서버의 목록과 코드를 지웠어요. 이 브라우저 목록은 그대로예요.'; }
      renderSync();
    } catch (err) {
      msg.textContent = `하지 못했어요 (${err.message}). 잠시 뒤 다시 시도해 주세요.`;
      b.disabled = false;
    }
  };
  document.getElementById('syncForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    msg.textContent = '연결하는 중…';
    try {
      await sync.link(document.getElementById('syncInput').value);
      sync.notice = '연결했어요. 이제 이 기기에서도 같은 목록을 봐요.';
      route();
    } catch (err) {
      msg.textContent = `연결하지 못했어요: ${err.message}`;
      btn.disabled = false;
    }
  });
}
function drawSyncStatus() {
  const el = document.getElementById('syncStatus');
  const c = sync.conf();
  if (!el || !c) return;
  const n = sync.pending(c).length;
  el.textContent = sync.status === 'syncing' ? '동기화하는 중…'
    : sync.status === 'error' ? `서버에 연결하지 못했어요. 목록은 이 브라우저에 저장돼 있고, 다음에 다시 맞춰요${n ? ` (보내지 못한 변경 ${n}건)` : ''}.`
    : `마지막 동기화 ${c.at ? fmtTime(c.at) : '–'}${n ? ` · 보낼 변경 ${n}건` : ''}`;
}
// 연결 상태가 바뀌면 카드를 다시 그리고, 아니면 상태 줄만 고친다 (입력 중인 코드를 지우지 않게)
document.addEventListener('ht:sync', () => {
  const el = document.getElementById('sync');
  if (el && el.dataset.code !== (sync.conf()?.code || '')) renderSync();
  else { drawSyncStatus(); renderHeld(); }
});
// 다른 기기에서 바꾼 목록: 화면으로 돌아올 때 받는다 (1분에 한 번까지). 떠날 때 보낼 게 남았으면 바로 보낸다
document.addEventListener('visibilitychange', () => {
  const c = sync.conf();
  if (!c || !sync.available()) return;
  if (document.visibilityState === 'visible' ? Date.now() - sync.lastRun > 60000 : sync.pending(c).length) sync.run();
});
// 오프라인에서 저장한 변경은 네트워크가 돌아오면 보낸다
window.addEventListener('online', () => { if (sync.status === 'error') sync.run(); });
async function showQr(box, text) {
  if (!window.qrcode) {
    await new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = QR_SRC;
      s.onload = ok;
      s.onerror = () => no(new Error('QR 도구를 불러오지 못했어요. 링크 복사를 써 주세요.'));
      document.head.append(s);
    });
  }
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: '동기화 링크 QR 코드' });
}

// 확인을 기다리는 이 기기 변경 (충돌, 오래 동기화하지 않음, 연결할 때 이 기기에만 있던 항목)
const HELD_TEXT = {
  conflict: '다른 기기에서 먼저 바뀐 항목이 있어 서버 값을 보여 주고 있어요. 이 기기에서 한 변경을 다시 적용할까요?',
  stale: '이 기기는 오래 동기화하지 않아 서버 목록을 먼저 받았어요. 그동안 이 기기에서만 한 변경을 적용할까요?',
  link: '이 기기에 있던 목록 중 동기화 목록에 없거나 다른 항목이에요. 동기화 목록에 합칠까요?',
};
function renderHeld() {
  const el = document.getElementById('syncHeld');
  if (!el) return;
  const h = sync.conf() && sync.held();
  if (!h) { el.innerHTML = ''; return; }
  const local = sync.local();
  const line = (x) => {
    const act = !x.v ? '삭제' : !local.has(x.id) ? '추가' : x.v.area && x.v.area !== local.get(x.id).area ? `관심 평형 ${x.v.area}㎡로 변경` : '변경';
    return `<li>${x.id.startsWith('r:') ? '♥' : '★'} ${esc(x.name)} — ${act}</li>`;
  };
  const [yes, no] = h.reason === 'link' ? ['합치기', '합치지 않기'] : ['다시 적용', '서버 값 유지'];
  el.innerHTML = `<section class="card sync-held">
    <p style="margin:0"><b>${HELD_TEXT[h.reason] || HELD_TEXT.conflict}</b></p>
    <ul class="changes">${h.changes.slice(0, 8).map(line).join('')}${h.changes.length > 8 ? `<li class="muted">외 ${h.changes.length - 8}건</li>` : ''}</ul>
    <div class="row sync-row"><button type="button" class="btn" data-held="apply">${yes}</button><button type="button" class="btn" data-held="discard">${no}</button></div>
  </section>`;
  el.querySelector('[data-held="apply"]').addEventListener('click', () => { sync.applyHeld(); route(); });
  el.querySelector('[data-held="discard"]').addEventListener('click', () => { sync.discardHeld(); renderHeld(); });
}

async function viewWatch(id) {
  const saved = watch.list();
  const no = state.meta.buildNo;
  let recent = null;
  if (saved.length) {
    showLoading(skeleton('관심단지를 확인하는 중…'));
    [recent] = await Promise.all([getRecent(), ...[...new Set(saved.map((w) => w.code))].map((code) => getRaw(code, 36).catch(() => null))]);
    if (isStale(id)) return;
  }
  const list = watch.list();
  if (!list.length) {
    const [held, card] = syncSlots();
    app.innerHTML = `<h1>관심단지</h1>${held}<section class="card guide"><p style="margin:0 0 4px">아직 관심단지가 없어요. 이렇게 저장해 보세요.</p>${guideSteps()}</section>${card}`;
    bindGuideSearch(app);
    renderSync();
    return;
  }
  const help = no
    ? "저장한 관심 평형(고르지 않았으면 주력 평형) 기준이에요. 지난번 확인한 뒤의 데이터 갱신에서 처음 확인된 실거래를 '새로 확인'으로 표시해요. 계약일이 지난 거래가 늦게 신고돼도 잡혀요. 단지를 눌러 상세를 보면 확인한 것으로 바뀌어요. '이번 달 · 신고 진행 중' 거래는 새로 확인된 거래로는 보여 주지만, 시세·차트에는 다음 달부터 반영해요."
    : '저장한 관심 평형(고르지 않았으면 주력 평형) 기준이에요. 눌러서 상세를 볼 수 있어요.';
  const J = isJ();
  const [held, card] = syncSlots();
  app.innerHTML = `<div class="row"><h1>관심단지 ${tip(J ? '저장한 관심 평형(고르지 않았거나 그 평형에 전세가 없으면 전세가 가장 많은 평형)의 전세 시세예요. 눌러서 상세를 볼 수 있어요.' : help)}</h1><span class="spacer"></span>${no ? `<span class="muted" style="font-size:12px">${md(buildDate(no))} 갱신</span>${J ? '' : '<button type="button" class="btn" id="checkAll" hidden>모두 확인</button>'}` : ''}</div>
    ${J ? `<p class="muted">${SALE_ONLY_NOTE}</p>` : ''}
    ${held}<div class="watch-grid">${list.map((w, i) => `
    <div class="card" data-href="#/a/${w.code}/${encodeURIComponent(w.key)}" data-i="${i}" id="w${i}">
      <div class="row"><b>${esc(w.name)}</b><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
      <div class="muted">불러오는 중…</div>
    </div>`).join('')}</div>
    ${list.length > 1 ? `<div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">단지 비교 — 관심 평형</h2><span class="spacer"></span>
        <div class="seg" id="cmpMode"><button data-m="ppy" class="on">${J ? '평당 전세가' : '평당가'}</button><button data-m="idx">상승률 (3년 전 = 100)</button></div></div>
      <p class="muted" style="margin:0 0 8px;font-size:12px">${J ? '전세 ' : ''}6개월 이동평균 · 평형이 달라도 비교할 수 있게 평당가로 맞췄어요${list.length > CMP_MAX ? ` · 처음 ${CMP_MAX}개 단지만 보여요` : ''}</p>
      <div id="cmpLegend"></div>
      <div class="chart-box"><canvas id="cmp"></canvas></div>
    </div>` : ''}${card}`;
  renderSync();
  app.querySelector('.watch-grid').addEventListener('click', (e) => {
    const c = e.target.closest('[data-href]');
    if (!c) return;
    if (c.dataset.fresh) metrics.track('watch_change_open', { b: buildId(), t: +c.dataset.fresh });
    const w = list[+c.dataset.i];
    watch.markChecked(w.code, w.key, no);
    location.hash = c.dataset.href;
  });
  document.getElementById('checkAll')?.addEventListener('click', () => { watch.markChecked(null, null, no); route(); });
  const cmp = [];
  const changed = []; // 새로 확인된 거래가 있는 단지의 거래 수 (측정: 개수만 보낸다)
  await Promise.all(list.map(async (w, i) => {
    const el = document.getElementById(`w${i}`);
    const since = w.checked ?? no;
    // 관심 평형을 저장했으면 변화(새 거래·신고가·급등·삭제)는 그 평형만 센다
    const inArea = (t) => !w.area || A.areaKey(t.area) === w.area;
    // 사라진 거래(해제·정정)와 급등은 최근 30일 변화 목록에서 찾는다. 남은 거래가 없는 단지도 삭제 내역은 보여 준다
    const mine = (recent?.items || []).filter((x) => x.code === w.code && x.key === w.key && x.b > since && inArea(x));
    const gone = mine.filter((x) => x.type === 'del').sort((a, b) => b.date.localeCompare(a.date));
    const surge = mine.filter((x) => x.type === 'surge');
    const goneLines = [
      ...gone.slice(0, 2).map((x) => `<li class="muted"><s>${tradeLine(x)}</s> 삭제</li>`),
      gone.length > 2 ? `<li class="muted">삭제 외 ${gone.length - 2}건</li>` : '',
    ];
    const checkedLine = no && buildDate(since) ? `마지막 확인 ${md(buildDate(since))}` : '';
    let d;
    try {
      d = await getApt(w.code, w.key, 36, J);
    } catch (e) {
      if (isStale(id)) return;
      if (!gone.length || J) { el.querySelector(':scope > .muted').textContent = `오류: ${e.message}`; return; }
      document.getElementById('checkAll')?.removeAttribute('hidden');
      el.innerHTML = `
        <div class="row"><b>${esc(w.name)}</b><span class="tag">삭제 ${gone.length}건</span><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
        <div class="muted" style="margin-top:8px">${esc(e.message)}</div>
        <ul class="changes">${goneLines.join('')}</ul>
        ${checkedLine ? `<div class="muted" style="font-size:12px;margin-top:6px">${checkedLine}</div>` : ''}`;
      return;
    }
    try {
      if (isStale(id)) return;
      if (J) { jeonseCard(w, i, el, d); return; }
      // 관심 평형이 최근 3년 매매에 없으면(전세만 있거나 이번 달에만 있거나 오래전 거래만 있음) 주력 평형으로 요약한다
      const picked = w.area && d.areas.find((a) => a.area === w.area && !a.partialOnly && a.count > 0);
      const main = picked || d.areas[0];
      const tr = d.trades.filter((t) => !t.bulk && A.areaKey(t.area) === main.area);
      const recentPrice = median(tr.slice(-3).map((t) => t.price));
      const market = d.trades.filter((t) => !t.bulk);
      // 이번 달(신고 진행 중) 거래는 시세·지표에는 넣지 않지만 새로 확인된 거래와 신고가 비교에는 넣는다
      const withCur = [...market, ...d.partial.filter((t) => !t.bulk)];
      // 새로 확인된 거래: 마지막으로 확인한 빌드 뒤에 처음 확인된 거래. 확인 기록이 없으면 지금 빌드부터 센다
      const isFresh = (t) => no && t.firstSeen > since;
      const fresh = withCur.filter((t) => isFresh(t) && inArea(t)).sort((a, b) => b.date.localeCompare(a.date));
      const otherFresh = withCur.filter((t) => isFresh(t) && !inArea(t)).length;
      // 신고가: 같은 평형에서 확인 시점까지 본 거래의 최고가를 넘은 새 거래. 이전 거래가 없는 평형은 세지 않는다.
      // 이 지역 매매 수집에 실패한 달이 있으면 이전 최고가가 빠졌을 수 있어 판정하지 않는다 (빌드의 tradeChanges와 같은 기준)
      const complete = !tradeMissing(w.code);
      const isHigh = (t) => {
        if (!complete) return false;
        const prior = withCur.filter((o) => !isFresh(o) && A.areaKey(o.area) === A.areaKey(t.area)).map((o) => o.price);
        return prior.length && t.price > Math.max(...prior);
      };
      const high = fresh.filter(isHigh);
      const badges = `${fresh.length ? `<span class="tag new">새로 확인 ${fresh.length}건</span>` : ''}${high.length ? `<span class="tag high">신고가 ${high.length}건</span>` : ''}${surge.length ? `<span class="tag high">급등</span>` : ''}${gone.length ? `<span class="tag">삭제 ${gone.length}건</span>` : ''}`;
      if (fresh.length) { el.dataset.fresh = fresh.length; changed.push(fresh.length); }
      if (fresh.length || otherFresh || gone.length) document.getElementById('checkAll')?.removeAttribute('hidden');
      const lines = [
        ...fresh.slice(0, 3).map((t) => `<li>${tradeLine(t)}${isHigh(t) ? ' <span class="tag high">신고가</span>' : ''}${t.kind === '직거래' ? ' <span class="tag">직거래</span>' : ''}${t.partial ? ` ${partialTag}` : ''}</li>`),
        fresh.length > 3 ? `<li class="muted">외 ${fresh.length - 3}건</li>` : '',
        ...surge.slice(0, 1).map((x) => `<li><span class="up">급등</span> ${x.area}㎡ · ${surgeBasis(x.basis)} <span class="muted">(${SURGE_NOTE})</span></li>`),
        ...goneLines,
        fresh.length && !complete ? '<li class="muted">일부 달의 매매를 받지 못해 신고가는 판정하지 않았어요</li>' : '',
        otherFresh ? `<li class="muted">다른 평형에서 새로 확인 ${otherFresh}건</li>` : '',
      ].filter(Boolean);
      // 최근 계약도 요약한 평형 기준 (그 평형 거래가 모두 일괄 거래면 단지 전체)
      const sameArea = withCur.filter((t) => A.areaKey(t.area) === main.area);
      const last = (sameArea.length ? sameArea : withCur).reduce((a, b) => (b.date > a.date ? b : a));
      if (i < CMP_MAX) cmp[i] = { name: w.name, series: main.series.map((r) => ({ ym: r.ym, v: r.ma == null ? null : r.ma / (Number(main.area) / PYEONG) })) };
      el.innerHTML = `
        <div class="row"><b>${esc(w.name)}</b>${badges}<span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
        <div class="row" style="margin-top:8px"><span class="num" style="font-size:20px;font-weight:600">${fmtEok(recentPrice)}</span><span class="muted">${main.area}㎡ ${picked ? '관심 평형' : '주력 평형'}</span><span class="spacer"></span>${sparkline(main.series.map((s) => s.ma), 100, 28)}</div>
        ${w.area && !picked ? `<div class="muted" style="font-size:12px">관심 평형 ${w.area}㎡은 최근 3년 매매가 없어 주력 평형으로 보여요</div>` : ''}
        <div class="row" style="font-size:12px;margin-top:6px">최고가 대비 ${delta(recentPrice / main.maxPrice - 1)} · 전세가율 ${fmtPct(main.indicators.jeonseRatio, 0)}</div>
        <div style="margin-top:6px">${phaseChip(main.indicators.phase)}</div>
        ${lines.length ? `<ul class="changes">${lines.join('')}</ul>` : ''}
        <div class="muted" style="font-size:12px;margin-top:6px">${sameArea.length ? `${main.area}㎡ ` : ''}최근 계약 ${fmtDate(last.date)}${last.partial ? ' (이번 달 · 신고 진행 중)' : ''}${checkedLine ? ` · ${checkedLine}` : ''}${no && !lines.length ? ' · 새로 확인된 거래 없음' : ''}</div>`;
    } catch (e) {
      if (!isStale(id)) el.querySelector(':scope > .muted').textContent = `오류: ${e.message}`;
    }
  }));
  // 전세 보기 카드: 관심 평형(그 평형에 최근 3년 전세가 없으면 전세가 가장 많은 평형)의 전세 시세.
  // 새로 확인된 거래·신고가·급등·삭제는 매매로만 판정하므로 보여 주지 않는다 (측정의 변화 유무도 보내지 않는다)
  function jeonseCard(w, i, el, d) {
    const jAll = d.rents.filter(A.isJeonse);
    const jn = (area) => jAll.filter((t) => A.areaKey(t.area) === area).length;
    const usable = d.areas.filter((a) => !a.partialOnly && jn(a.area));
    const picked = w.area && usable.find((a) => a.area === w.area);
    const main = picked || usable.sort((a, b) => jn(b.area) - jn(a.area))[0];
    if (!main) {
      el.innerHTML = `<div class="row"><b>${esc(w.name)}</b><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
        <div class="muted" style="margin-top:8px">최근 3년 전세 거래가 없어요</div>`;
      return;
    }
    const jr = jAll.filter((t) => A.areaKey(t.area) === main.area);
    const recentJ = median(jr.slice(-3).map((t) => t.deposit));
    const maxJ = Math.max(...jr.map((t) => t.deposit));
    const last = jr[jr.length - 1];
    if (i < CMP_MAX) cmp[i] = { name: w.name, series: main.series.map((r) => ({ ym: r.ym, v: r.jeonseMa == null ? null : r.jeonseMa / (Number(main.area) / PYEONG) })) };
    el.innerHTML = `
      <div class="row"><b>${esc(w.name)}</b><span class="spacer"></span><span class="muted">${esc(w.region)}</span></div>
      <div class="row" style="margin-top:8px"><span class="num" style="font-size:20px;font-weight:600">${fmtEok(recentJ)}</span><span class="muted">${main.area}㎡ ${picked ? '관심 평형' : '전세 주력 평형'} 전세</span><span class="spacer"></span>${sparkline(main.series.map((s) => s.jeonseMa), 100, 28)}</div>
      ${w.area && !picked ? `<div class="muted" style="font-size:12px">관심 평형 ${w.area}㎡은 최근 3년 전세가 없어 전세가 가장 많은 평형으로 보여요</div>` : ''}
      <div class="row" style="font-size:12px;margin-top:6px">최고 보증금 대비 ${delta(recentJ / maxJ - 1)} · 전세가율 ${fmtPct(main.indicators.jeonseRatio, 0)}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">${main.area}㎡ 최근 전세 계약 ${fmtDate(last.date)} · 최근 3년 ${jr.length}건</div>`;
  }
  if (isStale(id)) return;
  if (changed.length) metrics.track('watch_change_available', { b: buildId(), c: changed.length, t: changed.reduce((a, b) => a + b, 0) });
  if (list.length < 2) return;
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

initDeal();
route();
