// 한국부동산원 R-ONE Open API 클라이언트: 주간 아파트 매매·전세 가격지수, 매입자 거주지별 아파트 매매거래 (시·구별)
// JSON 응답은 한글이 깨져서 기본 XML로 받는다. 한 번에 최대 1,000건
const https = require('https');
const { pool } = require('./data');
const regions = require('../data/regions.json');

const BASE = 'https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do';
const TABLES = {
  sale: { id: 'T244183132827305', cycle: 'WK', item: '10001' }, // (주) 매매가격지수 (아파트)
  jeonse: { id: 'T247713133046872', cycle: 'WK', item: '10001' }, // (주) 전세가격지수 (아파트)
  buyers: { id: 'A_2024_00609', cycle: 'MM', item: '100001' }, // (월) 매입자거주지별 아파트매매거래현황, 동(호)수
};
// 매입자 거주지 분류 (A_2024_00609)
const BUYER_CLS = { '500001': 'total', '500002': 'local', '500003': 'sido', '500004': 'seoul', '500005': 'other' };
// 지역 코드 → [주간지수 분류 ID, 매입자 거주지 그룹 ID]. R-ONE 항목 목록(SttsApiTblItm)에서 이름으로 맞춘 값
const CODES = {
  11680: [50068, 910025], 11650: [50067, 910024], 11710: [50069, 910026], 11170: [50045, 910005],
  11200: [50047, 910006], 11440: [50058, 910016], 11110: [50043, 910003], 11140: [50044, 910004],
  11215: [50048, 910007], 11740: [50070, 910027], 11590: [50065, 910022], 11470: [50060, 910017],
  11560: [50064, 910021], 11410: [50057, 910015], 11230: [50049, 910008], 11500: [50061, 910018],
  11620: [50066, 910023], 11290: [50051, 910010], 11380: [50056, 910014], 11530: [50062, 910019],
  11545: [50063, 910020], 11260: [50050, 910009], 11350: [50054, 910013], 11305: [50052, 910011],
  11320: [50053, 910012],
  41135: [50080, 920096], 41131: [50078, 920094], 41133: [50079, 920095], 41290: [50071, 910098],
  41450: [50108, 910105], 41210: [50097, 910093], 41173: [50074, 920100], 41171: [50073, 920099],
  41465: [50091, 920126], 41463: [50090, 920125], 41117: [50087, 920092], 41115: [50086, 920091],
  41113: [50085, 920090], 41111: [50084, 920089], 41430: [50076, 910104], 41410: [50075, 910103],
  41310: [50106, 910099], 41360: [50107, 910100], 41285: [50116, 920113], 41287: [50117, 920114],
  41281: [50115, 920112], 41570: [50118, 910110], 41597: [50259, 920279], 41595: [50258, 920278],
  41593: [50257, 920277], 41591: [50256, 920276],
};
const GROUP_CODES = { 서울: 50008, 경기: 50016 };
const WEEKS = 156; // 화면에 보내는 주간 지수 기간 (3년)

const apiKey = () => (process.env.REB_API_KEY || '').trim();

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('요청 시간 초과')));
    req.on('error', reject);
  });
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// <row> 목록과 결과 코드. 오류 응답은 <head> 없이 <RESULT>가 바로 루트에 온다
function parseXml(xml) {
  const tag = (s, name) => { const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? unescape(m[1].trim()) : null; };
  const rows = [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].map(([, r]) => Object.fromEntries([...r.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)].map(([, k, v]) => [k, unescape(v.trim())])));
  return { code: tag(xml, 'CODE'), message: tag(xml, 'MESSAGE'), total: Number(tag(xml, 'list_total_count')) || 0, rows };
}

// 한 통계표·지역의 행 전체 (1,000건씩 나눠 받는다)
async function fetchRows(table, params) {
  const rows = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ KEY: apiKey(), STATBL_ID: table.id, DTACYCLE_CD: table.cycle, ITM_ID: table.item, pIndex: page, pSize: 1000, ...params });
    let d;
    for (let attempt = 0; ; attempt++) {
      try {
        d = parseXml(await getText(`${BASE}?${q}`));
        break;
      } catch (e) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
        throw e;
      }
    }
    if (d.code === 'INFO-200') return rows; // 해당 데이터 없음
    if (d.code !== 'INFO-000') throw new Error(`[${d.code}] ${d.message}`);
    rows.push(...d.rows);
    if (rows.length >= d.total || !d.rows.length) return rows;
  }
}

// 주간 지수: [[YYYY-MM-DD, 지수]] 날짜순
const weekly = (rows) => rows.map((r) => [r.WRTTIME_DESC, Number(r.DTA_VAL)]).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(v)).sort((a, b) => a[0].localeCompare(b[0]));

// 매매·전세 지수를 날짜로 맞춰 { dates, sale, jeonse } (빠진 주는 null)
function mergeWeekly(sale, jeonse) {
  const s = new Map(sale), j = new Map(jeonse);
  const dates = [...new Set([...s.keys(), ...j.keys()])].sort().slice(-WEEKS);
  const r2 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return { dates, sale: dates.map((d) => r2(s.get(d))), jeonse: dates.map((d) => r2(j.get(d))) };
}

// 매입자 거주지: { yms, total, local, sido, seoul, other } 월순
function buyerSeries(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = BUYER_CLS[r.CLS_ID], v = Number(r.DTA_VAL);
    if (!k || !/^\d{6}$/.test(r.WRTTIME_IDTFR_ID) || !isFinite(v)) continue;
    if (!by.has(r.WRTTIME_IDTFR_ID)) by.set(r.WRTTIME_IDTFR_ID, {});
    by.get(r.WRTTIME_IDTFR_ID)[k] = v;
  }
  const yms = [...by.keys()].sort().filter((ym) => by.get(ym).total != null && by.get(ym).local != null);
  const out = { yms };
  for (const k of Object.values(BUYER_CLS)) out[k] = yms.map((ym) => by.get(ym)[k] ?? null);
  return out;
}

const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
// 화면에 쓰는 요약. 지수 변화는 n주 전 대비, 외지인 비중은 최근 3개월 합 / 장기(36개월) 합
function summarize({ weekly: w, buyers: b }) {
  const out = {};
  if (w?.dates.length) {
    const last = w.dates.length - 1;
    const chg = (xs, n) => (xs[last] != null && xs[last - n] != null ? xs[last] / xs[last - n] - 1 : null);
    out.weekly = { date: w.dates[last], chg1w: chg(w.sale, 1), chg4w: chg(w.sale, 4), chg12w: chg(w.sale, 12), jeonseChg4w: chg(w.jeonse, 4) };
  }
  if (b?.yms.length >= 3) {
    const n = b.yms.length;
    const share = (key, from) => { const t = sum(b.total.slice(from)); return t ? sum(b[key].slice(from)) / t : null; };
    const outside = b.total.map((t, i) => (t == null || b.local[i] == null ? null : t - b.local[i]));
    const out3 = sum(outside.slice(n - 3)), tot3 = sum(b.total.slice(n - 3));
    // 장기 평균은 2년 이상 쌓였을 때만 (신설 구는 비교하지 않는다)
    const long = n >= 24 ? sum(outside.slice(-36)) / (sum(b.total.slice(-36)) || NaN) : null;
    out.buyers = {
      ym: b.yms[n - 1],
      count3m: tot3,
      outsideShare: tot3 ? out3 / tot3 : null,
      outsideLong: isFinite(long) ? long : null,
      seoulShare: share('seoul', n - 3),
    };
  }
  return out;
}

// { regions: { code: { weekly, buyers, ind } }, groups: { 서울: { weekly, ind } }, missing: [이름] } — 키가 없으면 null
async function getReb(months, now = new Date()) {
  if (!apiKey()) return null;
  const missing = [];
  const startWeek = `${now.getUTCFullYear() - Math.ceil(WEEKS / 52)}01`; // YYYYWW
  // 매입자 거주지는 장기 평균(36개월)을 낼 수 있게 빌드 기간이 짧아도 4년 이상 받는다
  const startYm = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(months, 48), 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.warn(`부동산원 ${label}: ${e.message}`); missing.push(label); return null; } };
  const weeklyOf = async (label, cls) => {
    const [s, j] = [await safe(`${label} 매매지수`, () => fetchRows(TABLES.sale, { CLS_ID: cls, START_WRTTIME: startWeek })),
      await safe(`${label} 전세지수`, () => fetchRows(TABLES.jeonse, { CLS_ID: cls, START_WRTTIME: startWeek }))];
    return s || j ? mergeWeekly(weekly(s || []), weekly(j || [])) : null;
  };

  const out = { regions: {}, groups: {}, missing };
  await pool(regions, 4, async (r) => {
    const [cls, grp] = CODES[r.code] || [];
    if (!cls) { missing.push(r.name); return; }
    const w = await weeklyOf(r.name, cls);
    const rows = await safe(`${r.name} 매입자 거주지`, () => fetchRows(TABLES.buyers, { GRP_ID: grp, START_WRTTIME: startYm }));
    const d = { weekly: w, buyers: rows ? buyerSeries(rows) : null };
    out.regions[r.code] = { ...d, ind: summarize(d) };
  });
  for (const [g, cls] of Object.entries(GROUP_CODES)) {
    const w = await weeklyOf(g, cls);
    out.groups[g] = { weekly: w, ind: summarize({ weekly: w }) };
  }
  return out;
}

module.exports = { getReb, parseXml, mergeWeekly, buyerSeries, summarize, weekly, CODES };
