// 방문 측정 집계 보기 (매일 05:00 KST에 만든 agg#<표>, 규칙은 infra/functions/metrics/metrics.mjs)
// 사용: node scripts/metrics.js [일수=28]   (AWS CLI 자격 증명 필요, 테이블 hometrend, 서울 리전)
const { spawnSync } = require('child_process');

const DAYS = Number(process.argv[2]) || 28;
const TABLE = process.env.TABLE || 'hometrend';
const from = new Date(Date.now() + 9 * 3600e3 - DAYS * 86400e3).toISOString().slice(0, 10);

// DynamoDB JSON → 일반 값
const plain = (v) => {
  const [[t, x]] = Object.entries(v);
  if (t === 'M') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, plain(y)]));
  if (t === 'L') return x.map(plain);
  if (t === 'N') return Number(x);
  if (t === 'NS') return x.map(Number);
  if (t === 'NULL') return null;
  return x;
};

function query(table) {
  const r = spawnSync('aws', ['dynamodb', 'query', '--region', 'ap-northeast-2', '--table-name', TABLE,
    '--key-condition-expression', 'pk = :p AND sk >= :f',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: `agg#${table}` }, ':f': { S: from } }),
    '--output', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${table} 읽기 실패: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout).Items.map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, plain(v)])));
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%`.padStart(4) : '   –');
const rate = (x) => (x ? `${pct(x.retained, x.eligible)} (${x.retained}/${x.eligible})` : '–');

console.log(`최근 ${DAYS}일 (${from}~, KST)\n`);

console.log('날짜별: 방문 기기 · 모바일 · 관심단지 확인 · 검색 · 관심 추가 · 변화 확인(상세/있음)');
for (const r of query('daily')) {
  console.log(`  ${r.sk}  ${String(r.devices).padStart(5)}  ${pct(r.mobile, r.devices)}  ${String(r.acts.view_watch || 0).padStart(4)}  ${String(r.acts.search || 0).padStart(4)}  ${String(r.acts.watch_add || 0).padStart(4)}  ${r.change.opened}/${r.change.available}`);
}

console.log('\n활성화 (첫 방문 24시간 안에 관심단지 저장 + 요약 확인), 첫 방문 날짜별: 신규 기기 · 활성화 · 모바일 · 데스크톱');
for (const r of query('activation')) {
  console.log(`  ${r.sk}  ${String(r.devices).padStart(5)}  ${pct(r.activated, r.devices)}  ${pct(r.mobile.activated, r.mobile.devices)}  ${pct(r.desktop.activated, r.desktop.devices)}`);
}

console.log('\n핵심 재방문 (활성화 후 7~13일 / 28~34일에 관심단지 변화 확인), 활성화 날짜별');
const segs = ['mobile', 'desktop', 'watch1', 'watch2_3', 'watch4p', 'change', 'nochange'];
for (const r of query('retention')) {
  console.log(`  ${r.sk}  활성화 ${r.activated}  1주 ${rate(r.all?.w1)}  4주 ${rate(r.all?.w4)}`);
  const parts = segs.filter((s) => r[s]?.w1).map((s) => `${s} ${rate(r[s].w1)}`);
  if (parts.length) console.log(`              1주 세부: ${parts.join(' · ')}`);
}
