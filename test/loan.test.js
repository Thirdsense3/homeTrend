const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/loan');
const P = require('../lib/profile');

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('원리금균등: 3억·연 4%·30년 → 월 약 143.2만 원, 역산하면 원금이 돌아온다', () => {
  const pmt = L.monthlyPayment(30000, 4, 30);
  near(pmt, 143.2246, 0.001);
  near(L.principalFor(pmt, 4, 30), 30000, 0.0001);
  near(L.monthlyPayment(12000, 0, 10), 100);
  assert.equal(L.monthlyPayment(0, 4, 30), 0);
});

test('취득세: 6억 이하 1%, 6~9억 산식, 9억 초과 3%, 85㎡ 초과 농특세, 생애최초 200만 원 감면', () => {
  const a = L.acquisitionTax(50000);
  assert.equal(a.rate, 1); assert.equal(a.tax, 500); assert.equal(a.edu, 50); assert.equal(a.total, 550);
  assert.equal(L.acquisitionTax(75000).rate, 2);
  assert.equal(L.acquisitionTax(80000).rate, 2.33);
  assert.equal(L.acquisitionTax(100000).rate, 3);
  assert.equal(L.acquisitionTax(100000, { over85: true }).rural, 200);
  const f = L.acquisitionTax(50000, { firstTime: true });
  assert.equal(f.relief, 200); assert.equal(f.total, 350);
  assert.equal(L.acquisitionTax(130000, { firstTime: true }).relief, 0); // 12억 초과
  assert.equal(L.acquisitionTax(1000, { firstTime: true }).relief, 10); // 세금보다 많이 깎지 않는다
});

test('중개보수 상한 요율과 한도액', () => {
  assert.equal(L.brokerageFee(4000).fee, 24);
  assert.equal(L.brokerageFee(19000).fee, 80); // 0.5% = 95 → 한도 80
  assert.equal(L.brokerageFee(80000).fee, 320);
  assert.equal(L.brokerageFee(100000).fee, 500);
  assert.equal(L.brokerageFee(200000).fee, 1400);
});

test('규제지역·주담대 상한 구간', () => {
  assert.ok(L.isRegulated('11680'));
  assert.ok(L.isRegulated('41135'));
  assert.ok(!L.isRegulated('41281'));
  assert.equal(L.capFor(150000), 60000);
  assert.equal(L.capFor(150001), 40000);
  assert.equal(L.capFor(250001), 20000);
  assert.ok(L.isLandPermit('11680', '2026-12-31'));
  assert.ok(!L.isLandPermit('11680', '2027-01-01'));
});

const me = (extra = {}) => P.summary({ cash: 40000, income: 12000, homes: 0, firstTime: true, rateType: 'mixed', term: 40, ...extra });

test('evaluate: 생애최초는 규제지역에서도 LTV 70%, 만기는 30년으로 줄인다', () => {
  const r = L.evaluate(me(), { price: 80000, code: '11680', rate: 4 });
  assert.equal(r.ltvRate, 0.7);
  assert.equal(r.term, 30);
  near(r.stressAdd, 2.4);
  assert.equal(r.limits.cap, 60000);
  near(r.limits.dsr, L.principalFor((12000 * 0.4) / 12, 6.4, 30));
  assert.equal(r.binding, 'ltv'); // 8억 × 70% = 5.6억 < 6억 < DSR
  assert.equal(r.loan, 56000);
  near(r.need, 80000 - 56000 + r.costs);
  near(r.left, 40000 - r.need);
  near(r.interest + r.principal, r.pay);
});

test('evaluate: 생애최초가 아니면 규제지역 LTV 40%, 비규제 경기 70%', () => {
  assert.equal(L.evaluate(me({ firstTime: false }), { price: 80000, code: '11680', rate: 4 }).loan, 32000);
  assert.equal(L.evaluate(me({ firstTime: false }), { price: 80000, code: '41281', rate: 4 }).loan, 56000);
});

test('evaluate: DSR이 걸리는 경우와 기존 대출 상환액', () => {
  const low = L.evaluate(me({ income: 3000 }), { price: 80000, code: '11680', rate: 4 });
  assert.equal(low.binding, 'dsr');
  const withDebt = L.evaluate(me({ income: 3000, loans: [{ kind: 'credit', balance: 3000, monthly: 50 }] }), { price: 80000, code: '11680', rate: 4 });
  assert.ok(withDebt.loan < low.loan);
  near(withDebt.dsrRoom, 3000 * 0.4 - 600);
  // 주기형은 스트레스 금리를 덜 반영해 한도가 크다
  assert.ok(L.evaluate(me({ income: 3000, rateType: 'periodic' }), { price: 80000, code: '11680', rate: 4 }).loan > low.loan);
});

test('evaluate: 소득이 없으면 DSR을 빼고 알려 준다, 고가 주택은 구간 한도', () => {
  const r = L.evaluate(me({ income: null }), { price: 200000, code: '11680', rate: 4 });
  assert.equal(r.limits.dsr, null);
  assert.equal(r.incomeMissing, true);
  assert.equal(r.binding, 'cap');
  assert.equal(r.loan, 40000);
});

test('maxPrice: 필요 현금이 내 자금 이하인 최대 가격', () => {
  const s = me();
  const top = L.maxPrice(s, { code: '11680', rate: 4 });
  assert.ok(top > 0 && top % 100 === 0);
  assert.ok(L.evaluate(s, { price: top, code: '11680', rate: 4 }).need <= s.funds);
  assert.ok(L.evaluate(s, { price: top + 100, code: '11680', rate: 4 }).need > s.funds);
  assert.equal(L.maxPrice(P.summary({ homes: 0 }), { code: '11680', rate: 4 }), null);
});
