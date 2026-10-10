const test = require('node:test');
const assert = require('node:assert/strict');
const an = require('../lib/analyze');
const { pack } = require('../lib/pack');
const row = (apt, area, extra = {}) => ({ dong: '돈암동', apt, jibun: '609-1', area, price: 80000, floor: 5, date: '2026-01-05', ...extra });

test('한신·한진 거래는 한 단지와 6개 면적으로 연결되고 원본은 보존된다', () => {
  const raw = ['한신', '한진(609-1)'].flatMap((apt, i) => [i ? 59.58 : 68.13, 84.87, 113.67, 132.96, 152.25].map((area) => row(apt, area)));
  const rows = an.normalizeRows('11290', raw);
  assert.equal(new Set(rows.map(an.aptKey)).size, 1);
  assert.equal(rows[0].sourceApt, '한신');
  assert.equal(raw[0].apt, '한신');
  assert.equal(an.apartmentList(rows).length, 1);
  assert.deepEqual(an.apartmentDetail(['202601'], rows, []).areas.map((a) => Number(a.area)).sort((a,b) => a-b), [59.58, 68.13, 84.87, 113.67, 132.96, 152.25]);
  assert.equal(pack(['202601'], rows, []).apts.length, 1);
  assert.equal(an.canonicalKey('11290', '돈암동|한진(609-1)'), '돈암동|한신한진');
});

test('동명 단지·다른 주소·임대동은 한신한진으로 합치지 않는다', () => {
  assert.equal(an.normalizeRows('11680', [row('한신', 84.87)])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { jibun: '123' })])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한진임대아파트(301동)(609-1)', 32.49)])[0].apt, '한진임대아파트(301동)(609-1)');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { dong: '길음동' })])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { jibun: undefined })])[0].apt, '한신한진');
});

test('같은 정수로 반올림되는 전용면적도 별도로 표시하고 전세 전용 면적은 빈 매매 지표를 가진다', () => {
  const rents = [row('A', 114.97, { monthly: 0, deposit: 60000 }), row('A', 120, { monthly: 50, deposit: 5000 })];
  const detail = an.apartmentDetail(['202601', '202602'], [row('A', 84.87), row('A', 84.95)], rents);
  assert.deepEqual(detail.areas.map((a) => a.area), ['84.87', '84.95', '114.97']);
  const onlyRent = detail.areas.find((a) => a.area === '114.97');
  assert.equal(onlyRent.count, 0);
  assert.equal(onlyRent.maxPrice, null);
  assert.equal(onlyRent.indicators.current, null);
  assert.equal(onlyRent.series[0].jeonse, 60000);
});

test('상승 후보 점수는 충분한 표본에서만 나오며 강한 관측 신호에 더 높은 점수를 준다', () => {
  const series = Array.from({ length: 37 }, (_, i) => ({ ym: String(i), count: 20 }));
  const weak = { chg3m: -0.03, chg12m: -0.1, volVsAvg: -0.3, jeonseRatio: 0.35, volRecent: 20, currentYm: '202601' };
  const strong = { ...weak, chg3m: 0.06, chg12m: 0.15, volVsAvg: 0.6, jeonseRatio: 0.75 };
  assert.equal(an.candidateScore(weak, series).score, 0);
  assert.equal(an.candidateScore(strong, series).score, 100);
  assert.equal(an.candidateScore(strong, series.slice(0,36)), null);
  assert.equal(an.candidateScore({ ...strong, volRecent: 2 }, series), null);
  assert.equal(an.candidateScore({ ...strong, jeonseRatio: null }, series), null);
  assert.equal(an.candidateScore(strong, series.map((r, i) => ({ ...r, count: i < 10 ? 0 : 20 }))), null);
});

// 브라우저의 데이터 복원·저장 로직을 실제 app.js에서 실행한다.
function browserData(storage = {}) {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
  const ctx = { window: { Analyze: an }, document: { getElementById: () => ({}), addEventListener: () => {} },
    localStorage: { getItem: (k) => storage[k] || null, setItem: (k,v) => { storage[k] = v; } }, console };
  vm.runInNewContext(source.slice(0,source.indexOf('function sparkline')) + '\nglobalThis.result = { watch, unpack, state };', ctx);
  vm.runInNewContext(source.slice(source.indexOf('const norm ='), source.indexOf('function highlight')) + '\nObject.assign(result, { searchFlat, searchMatch });',ctx);
  return ctx.result;
}

test('기존 관심단지의 한신·한진 항목은 중복 없이 복원되고 이전 링크로도 해제할 수 있다', () => {
  const storage = { 'homeTrend.watch': JSON.stringify([
    {code:'11290',key:'돈암동|한신',name:'한신',seen:'2026-01-01'},
    {code:'11290',key:'돈암동|한진(609-1)',name:'한진',seen:'2026-02-01'}
  ]) };
  const { watch } = browserData(storage);
  assert.equal(watch.list().length,1);
  assert.equal(watch.list()[0].name,'한신한진');
  assert.equal(watch.list()[0].seen,'2026-02-01');
  assert.ok(watch.has('11290','돈암동|한신'));
  watch.toggle({code:'11290',key:'돈암동|한신',name:'한신'});
  assert.equal(watch.list().length,0);
});

test('단지 목록이 없어도 지역 검색은 즉시 되고 한진 별칭으로 대표 단지가 검색된다', () => {
  const api = browserData();
  api.state.meta = {regions:[{code:'11290',name:'성북구',group:'서울'}]};
  assert.equal(api.searchMatch([], '성북')[0].r.code,'11290');
  const flat = api.searchFlat({regions:{'11290':[['돈암동','한신한진',100]]}});
  assert.equal(api.searchMatch(flat,'한진')[0].apt,'한신한진');
});

test('이전 배포의 분리된 원본도 복원 과정에서 대표 단지와 정확한 면적을 유지한다', () => {
  const { unpack } = browserData();
  const p = pack(['202601'],[row('한신',68.13),row('한진(609-1)',59.58)],[]);
  const raw = unpack(p,36,'11290');
  assert.equal(new Set(raw.trades.map(an.aptKey)).size,1);
  assert.equal(raw.trades[0].area,68.13);
});
