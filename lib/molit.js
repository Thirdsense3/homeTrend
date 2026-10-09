// 국토교통부 아파트 매매/전월세 실거래가 API (공공데이터포털) 클라이언트 + 디스크 캐시
const https = require('https');
const fs = require('fs');
const path = require('path');

const ENDPOINTS = {
  trade: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
};
const { kstNow } = require('./kst');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
// 실거래 신고기한이 30일이라 최근 2개월은 계속 바뀐다 → 12시간마다 갱신
const RECENT_TTL_MS = 12 * 60 * 60 * 1000;
// 계약 해제는 몇 달 뒤에 신고되기도 한다 → 1년 이내 매매는 1주일마다 다시 받는다
const RECHECK_MONTHS = 12;
const RECHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function apiKey() {
  const k = (process.env.MOLIT_API_KEY || '').trim();
  if (!k) return '';
  // 포털의 "Encoding" 키를 넣었으면 그대로, "Decoding" 키면 인코딩
  return /%[0-9A-F]{2}/i.test(k) ? k : encodeURIComponent(k);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('API 요청 시간 초과')));
    req.on('error', reject);
  });
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

function parseItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = decode(f[2]);
    items.push(o);
  }
  return items;
}

const num = (s) => Number(String(s || '').replace(/[,\s]/g, '')) || 0;
const pad = (n) => String(n).padStart(2, '0');

function normalizeTrade(o) {
  return {
    apt: o.aptNm,
    seq: o.aptSeq || '',
    dong: o.umdNm,
    jibun: o.jibun || '',
    area: num(o.excluUseAr),
    floor: num(o.floor),
    price: num(o.dealAmount), // 만원
    date: `${o.dealYear}-${pad(o.dealMonth)}-${pad(o.dealDay)}`,
    built: num(o.buildYear),
    kind: o.dealingGbn || '', // 중개거래 / 직거래
    canceled: (o.cdealType || '').trim() === 'O',
  };
}

function normalizeRent(o) {
  return {
    apt: o.aptNm,
    seq: o.aptSeq || '',
    dong: o.umdNm,
    area: num(o.excluUseAr),
    floor: num(o.floor),
    deposit: num(o.deposit), // 만원
    monthly: num(o.monthlyRent),
    date: `${o.dealYear}-${pad(o.dealMonth)}-${pad(o.dealDay)}`,
    built: num(o.buildYear),
  };
}

// 공공데이터포털은 초당 요청 수를 제한한다 → 모든 호출을 한 줄로 세워 간격을 둔다
const MIN_GAP_MS = Number(process.env.MOLIT_MIN_GAP_MS) || 250;
let queue = Promise.resolve();
let lastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function throttled(url) {
  const run = queue.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return get(url);
  });
  queue = run.catch(() => {});
  return run;
}

async function request(url, label) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await throttled(url);
    } catch (e) {
      // 시간 초과·연결 끊김 등 네트워크 오류는 3번까지 재시도
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`국토부 API 연결 실패 (${label}): ${e.message}`);
    }
    const { status, body } = res;
    const code = tag(body, 'resultCode') || tag(body, 'returnReasonCode');
    if (status === 200 && (!code || /^0+$/.test(code))) {
      if (/<totalCount>/.test(body)) return body;
      // 게이트웨이 오류 페이지 등 정상 응답이 아니면 0건으로 캐시되지 않게 재시도 후 실패 처리
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`국토부 API 응답 형식 오류 (${label}): ${body.slice(0, 200)}`);
    }
    // 23: 초당 요청 제한 → 잠시 후 재시도. 22: 일일 한도 초과는 재시도해도 소용없음
    if ((code === '23' || status === 429) && attempt < 8) {
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }
    const msg = tag(body, 'resultMsg') || tag(body, 'returnAuthMsg') || body.slice(0, 200);
    throw new Error(`국토부 API 오류 (${label}): [${code || status}] ${msg}`);
  }
}

async function fetchMonth(kind, lawd, ym) {
  const key = apiKey();
  const out = [];
  for (let page = 1; page < 50; page++) {
    const url = `${ENDPOINTS[kind]}?serviceKey=${key}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=1000`;
    const body = await request(url, `${kind} ${lawd} ${ym}`);
    const items = parseItems(body);
    out.push(...items);
    const total = num(tag(body, 'totalCount'));
    if (!items.length || out.length >= total) break;
  }
  return kind === 'trade'
    ? out.map(normalizeTrade).filter((t) => !t.canceled && t.price > 0)
    : out.map(normalizeRent);
}

// 이번 달(KST)로부터 몇 개월 전인지
function monthsAgo(ym) {
  const now = kstNow();
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4));
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}

// 캐시 유효 기간. Infinity면 다시 받지 않음
function ttl(kind, ym) {
  const ago = monthsAgo(ym);
  if (ago <= 2) return RECENT_TTL_MS;
  if (kind === 'trade' && ago <= RECHECK_MONTHS) return RECHECK_TTL_MS;
  return Infinity;
}

const inflight = new Map();

async function getMonth(kind, lawd, ym) {
  const file = path.join(CACHE_DIR, kind, lawd, `${ym}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < ttl(kind, ym)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (_) { /* 캐시 없음 */ }

  const k = file;
  if (inflight.has(k)) return inflight.get(k);
  const p = fetchMonth(kind, lawd, ym)
    .then((rows) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rows));
      return rows;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

// 받아 둔 캐시만 읽는다 (없으면 빈 배열, API 호출 없음)
async function cachedMonth(kind, lawd, ym) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, kind, lawd, `${ym}.json`), 'utf8')); } catch (_) { return []; }
}

module.exports = { getMonth, cachedMonth, hasKey: () => !!apiKey(), ttl };
