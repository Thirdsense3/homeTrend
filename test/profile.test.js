const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/profile');

test('normalize: 모르는 필드는 버리고 숫자는 만원 정수로', () => {
  const p = P.normalize({ cash: '12,000', income: 6500.4, homes: '0', evil: '<script>', loans: [{ kind: 'credit', balance: '3000', monthly: 80, rate: '5.25' }] });
  assert.equal(p.cash, 12000);
  assert.equal(p.income, 6500);
  assert.equal(p.homes, 0);
  assert.equal('evil' in p, false);
  assert.deepEqual(p.loans, [{ kind: 'credit', balance: 3000, rate: 5.25, monthly: 80 }]);
  assert.equal(p.v, P.VERSION);
});

test('normalize: 잘못된 값은 입력 안 함(null)이나 기본값으로', () => {
  const p = P.normalize({ cash: -5, deposit: 'abc', homes: 99, term: 33, rateType: 'x', loans: [{ kind: 'zzz', balance: 100 }, {}, null], firstTime: 'true', live: undefined });
  assert.equal(p.cash, null);
  assert.equal(p.deposit, null);
  assert.equal(p.homes, 9);
  assert.equal(p.term, 30);
  assert.equal(p.rateType, 'mixed');
  assert.deepEqual(p.loans, [{ kind: 'other', balance: 100, rate: null, monthly: null }]);
  assert.equal(p.firstTime, false); // 문자열 'true'는 받지 않는다
  assert.equal(p.live, true);
  assert.deepEqual(P.normalize(null).loans, []);
  assert.equal(P.normalize({ loans: Array(20).fill({ balance: 1 }) }).loans.length, P.LOANS_MAX);
});

test('summary: 자금·소득·기존 상환 비율', () => {
  const s = P.summary({ cash: 30000, deposit: 25000, income: 6000, spouseIncome: 4000, joint: true, homes: 0, firstTime: true, loans: [{ kind: 'credit', balance: 2000, monthly: 50 }] });
  assert.equal(s.funds, 55000);
  assert.equal(s.income, 10000);
  assert.equal(s.debt, 2000);
  assert.equal(s.debtYear, 600);
  assert.equal(s.debtRatio, 0.06);
  assert.equal(s.supported, true);
  assert.equal(s.notes.length, 0);
});

test('summary: 합산하지 않은 배우자 소득은 빼고 알려 준다', () => {
  const s = P.summary({ income: 6000, spouseIncome: 4000, homes: 0 });
  assert.equal(s.income, 6000);
  assert.ok(s.notes.some((n) => n.level === 'info'));
});

test('summary: 비어 있거나 맞지 않는 입력의 확인할 점', () => {
  const empty = P.summary({});
  assert.equal(empty.empty, true);
  assert.equal(empty.funds, null);
  assert.equal(empty.income, null);
  assert.equal(empty.debtRatio, null);
  assert.equal(empty.supported, false);
  assert.ok(empty.notes.some((n) => /주택 수/.test(n.text)));

  const s = P.summary({ homes: 1, firstTime: true, income: 5000, loans: [{ balance: 1000 }] });
  assert.equal(s.supported, false);
  assert.deepEqual(s.notes.map((n) => n.level), ['warn', 'scope', 'need']);
});
