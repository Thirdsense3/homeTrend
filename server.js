require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getRange, cachedRange, monthRange, mode } = require('./lib/data');
const an = require('./lib/analyze');
const { pack } = require('./lib/pack');
const { getMacro } = require('./lib/ecos');
const regions = require('./data/regions.json');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const clampMonths = (v, def) => Math.min(240, Math.max(13, Number(v) || def));
const regionOf = (code) => regions.find((r) => r.code === code);
let macroCache = null;
let searchCache = null;

const routes = [
  [/^\/api\/meta$/, async () => ({ mode: mode(), regions: regions.map(({ demoBase, ...r }) => r) })],

  // 예측은 전 지역의 학습·검증을 마친 빌드 산출물을 공유한다. 요청 중 API 수천 건을 호출하지 않는다.
  [/^\/api\/forecasts$/, async () => {
    const file = path.join(__dirname, 'dist', 'data', 'forecasts.json');
    if (!fs.existsSync(file)) throw notFound('예측 데이터가 없습니다. npm run build로 생성하세요');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.source !== mode() || (data.source === 'live' && data.asOf !== monthRange(2)[0])) throw notFound('현재 데이터에 맞는 예측 빌드가 필요합니다');
    return data;
  }],

  // 개요 테이블용
  [/^\/api\/overview\/(\d{5})$/, async ([code], q) => {
    if (!regionOf(code)) throw notFound();
    // 지표(고점·장기 평균 거래량)는 5년으로 계산하고, 시계열은 최근 25개월만 보낸다
    const months = clampMonths(q.get('months'), 60);
    const [{ yms, rows }, rent] = await Promise.all([getRange('trade', code, months), getRange('rent', code, months)]);
    const { series, indicators } = an.regionSummary(yms, rows, rent.rows);
    indicators.candidate = an.candidateScore(indicators, series);
    return { code, series: series.slice(-25).map(({ ym, ma, count }) => ({ ym, ma, count })), indicators };
  }],

  // 금리·주택가격 전망 심리 (한국은행 ECOS). 월별 지표라 12시간 동안 메모리에 둔다
  [/^\/api\/macro$/, async () => {
    if (macroCache && Date.now() - macroCache.at < 12 * 60 * 60 * 1000) return macroCache.data;
    const yms = monthRange(120);
    const data = await getMacro(yms[0], yms[yms.length - 1]);
    if (!data) throw notFound('ECOS_API_KEY가 없어 금리·심리 지표를 볼 수 없습니다');
    macroCache = { at: Date.now(), data };
    return data;
  }],

  // 전체 단지 검색 목록. 받아 둔 캐시만 읽으므로(API 호출 없음) 아직 안 본 지역은 빠질 수 있다. 1시간 메모리에 둔다
  [/^\/api\/search$/, async () => {
    if (searchCache && Date.now() - searchCache.at < 60 * 60 * 1000) return searchCache.data;
    const out = {};
    for (const r of regions) out[r.code] = an.searchEntries((await cachedRange('trade', r.code, 36)).rows);
    const data = { v: 1, partial: mode() === 'live', regions: out };
    searchCache = { at: Date.now(), data };
    return data;
  }],

  // 지역 원본 데이터(압축). 지역·단지 화면의 계산은 브라우저(analyze.js)에서 한다
  [/^\/api\/raw\/(\d{5})$/, async ([code], q) => {
    if (!regionOf(code)) throw notFound();
    const months = clampMonths(q.get('months'), 36);
    const [t, r] = await Promise.all([getRange('trade', code, months), getRange('rent', code, months)]);
    return pack(t.yms, t.rows, r.rows);
  }],
];

function notFound(msg = 'not found') {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

function serveStatic(res, pathname) {
  // 분석 모듈은 서버와 브라우저가 같은 파일을 쓴다
  const shared = ['/analyze.js', '/complexes.js'].includes(pathname);
  const file = shared
    ? path.join(__dirname, 'lib', path.basename(pathname))
    : path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if ((!shared && !file.startsWith(PUBLIC + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const [re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    try {
      const body = await handler(m.slice(1), url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    } catch (e) {
      console.error(e.message);
      res.writeHead(e.status || 502, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`homeTrend → http://localhost:${PORT}  (${mode() === 'live' ? '국토부 실거래가 API' : '데모 데이터 — .env에 MOLIT_API_KEY를 넣으면 실데이터'})`);
});
