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
