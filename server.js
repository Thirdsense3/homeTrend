require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getRange, mode } = require('./lib/data');
const an = require('./lib/analyze');
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
    const { yms, rows } = await getRange('trade', code, clampMonths(q.get('months'), 25));
    const { series, indicators } = an.regionSummary(yms, rows, []);
    return { code, series: series.map(({ ym, ma, count }) => ({ ym, ma, count })), indicators };
  }],

  [/^\/api\/region\/(\d{5})$/, async ([code], q) => {
    const region = regionOf(code);
    if (!region) throw notFound();
    const months = clampMonths(q.get('months'), 36);
    const [t, r] = await Promise.all([getRange('trade', code, months), getRange('rent', code, months)]);
    return {
      region: { code, name: region.name, group: region.group },
      ...an.regionSummary(t.yms, t.rows, r.rows),
      apartments: an.apartmentList(t.rows),
    };
  }],

  [/^\/api\/apt\/(\d{5})\/(.+)$/, async ([code, rawKey], q) => {
    const region = regionOf(code);
    if (!region) throw notFound();
    const key = decodeURIComponent(rawKey);
    const months = clampMonths(q.get('months'), 60);
    const [t, r] = await Promise.all([getRange('trade', code, months), getRange('rent', code, months)]);
    const trades = t.rows.filter((x) => an.aptKey(x) === key).sort((a, b) => a.date.localeCompare(b.date));
    if (!trades.length) throw notFound('해당 기간에 거래가 없는 단지입니다');
    const rents = r.rows.filter((x) => an.aptKey(x) === key).sort((a, b) => a.date.localeCompare(b.date));
    const last = trades[trades.length - 1];
    return {
      region: { code, name: region.name },
      apt: { key, name: last.apt, dong: last.dong, jibun: last.jibun, built: last.built },
      ...an.apartmentDetail(t.yms, trades, rents),
      trades: trades.map(({ date, area, floor, price, kind }) => ({ date, area, floor, price, kind })),
      rents: rents.map(({ date, area, floor, deposit, monthly }) => ({ date, area, floor, deposit, monthly })),
    };
  }],
];

function notFound(msg = 'not found') {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
