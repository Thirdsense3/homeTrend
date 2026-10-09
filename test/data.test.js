const test = require('node:test');
const assert = require('node:assert');
const { monthRange } = require('../lib/data');
const { kstNow } = require('../lib/kst');
const { ttl } = require('../lib/molit');

test('monthRange: 지난달부터 거꾸로, 연도 넘김', () => {
  assert.deepStrictEqual(monthRange(3, kstNow(Date.UTC(2026, 1, 10))), ['202511', '202512', '202601']);
});

test('monthRange: UTC로는 전월 말이어도 KST 1일이면 새 달 기준', () => {
  // 2026-09-30 19:00 UTC = 2026-10-01 04:00 KST (Actions 일일 빌드 시각)
  assert.deepStrictEqual(monthRange(1, kstNow(Date.UTC(2026, 8, 30, 19))), ['202609']);
});

test('캐시 TTL: 최근 2개월 12시간, 1년 이내 매매 1주일, 그 외 영구', () => {
  const [ago2, ago5, ago20] = [2, 5, 20].map((n) => monthRange(n)[0]); // 이번 달에서 n개월 전
  assert.strictEqual(ttl('trade', ago2), 12 * 60 * 60 * 1000);
  assert.strictEqual(ttl('rent', ago2), 12 * 60 * 60 * 1000);
  assert.strictEqual(ttl('trade', ago5), 7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(ttl('rent', ago5), Infinity);
  assert.strictEqual(ttl('trade', ago20), Infinity);
});
