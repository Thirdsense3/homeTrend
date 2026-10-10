// 정적 사이트 빌드 (GitHub Pages용): dist/ 에 페이지 + 지역별 데이터 JSON 생성
// 사용: npm run build  (BUILD_MONTHS=60 기본, MOLIT_API_KEY 없으면 데모 데이터)
require('../lib/env');
const fs = require('fs');
const path = require('path');
const { getMonth, monthRange, mode, pool } = require('../lib/data');
const an = require('../lib/analyze');
const { pack } = require('../lib/pack');
const forecast = require('../lib/forecast');
const { getMacro } = require('../lib/ecos');
const { getReb } = require('../lib/reb');
const regions = require('../data/regions.json');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MONTHS = Number(process.env.BUILD_MONTHS) || 60;
const OVERVIEW_MONTHS = 25;
// 이 비율 이상 실패하면 배포를 중단해 이전 사이트를 유지
const MAX_FAIL_RATIO = 0.05;

function write(rel, data) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return fs.statSync(file).size;
}

(async () => {
  const yms = monthRange(MONTHS);
  console.log(`빌드: ${mode() === 'live' ? '국토부 API' : '데모 데이터'}, ${yms[0]}~${yms[yms.length - 1]} (${MONTHS}개월), ${regions.length}개 지역`);
  fs.rmSync(DIST, { recursive: true, force: true });

  const failures = [];
  let total = 0, bytes = 0;
  // 한 달 실패로 지역 전체를 버리지 않도록 월 단위로 받는다 (API 호출은 molit.js에서 직렬화됨)
  const fetchAll = async (kind, code) => {
    const chunks = await pool(yms, 6, async (ym) => {
      total++;
      try {
        return await getMonth(kind, code, ym);
      } catch (e) {
        failures.push({ code, kind, ym, error: e.message });
        return [];
      }
    });
    return chunks.flat();
  };

  let done = 0;
  const search = {};
  const panels = [];
  await pool(regions, 2, async (r) => {
    const [trades, rents] = [await fetchAll('trade', r.code), await fetchAll('rent', r.code)];
    bytes += write(`data/region/${r.code}.json`, pack(yms, trades, rents));
    search[r.code] = an.searchEntries(trades);
    // 지표(고점·장기 평균 거래량)는 받은 기간 전체로 계산하고, 스파크라인·궤적용 시계열만 잘라 보낸다
    const { series, indicators } = an.regionSummary(yms, trades, rents);
    indicators.candidate = failures.some((f) => f.code === r.code) ? null : an.candidateScore(indicators, series);
    if (mode() === 'live' && !failures.some((f) => f.code === r.code)) panels.push(forecast.preparePanel(r.code, yms, trades, rents));
    write(`data/overview/${r.code}.json`, { code: r.code, series: series.slice(-OVERVIEW_MONTHS).map(({ ym, ma, count }) => ({ ym, ma, count })), indicators });
    console.log(`[${++done}/${regions.length}] ${r.name}: 매매 ${trades.length.toLocaleString()} · 전월세 ${rents.length.toLocaleString()}`);
  });

  // 전체 단지 검색 목록 (상단 검색창)
  write('data/search.json', { v: 1, regions: search });
  write('data/forecasts.json', forecast.buildForecasts(panels, { source: mode(), missing: failures.map(({ code, kind, ym }) => `${code}/${kind}/${ym}`) }));

  write('data/meta.json', {
    mode: 'static',
    source: mode(),
    builtAt: new Date().toISOString(),
    months: MONTHS,
    yms,
    regions: regions.map(({ demoBase, ...r }) => r),
    missing: failures.map(({ code, kind, ym }) => `${code}/${kind}/${ym}`),
  });

  // 금리·주택가격 전망 심리 (한국은행 ECOS). 키가 없거나 실패해도 실거래 배포는 그대로 진행
  try {
    const macro = await getMacro(yms[0], yms[yms.length - 1]);
    if (macro) {
      write('data/macro.json', { builtAt: new Date().toISOString(), ...macro });
      console.log(`한국은행 지표 ${macro.series.length}개${macro.missing.length ? ` (실패: ${macro.missing.join(', ')})` : ''}`);
    } else console.log('ECOS_API_KEY 없음 → 금리·심리 지표 생략');
  } catch (e) {
    console.warn(`한국은행 지표 실패 (생략): ${e.message}`);
  }

  // 주간 가격지수·매입자 거주지 (한국부동산원 R-ONE). 키가 없거나 실패해도 실거래 배포는 그대로 진행
  try {
    const reb = await getReb(MONTHS);
    if (reb) {
      write('data/reb.json', { builtAt: new Date().toISOString(), ...reb });
      console.log(`부동산원 지표 ${Object.keys(reb.regions).length}개 지역${reb.missing.length ? ` (실패: ${reb.missing.join(', ')})` : ''}`);
    } else console.log('REB_API_KEY 없음 → 부동산원 지표 생략');
  } catch (e) {
    console.warn(`부동산원 지표 실패 (생략): ${e.message}`);
  }

  // 페이지: public/ 복사 + 분석 모듈 + 정적 모드 표시
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    fs.copyFileSync(path.join(ROOT, 'public', f), path.join(DIST, f));
  }
  fs.copyFileSync(path.join(ROOT, 'lib', 'complexes.js'), path.join(DIST, 'complexes.js'));
  fs.copyFileSync(path.join(ROOT, 'lib', 'analyze.js'), path.join(DIST, 'analyze.js'));
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('<script src="analyze.js"></script>', '<script>window.HT_STATIC = true;</script>\n  <script src="analyze.js"></script>');
  write('index.html', html);
  write('.nojekyll', '');

  console.log(`데이터 ${(bytes / 1024 / 1024).toFixed(1)}MB, 실패 ${failures.length}/${total}건`);
  failures.slice(0, 20).forEach((f) => console.warn(`  [실패] ${f.code} ${f.kind} ${f.ym}: ${f.error}`));
  if (failures.length > total * MAX_FAIL_RATIO) {
    console.error(`실패가 ${(MAX_FAIL_RATIO * 100).toFixed(0)}%를 넘어 빌드를 중단합니다 (이전 배포 유지).`);
    process.exit(1);
  }
})();
