const test = require('node:test');
const assert = require('node:assert/strict');
const policies = require('../lib/policies');
const ch = require('../lib/changes');
const regions = require('../data/regions.json');
const data = require('../data/policies.json');

const item = (extra = {}) => ({
  id: 'x-1', announced: '2025-10-15', effective: '2025-10-16', ended: null, title: '제목', category: '대출',
  regions: ['all'], summary: '요약', source: 'https://www.korea.kr/x', ...extra,
});
const check = (items) => policies.validate({ updated: '2026-10-25', items }, regions);

test('저장소의 정책 자료가 형식을 지킨다', () => {
  assert.doesNotThrow(() => policies.validate(data, regions));
  assert.ok(data.items.length > 0);
});

test('형식 오류는 항목과 이유를 모아 알린다', () => {
  assert.throws(() => policies.validate({ items: [] }, regions), /updated/);
  assert.throws(() => check([item(), item()]), /id 중복/);
  assert.throws(() => check([item({ announced: '2025-02-30' })]), /announced/);
  assert.throws(() => check([item({ effective: '2025.10.16' })]), /effective/);
  assert.throws(() => check([item({ ended: '2025-01-01' })]), /ended가 시작일보다/);
  assert.throws(() => check([item({ category: '기타' })]), /category/);
  assert.throws(() => check([item({ regions: ['99999'] })]), /알 수 없는 지역: 99999/);
  assert.throws(() => check([item({ source: 'http://x' })]), /source/);
  assert.throws(() => check([item({ id: 'a', title: '' }), item({ id: 'b', summary: '' })]), (e) => /\(a\): title/.test(e.message) && /\(b\): summary/.test(e.message));
  assert.doesNotThrow(() => check([item({ regions: ['서울', '41290'], effective: null, ended: '2026-01-01' })]));
});

test('대상 지역: 전국·묶음·지역 코드', () => {
  const gangnam = regions.find((r) => r.code === '11680'), gwacheon = regions.find((r) => r.code === '41290');
  assert.ok(policies.appliesTo(item(), gangnam));
  assert.ok(policies.appliesTo(item({ regions: ['서울'] }), gangnam));
  assert.ok(!policies.appliesTo(item({ regions: ['서울'] }), gwacheon));
  assert.ok(policies.appliesTo(item({ regions: ['서울', '41290'] }), gwacheon));
});

test('새 정책: 이력 시작에는 내지 않고, 본 id는 지워져도 기억한다', () => {
  const a = item({ id: 'a' }), b = item({ id: 'b', title: '새 정책' });
  const first = ch.policyChanges(null, [a], 301, '2026-10-25');
  assert.deepEqual(first, { items: [], known: ['a'] });
  const second = ch.policyChanges(first.known, [a, b], 302, '2026-10-26');
  assert.equal(second.items.length, 1);
  assert.deepEqual(
    { type: second.items[0].type, policy: second.items[0].policy, b: second.items[0].b, title: second.items[0].title, regions: second.items[0].regions },
    { type: 'policy', policy: 'b', b: 302, title: '새 정책', regions: ['all'] },
  );
  // 같은 빌드를 다시 계산해도 id가 같다
  assert.equal(ch.policyChanges(first.known, [a, b], 302, '2026-10-26').items[0].id, second.items[0].id);
  // b를 지웠다가 다시 넣어도 새 정책이 아니다
  const removed = ch.policyChanges(second.known, [a], 303, '2026-10-27');
  assert.deepEqual(removed.known.sort(), ['a', 'b']);
  assert.equal(ch.policyChanges(removed.known, [a, b], 304, '2026-10-28').items.length, 0);
});

test('피드에 정책 항목이 그대로 남는다', () => {
  const { items } = ch.policyChanges([], [item({ id: 'p' })], 301, '2026-10-25');
  const feed = ch.mergeFeed(null, { today: '2026-10-25', no: 301, items, regions: {} });
  assert.equal(feed.items.filter((x) => x.type === 'policy').length, 1);
});
