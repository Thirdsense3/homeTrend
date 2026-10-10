// 실거래 정적 빌드로 단기 모델을 학습·검증하고 선택적으로 예측 JSON을 쓴다.
// node scripts/evaluate-forecasts.js [데이터 폴더=dist/data] [출력 JSON 경로]
const fs = require('fs');
const path = require('path');
const an = require('../lib/analyze');
const forecast = require('../lib/forecast');
const root = process.argv[2] || path.join(__dirname, '..', 'dist', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'));
if (meta.source !== 'live') throw new Error('실데이터 빌드만 평가할 수 있습니다 (데모 데이터 제외)');
const date = (n) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const panels = meta.regions.filter((r) => !(meta.missing || []).some((m) => m.startsWith(`${r.code}/`))).map((r) => {
  const file = fs.existsSync(path.join(root, 'region', `${r.code}.json`)) ? path.join(root, 'region', `${r.code}.json`) : path.join(root, `${r.code}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = (i, d, a, floor, source) => ({ dong: p.apts[i][0], apt: p.apts[i][1], jibun: p.apts[i][3],
    sourceApt: p.names?.[source] || p.apts[i][1], date: date(d), area: a / 100, floor });
  const trades = an.normalizeRows(r.code, p.t.map(([i, d, a, f, price, direct, source]) => ({ ...row(i, d, a, f, source), price, kind: direct ? '직거래' : '중개거래' })));
  const rents = an.normalizeRows(r.code, p.j.map(([i, d, a, f, deposit, source]) => ({ ...row(i, d, a, f, source), deposit, monthly: 0 })));
  return forecast.preparePanel(r.code, p.yms, trades, rents);
});
const result = forecast.buildForecasts(panels, { source: meta.source, missing: meta.missing || [] });
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(result));
console.log(JSON.stringify({ status: result.status, asOf: result.asOf, validation: result.validation,
  availableRegions: Object.fromEntries(result.horizons.map((h) => [h, Object.values(result.regions).filter((r) => r[h]?.status === 'available').length])),
  limitations: result.limitations }, null, 2));
