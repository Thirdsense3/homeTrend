// 단지 급등 기준값 점검 (로드맵 세부 사항 3-1): 과거 거래로 단지별 급등 판정이 얼마나 자주 나오는지 센다
// 받아 둔 캐시만 읽는다 (API 호출 없음). 운영 이력은 S3에 있으므로 먼저 받아 풀어 둔다:
//   aws s3 cp s3://<버킷>/history/cache.tar.gz - | tar -xz -C data
//   node scripts/surge-frequency.js [개월=60]
// 거래마다 계약일에 확인됐다고 보고 그날 기준으로 판정한다 (실제로는 신고까지 최대 30일 늦다).
// 목표: 관심단지 하나에 급등이 평균 분기 1회를 넘지 않게 (결과는 docs/roadmap.md 3-1에 기록)
require('../lib/env');
const { cachedRange, mode } = require('../lib/data');
const an = require('../lib/analyze');
const { SURGE, surgeTest, addDays } = require('../lib/changes');
const regions = require('../data/regions.json');

const MONTHS = Number(process.argv[2]) || 60;
const MIN_TRADES = 10; // 이보다 거래가 적은 단지는 관심단지로 보기 어려워 분모에서 뺀다
const GRID = [0.08, 0.10, 0.12, 0.15].map((rise) => ({ ...SURGE, rise }));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

(async () => {
  console.log(`급등 빈도 점검: ${mode() === 'live' ? '국토부 캐시' : '데모 데이터'}, ${MONTHS}개월, ${regions.length}개 지역`);
  const stats = GRID.map(() => ({ events: [], high: 0, trades: 0 }));
  for (const r of regions) {
    const { yms, rows } = await cachedRange('trade', r.code, MONTHS);
    if (!rows.length) continue;
    const quarters = Math.max(1, (yms.length - SURGE.baseMonths) / 3);
    const market = an.markBulk(rows).filter((x) => !x.bulk);
    const complexes = new Map();
    for (const x of market) {
      const k = an.aptKey(x);
      if (!complexes.has(k)) complexes.set(k, []);
      complexes.get(k).push(x);
    }
    for (const trades of complexes.values()) {
      if (trades.length < MIN_TRADES) continue;
      const groups = new Map();
      for (const x of trades) {
        const k = an.areaKey(x.area);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
      }
      GRID.forEach((p, gi) => {
        let events = 0;
        for (const group of groups.values()) {
          group.sort((a, b) => a.date.localeCompare(b.date));
          let last = '';
          for (const t of group) {
            const s = surgeTest(group, t, t.date, p);
            if (!s) continue;
            stats[gi].trades++;
            if (s.kind === 'highPrice') { stats[gi].high++; continue; }
            // 같은 단지·평형은 30일에 한 번
            if (last && t.date <= addDays(last, 30)) continue;
            last = t.date;
            events++;
          }
        }
        stats[gi].events.push(events / quarters);
      });
    }
    process.stdout.write('.');
  }
  console.log();
  console.log('상승 기준 | 단지 수 | 단지당 분기 평균 | 상위 10% | 분기 1회 초과 단지 | 높은 가격 거래(1건) 비중');
  GRID.forEach((p, i) => {
    const e = stats[i].events.slice().sort((a, b) => a - b);
    if (!e.length) return;
    const mean = e.reduce((a, b) => a + b, 0) / e.length;
    console.log(`+${(p.rise * 100).toFixed(0)}% | ${e.length.toLocaleString()} | ${mean.toFixed(2)}회 | ${e[Math.floor(e.length * 0.9)].toFixed(2)}회 | ${pct(e.filter((x) => x > 1).length / e.length)} | ${pct(stats[i].high / (stats[i].trades || 1))}`);
  });
})();
