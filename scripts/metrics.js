// 방문 측정 집계 보기 (매일 05:00 KST에 만든 agg#<표>, 규칙은 infra/functions/metrics/metrics.mjs)
// 사용: node scripts/metrics.js [일수=28] [--html [저장 경로]]   (AWS CLI 자격 증명 필요, 테이블 hometrend, 서울 리전)
//   --html  차트가 있는 대시보드(scripts/metrics.html)를 만들어 브라우저로 연다. 경로를 안 주면 임시 폴더에 저장
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const htmlAt = args.indexOf('--html');
const DAYS = Number(args.find((a) => /^\d+$/.test(a))) || 28; // 숫자만 있는 값은 저장 경로로 쓰지 않는다
const TABLE = process.env.TABLE || 'hometrend';
const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const NOW = Date.now();
const from = kstDate(NOW - DAYS * 86400e3);
// 매일 05:00 KST 집계가 반영한 마지막 날짜 (전날). 05시 전이면 그 전날
const through = kstDate(NOW - 5 * 3600e3 - 86400e3);
// 재방문은 관찰이 이 기간에 끝난 코호트를 본다. 4주 구간(28~34일)이 끝나려면 활성화 후 35일이 지나야 하므로 그만큼 앞에서부터 읽는다
const retFrom = kstDate(NOW - (DAYS + 35) * 86400e3);

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

function query(table, since = from) {
  const r = spawnSync('aws', ['dynamodb', 'query', '--region', 'ap-northeast-2', '--table-name', TABLE,
    '--key-condition-expression', 'pk = :p AND sk >= :f',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: `agg#${table}` }, ':f': { S: since } }),
    '--output', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${table} 읽기 실패: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout).Items.map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, plain(v)])));
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%`.padStart(4) : '   –');
const rate = (x) => (x ? `${pct(x.retained, x.eligible)} (${x.retained}/${x.eligible})` : '–');

// 집계 데이터를 넣은 대시보드 HTML. </script> 같은 문자열이 본문을 끊지 않게 '<'를 이스케이프한다
function renderHtml(data) {
  const tpl = fs.readFileSync(path.join(__dirname, 'metrics.html'), 'utf8');
  return tpl.replace('/*DATA*/null', () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

function main() {
  const daily = query('daily'), activation = query('activation'), retention = query('retention', retFrom);

  if (htmlAt >= 0) {
    const out = args[htmlAt + 1] && !args[htmlAt + 1].startsWith('-') && !/^\d+$/.test(args[htmlAt + 1])
      ? path.resolve(args[htmlAt + 1]) : path.join(os.tmpdir(), 'hometrend-metrics.html');
    fs.writeFileSync(out, renderHtml({ generatedAt: new Date(NOW).toISOString(), days: DAYS, from, through, daily, activation, retention }));
    console.log(`대시보드: ${out}`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawnSync(opener, [out], { stdio: 'ignore' });
    return;
  }

  console.log(`최근 ${DAYS}일 (${from}~, KST)\n`);

  console.log('날짜별: 방문 기기 · 모바일 · 관심단지 확인 · 검색 · 관심 추가 · 변화 확인(상세/있음)');
  for (const r of daily) {
    console.log(`  ${r.sk}  ${String(r.devices).padStart(5)}  ${pct(r.mobile, r.devices)}  ${String(r.acts.view_watch || 0).padStart(4)}  ${String(r.acts.search || 0).padStart(4)}  ${String(r.acts.watch_add || 0).padStart(4)}  ${r.change.opened}/${r.change.available}`);
  }

  console.log('\n활성화 (첫 방문 24시간 안에 관심단지 저장 + 요약 확인), 첫 방문 날짜별: 신규 기기 · 활성화 · 모바일 · 데스크톱');
  for (const r of activation) {
    console.log(`  ${r.sk}  ${String(r.devices).padStart(5)}  ${pct(r.activated, r.devices)}  ${pct(r.mobile.activated, r.mobile.devices)}  ${pct(r.desktop.activated, r.desktop.devices)}`);
  }

  console.log(`\n핵심 재방문 (활성화 후 7~13일 / 28~34일에 관심단지 변화 확인), 활성화 날짜별 (${retFrom}~: 4주 관찰이 끝난 코호트까지)`);
  const segs = ['mobile', 'desktop', 'watch1', 'watch2_3', 'watch4p', 'change', 'nochange'];
  for (const r of retention) {
    console.log(`  ${r.sk}  활성화 ${r.activated}  1주 ${rate(r.all?.w1)}  4주 ${rate(r.all?.w4)}`);
    const parts = segs.filter((s) => r[s]?.w1).map((s) => `${s} ${rate(r[s].w1)}`);
    if (parts.length) console.log(`              1주 세부: ${parts.join(' · ')}`);
  }
}

if (require.main === module) main();
module.exports = { renderHtml };
