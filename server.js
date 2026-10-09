require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getRange, mode } = require('./lib/data');
const an = require('./lib/analyze');
const { pack } = require('./lib/pack');
const regions = require('./data/regions.json');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const clampMonths = (v, def) => Math.min(240, Math.max(13, Number(v) || def));
const regionOf = (code) => regions.find((r) => r.code === code);

const routes = [
  [/^\/api\/meta$/, async () => ({ mode: mode(), regions: regions.map(({ demoBase, ...r }) => r) })],

  // 개요 테이블용: 매매만 조회 (호출 수 절약)
  [/^\/api\/overview\/(\d{5})$/, async ([code], q) => {
    if (!regionOf(code)) throw notFound();
    // 지표(고점·장기 평균 거래량)는 5년으로 계산하고, 시계열은 최근 25개월만 보낸다
    const { yms, rows } = await getRange('trade', code, clampMonths(q.get('months'), 60));
    const { series, indicators } = an.regionSummary(yms, rows, []);
    return { code, series: series.slice(-25).map(({ ym, ma, count }) => ({ ym, ma, count })), indicators };
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
  const file = pathname === '/analyze.js'
    ? path.join(__dirname, 'lib', 'analyze.js')
    : path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if ((pathname !== '/analyze.js' && !file.startsWith(PUBLIC + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
