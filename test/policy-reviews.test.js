const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../lib/policy-reviews');
const policies = require('../lib/policies');
const regions = require('../data/regions.json');
const data = require('../data/policies.json');

const review = (extra = {}) => ({ id: 'land-permit', by: '2026-12-31', what: '토지거래허가구역 지정 기한 확인', done: null, ...extra });
const doc = (reviews) => ({
  updated: '2026-11-08',
  items: [{ id: 'p-1', announced: '2025-10-15', effective: null, ended: null, title: '정책', category: '토지거래허가', regions: ['all'], summary: '요약', source: 'https://www.korea.kr/x', reviews }],
});
// 이슈를 연 뒤 그 본문을 다음 실행의 seen으로 쓴다 (워크플로와 같은 흐름)
const seenOf = (issues) => pr.markersIn(issues.map((x) => x.body).join('\n'));

test('저장소의 확인 예정이 형식을 지킨다', () => {
  assert.doesNotThrow(() => policies.validate(data, regions));
  const pending = data.items.flatMap((p) => (p.reviews || []).map((r) => `${p.id}/${r.id}@${r.by}`));
  assert.ok(pending.includes('2025-10-market-stabilization/land-permit-2026@2026-12-31'));
});

test('reviews 형식 오류', () => {
  const check = (reviews) => policies.validate(doc(reviews), regions);
  assert.doesNotThrow(() => check([review()]));
  assert.throws(() => check('x'), /reviews는 배열/);
  assert.throws(() => check([review(), review()]), /reviews\[1\]: id 중복/);
  assert.throws(() => check([review({ by: '2026-02-30' })]), /by는/);
  assert.throws(() => check([review({ what: '' })]), /what 필요/);
  assert.throws(() => check([review({ done: '2026.12.01' })]), /done은/);
});

test('알림 시점: 예정일 45일 전부터 열고, 그 전에는 열지 않는다', () => {
  assert.equal(pr.dueReviews(doc([review()]), '2026-11-15').length, 0);
  const due = pr.dueReviews(doc([review()]), '2026-11-16');
  assert.equal(due.length, 1);
  assert.equal(due[0].marker, 'policy-review:p-1/land-permit@2026-12-31');
  assert.match(due[0].title, /^정책 확인: 정책 \(2026-12-31\)$/);
  assert.match(due[0].body, /<!-- policy-review:p-1\/land-permit@2026-12-31 -->/);
  assert.match(due[0].body, /ended`를 채우지 않아요/);
});

test('재실행: 이미 연 이슈(닫힌 것 포함)는 다시 열지 않는다', () => {
  const first = pr.dueReviews(doc([review()]), '2026-11-16');
  assert.deepEqual(pr.dueReviews(doc([review()]), '2026-11-23', seenOf(first)), []);
  assert.deepEqual(pr.dueReviews(doc([review()]), '2026-12-31', seenOf(first)), [], '예정일 당일도 기한 전');
});

test('확인일 변경: 예정일을 바꾸면 새 이슈를 연다', () => {
  const first = pr.dueReviews(doc([review()]), '2026-11-16');
  const moved = pr.dueReviews(doc([review({ by: '2027-01-15' })]), '2026-12-01', seenOf(first));
  assert.equal(moved.length, 1);
  assert.equal(moved[0].marker, 'policy-review:p-1/land-permit@2027-01-15');
});

test('확인 완료: done이 있으면 열지 않는다', () => {
  assert.deepEqual(pr.dueReviews(doc([review({ done: '2026-12-20' })]), '2026-12-25'), []);
  assert.deepEqual(pr.dueReviews(doc([review({ done: '2026-12-20' })]), '2027-02-01'), []);
});

test('기한 지남: done 없이 예정일이 지나면 한 번 더 연다', () => {
  const first = pr.dueReviews(doc([review()]), '2026-11-16');
  const over = pr.dueReviews(doc([review()]), '2027-01-01', seenOf(first));
  assert.equal(over.length, 1);
  assert.equal(over[0].marker, 'policy-review:p-1/land-permit@2026-12-31:overdue');
  assert.match(over[0].title, /^\[기한 지남\] /);
  assert.deepEqual(pr.dueReviews(doc([review()]), '2027-01-08', seenOf([...first, ...over])), []);
  // 처음부터 기한이 지난 상태로 넣으면 기한 지남 이슈 하나만
  assert.deepEqual(pr.dueReviews(doc([review()]), '2027-01-01').map((x) => x.marker), ['policy-review:p-1/land-permit@2026-12-31:overdue']);
});

test('조치마다 따로 알린다', () => {
  const due = pr.dueReviews(doc([review(), review({ id: 'regulated-area', by: '2026-12-20', what: '규제지역' })]), '2026-11-20');
  assert.deepEqual(due.map((x) => x.marker).sort(), ['policy-review:p-1/land-permit@2026-12-31', 'policy-review:p-1/regulated-area@2026-12-20']);
});
