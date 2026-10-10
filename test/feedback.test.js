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
  assert.equal(an.canonicalKey('11290', '돈암동|한진(609-1)', raw), '돈암동|한신한진');
});

test('동명 단지·다른 주소·임대동은 한신한진으로 합치지 않는다', () => {
  assert.equal(an.normalizeRows('11680', [row('한신', 84.87)])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { jibun: '123' })])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한진임대아파트(301동)(609-1)', 32.49)])[0].apt, '한진임대아파트(301동)(609-1)');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { dong: '길음동' })])[0].apt, '한신');
  assert.equal(an.normalizeRows('11290', [row('한신', 84.87, { jibun: undefined })])[0].apt, '한신');
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
  const { watch, state } = browserData(storage);
  state.complexes = { '11290': [row('한신', 84.87), row('한진(609-1)',59.58)] };
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
  const flat = api.searchFlat({regions:{'11290':[['돈암동','한신한진',100,'609-1']]}});
  assert.equal(api.searchMatch(flat,'한진')[0].apt,'한신한진');
});

test('이전 배포의 분리된 원본도 복원 과정에서 대표 단지와 정확한 면적을 유지한다', () => {
  const { unpack } = browserData();
  const p = pack(['202601'],[row('한신',68.13),row('한진(609-1)',59.58)],[]);
  delete p.names; p.v = 1; p.t = p.t.map((r) => r.slice(0,6));
  const raw = unpack(p,36,'11290');
  assert.equal(new Set(raw.trades.map(an.aptKey)).size,1);
  assert.equal(raw.trades[0].area,68.13);
});

test('모든 검증 카탈로그 항목은 구역 내 원본 별칭을 연결하고 다른 지번은 유지한다', () => {
  const aliases = require('../lib/complexes');
  assert.ok(aliases.length > 1);
  const seen = new Set();
  for (const a of aliases) {
    assert.ok(a.source.startsWith('https://'));
    for (const name of a.names) {
      const id = `${a.code}|${a.dong}|${name}`;
      assert.ok(!seen.has(id), `중복 별칭: ${id}`); seen.add(id);
      const original = { ...row(name,84.87),dong:a.dong,jibun:a.jibun };
      const [normalized] = an.normalizeRows(a.code,[original]);
      assert.equal(normalized.apt,a.name);
      assert.equal(normalized.sourceApt,name);
      assert.equal(an.canonicalKey(a.code,`${a.dong}|${name}`,[original]),`${a.dong}|${a.name}`);
      assert.equal(an.normalizeRows(a.code,[{...original,jibun:'다른 지번'}])[0].apt,name);
    }
  }
});

test('대표 단지로 압축해도 v2 거래별 원본 명칭을 복원한다', () => {
  const { unpack } = browserData();
  const raw = [row('성산시영(선경)',50.03,{dong:'성산동',jibun:'446'}),row('성산시영(대우)',50.03,{dong:'성산동',jibun:'446'})];
  const normalized = an.normalizeRows('11440',raw);
  const p = pack(['202601'],normalized,normalized.map((r)=>({...r,monthly:0,deposit:50000})));
  assert.equal(p.apts.length,1);
  const restored = unpack(p,36,'11440');
  assert.deepEqual(Array.from(restored.trades, r=>r.sourceApt), raw.map(r=>r.apt));
  assert.deepEqual(Array.from(restored.rents, r=>r.sourceApt), raw.map(r=>r.apt));
  assert.ok(restored.trades.every(r=>r.apt==='성산시영'));
});

test('통합 전후 지역 보정 지수는 원본 구역별 가격 차이를 유지한다', () => {
  const yms = Array.from({length:24},(_,i)=>`${2024+Math.floor(i/12)}${String(i%12+1).padStart(2,'0')}`);
  const raw = yms.flatMap((ym,i)=>['성산시영(선경)','성산시영(대우)'].flatMap((apt,k)=>Array.from({length:k?i+1:24-i},()=>row(apt,50.03,{dong:'성산동',jibun:'446',date:`${ym.slice(0,4)}-${ym.slice(4)}-01`,price:k?100000:50000}))));
  const before = an.regionSummary(yms,raw,[]);
  const after = an.regionSummary(yms,an.normalizeRows('11440',raw),[]);
  assert.deepEqual(after.series.map(r=>r.ma),before.series.map(r=>r.ma));
});


test('별칭 링크와 검색은 다른 주소의 동명 단지를 보존하고 주소 없는 키는 임의로 바꾸지 않는다', () => {
  const other = row('한신',84.97,{jibun:'999'});
  const same = row('한신',84.98);
  assert.equal(an.canonicalKey('11290','돈암동|한신'), '돈암동|한신');
  assert.equal(an.canonicalKey('11290','돈암동|한신',[other]), '돈암동|한신');
  assert.equal(an.canonicalKey('11290','돈암동|한신',[same,other]), '돈암동|한신');
  assert.equal(an.canonicalKey('11290','돈암동|한진(609-1)',[same,other]), '돈암동|한신한진');
  assert.deepEqual(an.apartmentNames('11290','돈암동','한신','999'), ['한신']);
  const api = browserData();
  api.state.meta = {regions:[{code:'11290',name:'성북구',group:'서울'}]};
  const flat = api.searchFlat({regions:{'11290':[['돈암동','한신',10,'999'],['돈암동','한신',15,'609-1'],['돈암동','한진(609-1)',20,'609-1']]}});
  assert.equal(api.searchMatch(flat,'한진').filter(e=>e.apt).length,1);
  assert.equal(flat.find(e=>e.apt==='한신').cnt,10);
  assert.equal(flat.find(e=>e.apt==='한신한진').cnt,35);
});

test('주소를 포함한 분리 검색 항목은 대표 단지로 합쳐지고 지역명은 지역 결과만 표시한다', () => {
  const api = browserData();
  api.state.meta = {regions:[{code:'11290',name:'성북구',group:'서울'}]};
  const flat = api.searchFlat({regions:{'11290':[['돈암동','한신',10,'609-1'],['돈암동','한진(609-1)',20,'609-1']]}});
  assert.equal(flat.length,1);
  assert.equal(flat[0].apt,'한신한진');
  assert.equal(flat[0].cnt,30);
  assert.equal(api.searchMatch(flat,'한진').length,1);
  assert.equal(api.searchMatch(flat,'성북').length,1);
  assert.equal(api.searchMatch(flat,'성북')[0].apt,undefined);
});

test('다른 주소로 저장한 관심단지는 대표 단지와 섞이지 않는다', () => {
  const storage = { 'homeTrend.watch': JSON.stringify([
    {code:'11290',key:'돈암동|한신',name:'한신',jibun:'999'},
    {code:'11290',key:'돈암동|한신한진',name:'한신한진',jibun:'609-1'}
  ]) };
  const {watch,state} = browserData(storage);
  state.complexes = {'11290':[row('한신',84.97,{jibun:'999'}),row('한신',84.98)]};
  assert.equal(watch.list().length,2);
  watch.toggle({code:'11290',key:'돈암동|한신',jibun:'999'});
  assert.equal(watch.list().length,1);
  assert.equal(watch.list()[0].key,'돈암동|한신한진');
});

test('지역 보정 지수와 신고가·대표 평형은 소수점 신고 차이로 분리되지 않는다', () => {
  const yms = Array.from({length:15},(_,i)=>`${2025+Math.floor(i/12)}${String(i%12+1).padStart(2,'0')}`);
  const trades = yms.flatMap((ym,i)=>Array.from({length:12},(_,j)=>row('A',i%2?84.98:84.97,{date:`${ym.slice(0,4)}-${ym.slice(4)}-${String(j+1).padStart(2,'0')}`,price:50000+i*1000+j})));
  const rounded = trades.map(r=>({...r,area:85}));
  const actual = an.regionSummary(yms,trades,[]), expected = an.regionSummary(yms,rounded,[]);
  // 평당 가격 함수는 원본 면적을 쓰므로 보정 지수 비교도 입력 값을 동일하게 맞춘다.
  const constantPrice = trades.map(r=>({...r,price:r.price*r.area/85}));
  assert.deepEqual(an.regionSummary(yms,constantPrice,[]).series.map(r=>r.ma),expected.series.map(r=>r.ma));
  assert.deepEqual(actual.series.map(r=>r.newHigh),expected.series.map(r=>r.newHigh));
  assert.deepEqual(actual.indicators.newHighShare,expected.indicators.newHighShare);
  assert.equal(an.apartmentList(trades)[0].mainArea,85);
  assert.equal(an.apartmentDetail(yms,trades,[]).areas.length,2);
});


test('대표 단지로 묶어도 서로 다른 원본 구역의 거래를 합쳐 통매각으로 판정하지 않는다', () => {
  const raw = ['한신','한진(609-1)'].flatMap(apt=>Array.from({length:6},()=>row(apt,84.87,{kind:'직거래'})));
  assert.ok(an.markBulk(an.normalizeRows('11290',raw)).every(r=>!r.bulk));
});
