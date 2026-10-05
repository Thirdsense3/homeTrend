// 전체 지역 실거래 데이터를 미리 캐시에 받아두는 스크립트
// 사용: npm run prefetch -- [개월수=36] [서울|경기]
require('../lib/env');
const { getRange, mode, pool } = require('../lib/data');
const regions = require('../data/regions.json');

(async () => {
  if (mode() !== 'live') {
    console.error('MOLIT_API_KEY가 없습니다. .env를 먼저 설정하세요.');
    process.exit(1);
  }
  const months = Number(process.argv[2]) || 36;
  const group = process.argv[3];
  const targets = regions.filter((r) => !group || r.group === group);
  let done = 0;
  await pool(targets, 2, async (r) => {
    for (const kind of ['trade', 'rent']) {
      try {
        const { rows } = await getRange(kind, r.code, months);
        console.log(`[${++done}/${targets.length * 2}] ${r.name} ${kind}: ${rows.length}건`);
      } catch (e) {
        console.error(`[실패] ${r.name} ${kind}: ${e.message}`);
      }
    }
  });
})();
