const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/forecast');
const yms = Array.from({ length: 60 }, (_, i) => f.nextMonth('202110', i));

function panels(flat = false) {
  return Array.from({ length: 40 }, (_, r) => {
    const g = flat ? 0 : 0.009 + r / 20000;
    const code = String(10000 + r);
    return { code, yms, snapshots: yms.slice(23, -1).map((ym, k) => {
      const origin = k + 23;
      const levels = Array.from({ length: origin + 1 }, (_, i) => 10000 * Math.exp(g * i));
      return { code, ym, origin, features: [g * 3, g * 12, 0.3, 0.5], level: levels[origin], levels };
    }) };
  });
}

test('과거 특징·지수는 거래를 자른 뒤 계산하여 미래 가격 변경의 영향을 받지 않는다', () => {
  const months = yms.slice(0, 30);
  const trades = months.flatMap((ym, i) => Array.from({ length: 12 }, (_, day) => ({ dong: '동', apt: 'A', area: 84.97,
    date: `${ym.slice(0, 4)}-${ym.slice(4)}-${String(day + 1).padStart(2, '0')}`, price: 50000 + i * 100, kind: '중개거래' })));
  const rents = trades.map((r) => ({ ...r, deposit: r.price / 2, monthly: 0 }));
  const original = f.preparePanel('10000', months, trades, rents);
  const revised = f.preparePanel('10000', months, trades.map((r) => r.date >= '2023-10-01' ? { ...r, price: r.price * 100 } : r), rents);
  assert.ok(original.snapshots.length > 0);
  assert.deepEqual(revised.snapshots[0], original.snapshots[0]);
  assert.equal(original.snapshots.at(-1).ym, months.at(-2));
  assert.equal(f.preparePanel('10000', ['202501', '202503'], trades, rents).snapshots.length, 0);
});

test('모델 선택·첫 검증 예측에는 그 시점 이후 확정되는 학습 결과가 들어가지 않는다', () => {
  const samples = f.samplesFor(panels(), 3);
  const before = f.evaluate(samples, 3, yms.at(-2));
  const revised = samples.map((s) => s.resolved > before.report.testStart ? { ...s, target: s.target + 1 } : s);
  const after = f.evaluate(revised, 3, yms.at(-2));
  assert.ok(before.test.length > 0);
  assert.equal(after.method, before.method);
  assert.equal(after.test[0].predicted, before.test[0].predicted);
  const model = f.fit(samples.filter((s) => s.resolved <= before.report.testStart));
  assert.ok(model.trainedThrough <= before.report.testStart);
  assert.ok(before.report.calibrationEnd <= f.nextMonth(before.report.testStart, -3));
});

test('학습·검증을 통과한 기간·지역에만 예측과 유한한 오차 범위를 제공한다', () => {
  const p = panels();
  const result = f.buildForecasts(p, { source: 'live', missing: ['10000/trade/202501'] });
  assert.equal(result.regions['10000'][3].reason, 'missing_data');
  const prediction = result.regions['10001'][3];
  assert.equal(prediction.status, 'available');
  assert.ok(prediction.lower <= prediction.change && prediction.change <= prediction.upper);
  assert.ok([prediction.lower, prediction.change, prediction.upper, prediction.regionalMae].every(Number.isFinite));
  assert.equal(prediction.targetYm, f.nextMonth(result.asOf, 3));
  assert.equal(result.validation[3].status, 'passed');
});

test('데모·이력 부족·가격 유지보다 개선이 없는 모델은 수치를 노출하지 않는다', () => {
  const demo = f.buildForecasts(panels(), { source: 'demo' });
  assert.equal(demo.status, 'demo');
  assert.deepEqual(demo.regions, {});
  assert.equal(f.buildForecasts([], { source: 'live' }).status, 'insufficient_history');
  const flat = f.buildForecasts(panels(true), { source: 'live' });
  assert.equal(flat.status, 'withheld');
  assert.ok(Object.values(flat.regions).every((r) => Object.values(r).every((h) => h.status === 'withheld' && h.change === undefined)));
});


test('표시 범위는 최종 검증에 사용한 보정 폭이며 검증 구간으로 다시 산정하지 않는다', () => {
  const p = panels();
  const result = f.buildForecasts(p, { source: 'live' });
  const evaluation = f.evaluate(f.samplesFor(p, 3), 3, result.asOf);
  const prediction = Object.values(result.regions).find(r=>r[3]?.status==='available')[3];
  assert.equal(result.version,2);
  assert.equal(prediction.intervalSamples,evaluation.report.calibrationCount);
  assert.equal(prediction.intervalStart,evaluation.report.calibrationStart);
  assert.equal(prediction.intervalEnd,evaluation.report.calibrationEnd);
  assert.ok(prediction.intervalEnd < evaluation.report.testStart);
  assert.ok(Math.abs((Math.log1p(prediction.upper)-Math.log1p(prediction.lower))/2-evaluation.width)<1e-12);
  assert.equal(prediction.validation.intervalWidthLog,evaluation.width);
  assert.equal(prediction.regionalSamples,6);
});
