const test = require('node:test');
const assert = require('node:assert');
const an = require('../lib/analyze');

const PYEONG = 3.305785;
// 84㎡ 기준 평당가 ppy(만원)로 n건 거래
const trades = (ym, ppy, n, apt = 'A') => Array.from({ length: n }, (_, i) => ({
  dong: '동', apt, date: `${ym.slice(0, 4)}-${ym.slice(4)}-${String(i % 28 + 1).padStart(2, '0')}`,
  area: 84, price: Math.round(ppy * 84 / PYEONG), floor: 5,
}));
const yms = Array.from({ length: 12 }, (_, i) => `2025${String(i + 1).padStart(2, '0')}`);

test('가격·거래량이 함께 오르면 회복기', () => {
  // 거래량 비교는 마지막 달(12월)을 뺀 최근 3개월(9~11월) vs 직전 3개월(6~8월)
  const rows = yms.flatMap((ym, i) => trades(ym, 5000 * (1 + 0.02 * i), i >= 8 ? 20 : 10));
  const { indicators: ind } = an.regionSummary(yms, rows, []);
  assert.strictEqual(ind.phase.id, 1);
  assert.ok(ind.chg3m > 0.015);
  assert.strictEqual(ind.volChg, 1);
  assert.strictEqual(ind.fromPeak, 0);
  assert.strictEqual(ind.low, null); // 현재가 고점이면 저점 없음
});

test('가격 하락 + 거래 증가는 불황기, 고점 이후 저점 계산', () => {
  const ppys = [5000, 5200, 5400, 5600, 5400, 5200, 5000, 4800, 4600, 4400, 4500, 4600];
  const rows = yms.flatMap((ym, i) => trades(ym, ppys[i], i >= 7 ? 20 : 10));
  const { indicators: ind } = an.regionSummary(yms, rows, []);
  assert.strictEqual(ind.phase.id, 5);
  assert.strictEqual(ind.peakYm, '202505');
  assert.ok(ind.fromPeak < 0);
  assert.ok(ind.lowYm > ind.peakYm);
});

test('보합: 변화가 기준(±1.5%, ±15%) 안이면 0', () => {
  const rows = yms.flatMap((ym) => trades(ym, 5000, 10));
  assert.strictEqual(an.regionSummary(yms, rows, []).indicators.phase.id, 0);
});

test('전세가율은 최근 6개월 평당 전세 중위 ÷ 매매 중위', () => {
  const rows = yms.flatMap((ym) => trades(ym, 5000, 5));
  const rents = rows.map((r) => ({ ...r, deposit: Math.round(r.price * 0.6), monthly: 0 }));
  const ind = an.regionSummary(yms, rows, rents).indicators;
  assert.ok(Math.abs(ind.jeonseRatio - 0.6) < 0.001);
});

test('apartmentList: 주력 평형 기준 최고가 대비', () => {
  const rows = [
    ...trades('202501', 5000, 3), ...trades('202506', 6000, 1), ...trades('202512', 5400, 3),
    { dong: '동', apt: 'A', date: '2025-03-01', area: 59, price: 999999, floor: 1 }, // 다른 평형은 무시
  ];
  const [a] = an.apartmentList(rows);
  assert.strictEqual(a.mainArea, 84);
  assert.strictEqual(a.peakPrice, Math.round(6000 * 84 / PYEONG));
  assert.ok(Math.abs(a.fromPeak - (5400 / 6000 - 1)) < 0.001);
});

test('지표는 신고 진행 중인 마지막 달을 빼고 계산', () => {
  // 마지막 달만 급등해도 지표에 반영되지 않는다
  const rows = yms.flatMap((ym, i) => trades(ym, i === 11 ? 9000 : 5000, 10));
  const ind = an.regionSummary(yms, rows, []).indicators;
  assert.strictEqual(ind.currentYm, '202511');
  assert.strictEqual(ind.chg3m, 0);
  assert.strictEqual(ind.fromPeak, 0);
});

test('단지 구성 보정: 가격은 그대로인데 비싼 단지 거래만 늘면 변화 0', () => {
  // A(평당 5000)·B(평당 10000) 가격 고정, 거래 비중이 A 위주 → B 위주로 바뀜
  const rows = yms.flatMap((ym, i) => [...trades(ym, 5000, 12 - i, 'A'), ...trades(ym, 10000, i + 1, 'B')]);
  const { series, indicators: ind } = an.regionSummary(yms, rows, []);
  assert.ok(series[10].median > series[0].median * 1.5); // 원래 월 중위값은 크게 오름
  assert.ok(Math.abs(series[10].ma / series[2].ma - 1) < 0.001); // 보정 이동평균은 그대로
  assert.ok(Math.abs(ind.chg3m) < 0.001);
});

test('단지 구성 보정: 모든 단지가 10% 오르면 비중과 관계없이 10%', () => {
  const ym2 = ['202501', '202502', '202503', '202504', '202505', '202506', '202507', '202508'];
  const rows = ym2.flatMap((ym, i) => {
    const up = i >= 4 ? 1.1 : 1;
    return [...trades(ym, 5000 * up, i >= 4 ? 2 : 10, 'A'), ...trades(ym, 10000 * up, i >= 4 ? 10 : 2, 'B')];
  });
  const s = an.regionSummary(ym2, rows, []).series;
  // 3개월 이동평균이 모두 상승 후 구간에 들어간 6월(idx 6) vs 상승 전 3월(idx 2)
  assert.ok(Math.abs(s[6].ma / s[2].ma - 1.1) < 0.002);
});

test('같은 단지·같은 날 직거래 10건 이상은 일괄 거래로 보고 시세·거래량에서 뺀다', () => {
  const rows = yms.flatMap((ym) => trades(ym, 5000, 10));
  // 7월에 다른 단지가 평당 2만으로 30건 일괄 직거래
  const bulk = Array.from({ length: 30 }, () => ({ dong: '동', apt: 'B', date: '2025-07-09', area: 18, price: 27000, floor: 20, kind: '직거래' }));
  const { series, indicators: ind } = an.regionSummary(yms, [...rows, ...bulk], []);
  assert.strictEqual(series[6].count, 10);
  assert.strictEqual(series[6].bulk, 30);
  assert.strictEqual(ind.chg3m, 0);
  const list = an.apartmentList([...rows, ...bulk]);
  assert.deepStrictEqual(list.map((a) => a.key), ['동|A']); // 일괄 거래만 있는 단지는 목록에서 빠짐
});

test('일괄 거래 기준 미만이거나 중개거래면 그대로 둔다', () => {
  const r = (n, kind) => Array.from({ length: n }, () => ({ dong: '동', apt: 'A', date: '2025-07-09', kind }));
  assert.ok(an.markBulk(r(9, '직거래')).every((x) => !x.bulk));
  assert.ok(an.markBulk(r(30, '중개거래')).every((x) => !x.bulk));
  assert.ok(an.markBulk(r(10, '직거래')).every((x) => x.bulk));
});

test('일괄 거래 표시는 입력 행을 고치지 않는다 (브라우저 캐시를 여러 화면이 같이 씀)', () => {
  const rows = Array.from({ length: 30 }, () => ({ dong: '동', apt: 'B', date: '2025-07-09', area: 18, price: 27000, floor: 20, kind: '직거래' }));
  an.markBulk(rows);
  an.regionSummary(yms, rows, []);
  an.apartmentList(rows);
  assert.ok(rows.every((r) => !('bulk' in r)));
});

test('국면의 거래량은 장기(36개월 중위) 대비: 직전 3개월에 거래가 몰렸어도 평소 수준이면 거래↓로 보지 않는다', () => {
  // 40개월. 마지막 달(39)은 제외 → 최근 3개월 36~38은 평소(10건), 직전 3개월 33~35만 급증, 가격은 상승
  const ym40 = Array.from({ length: 40 }, (_, i) => `${2023 + Math.floor(i / 12)}${String(i % 12 + 1).padStart(2, '0')}`);
  const rows = ym40.flatMap((ym, i) => trades(ym, 5000 * (1 + 0.01 * i), i >= 33 && i <= 35 ? 40 : 10));
  const ind = an.regionSummary(ym40, rows, []).indicators;
  assert.ok(ind.volChg < -0.5); // 직전 3개월 대비로는 크게 감소
  assert.ok(Math.abs(ind.volVsAvg) < 0.15); // 장기 기준으로는 평소 수준
});

test('직거래 비율은 최근 3개 완성월 기준', () => {
  const rows = yms.flatMap((ym, i) => trades(ym, 5000, 10).map((r, j) => ({ ...r, kind: i >= 8 && j < 3 ? '직거래' : '중개거래' })));
  assert.strictEqual(an.regionSummary(yms, rows, []).indicators.directShare, 0.3);
});

test('거래 온도: 같은 단지·평형의 이전 거래 대비 신고가·상승·하락 비율', () => {
  // 24개월. 매달 같은 단지 10건씩, 가격은 매달 1%씩 오르다 마지막 4개월(20~23)은 매달 1%씩 내림
  const y24 = Array.from({ length: 24 }, (_, i) => `${2024 + Math.floor(i / 12)}${String(i % 12 + 1).padStart(2, '0')}`);
  const rows = y24.flatMap((ym, i) => trades(ym, 5000 * (i < 20 ? 1 + 0.01 * i : 1.19 - 0.01 * (i - 19)), 10));
  const { series, indicators: ind } = an.regionSummary(y24, rows, []);
  assert.strictEqual(series[5].newHigh, null); // 처음 12개월은 비교 대상이 적어 비움
  assert.strictEqual(series[15].newHigh, 0.1); // 오르는 달: 그 달 첫 거래만 신고가, 나머지 9건은 같은 값
  assert.strictEqual(series[15].upShare, 0.1);
  assert.strictEqual(ind.newHighShare, 0); // 최근 3개 완성월(20~22)은 하락 중
  assert.strictEqual(ind.downShare, 0.1);
});

test('국면 지도 궤적: 3·6개월 전 시점의 위치', () => {
  const rows = yms.flatMap((ym, i) => trades(ym, 5000 * (1 + 0.02 * i), 10));
  const { indicators: ind } = an.regionSummary(yms, rows, []);
  assert.deepStrictEqual(ind.trail.map((t) => t.ym), ['202505', '202508']); // 현재 202511 기준
  assert.ok(ind.trail.every((t) => t.chg3m > 0));
});

test('같은 단지·같은 날 전세 10건 이상(공공임대 일괄 계약 등)은 지역 전세 시세에서 뺀다', () => {
  const rows = yms.flatMap((ym) => trades(ym, 5000, 5));
  const rents = rows.map((r) => ({ ...r, deposit: Math.round(r.price * 0.6), monthly: 0 }));
  const bulk = Array.from({ length: 40 }, () => ({ dong: '동', apt: 'R', date: '2025-08-11', area: 84, deposit: 100, monthly: 0, floor: 3 }));
  const ind = an.regionSummary(yms, rows, [...rents, ...bulk]).indicators;
  assert.ok(Math.abs(ind.jeonseRatio - 0.6) < 0.001);
});

test('searchEntries: 단지별 거래 수, 많은 순', () => {
  const rows = [...trades('202501', 5000, 2, 'A'), ...trades('202501', 5000, 5, 'B')];
  assert.deepStrictEqual(an.searchEntries(rows), [['동', 'B', 5, ''], ['동', 'A', 2, '']]);
});
