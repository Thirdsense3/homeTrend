const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../infra/functions/metrics/metrics.mjs');
const DEV = '3f0c8a52-6c1e-4b7a-9d2e-0a1b2c3d4e5f';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-16T03:00:00Z'); // KST 2026-10-16 12:00
const iso = (ms) => new Date(ms).toISOString();

test('허용된 이벤트와 값만 받고 검색어·단지 이름은 버린다', async () => {
  const m = await load();
  const b = m.parseBatch(JSON.stringify({ d: DEV, fv: iso(NOW - 1000), m: 1, e: [
    { id: ID(1), type: 'search', p: { k: 'apt', q: '래미안' } },
    { id: ID(2), type: 'watch_add', p: { n: 3, name: '래미안' } },
    { id: ID(2), type: 'watch_add', p: { n: 3 } }, // 같은 ID는 한 번만
    { id: ID(3), type: 'watch_change_available', p: { b: '812.2', c: 1, t: 'x' } },
  ] }), NOW);
  assert.equal(b.device, DEV);
  assert.equal(b.mobile, true);
  assert.deepEqual(b.events.map((e) => [e.type, e.props]), [
    ['search', { k: 'apt' }], ['watch_add', { n: 3 }], ['watch_change_available', { b: '812.2', c: 1 }],
  ]);
});

test('형식이 틀린 요청은 거부한다', async () => {
  const m = await load();
  const bad = (o) => assert.throws(() => m.parseBatch(typeof o === 'string' ? o : JSON.stringify(o), NOW), m.BadRequest);
  bad('not json');
  bad({ d: 'abc', e: [{ id: ID(1), type: 'visit' }] });
  bad({ d: DEV, e: [] });
  bad({ d: DEV, e: [{ id: ID(1), type: 'unknown' }] });
  bad({ d: DEV, e: Array.from({ length: m.MAX_EVENTS + 1 }, (_, i) => ({ id: ID(i), type: 'visit' })) });
  bad('x'.repeat(m.MAX_BODY + 1));
});

test('첫 방문 시각: 미래·형식 오류는 지금, 측정 도입 전 사용자 값은 유지', async () => {
  const m = await load();
  assert.equal(m.firstVisit(iso(NOW + 60000), NOW), iso(NOW));
  assert.equal(m.firstVisit('어제', NOW), iso(NOW));
  assert.equal(m.firstVisit('1999-01-01T00:00:00Z', NOW), iso(NOW));
  assert.equal(m.firstVisit(m.LEGACY_FIRST_VISIT, NOW), m.LEGACY_FIRST_VISIT);
});

test('날짜는 한국 시간, 재방문 경과일은 34일까지만', async () => {
  const m = await load();
  assert.equal(m.kstDate(Date.parse('2026-10-15T15:30:00Z')), '2026-10-16');
  assert.equal(m.coreDay(iso(NOW - 8 * m.DAY - 1), NOW), 8);
  assert.equal(m.coreDay(iso(NOW - 35 * m.DAY), NOW), null);
  assert.equal(m.coreDay(undefined, NOW), null);
});

const summary = (n, s) => ({ pk: `dev#${ID(n)}`, sk: 's', ...s });

test('활성화: 24시간 관찰이 끝난 신규 기기만 분모, 측정 이전 사용자와 차단 기기 제외', async () => {
  const m = await load();
  const rows = m.aggregate([
    summary(1, { firstSeen: iso(NOW - 3 * m.DAY), activatedAt: iso(NOW - 3 * m.DAY + 3600e3), mobile: true }),
    summary(2, { firstSeen: iso(NOW - 3 * m.DAY + 60e3) }),
    summary(3, { firstSeen: iso(NOW - 3600e3) }), // 아직 24시간 안
    summary(4, { firstSeen: m.LEGACY_FIRST_VISIT }),
    summary(5, { firstSeen: iso(NOW - 3 * m.DAY), flagged: true }),
  ], NOW);
  const act = rows.filter((r) => r.pk === 'agg#activation');
  assert.equal(act.length, 1);
  assert.equal(act[0].sk, '2026-10-13');
  assert.deepEqual([act[0].devices, act[0].activated], [2, 1]);
  assert.deepEqual(act[0].mobile, { devices: 1, activated: 1 });
  assert.equal(act[0].v, m.VERSION);
});

test('핵심 재방문: 구간이 끝난 기기만 분모, 7~13일 안의 확인만 재방문', async () => {
  const m = await load();
  const at = iso(NOW - 20 * m.DAY);
  const rows = m.aggregate([
    summary(1, { firstSeen: at, activatedAt: at, coreDays: [0, 9], watchCount: 2, hadChange: true }),
    summary(2, { firstSeen: at, activatedAt: at, coreDays: [0, 3, 14] }), // 구간 밖
    summary(3, { firstSeen: iso(NOW - 10 * m.DAY), activatedAt: iso(NOW - 10 * m.DAY), coreDays: [8] }), // 아직 구간 중
  ], NOW);
  const r = rows.find((x) => x.pk === 'agg#retention' && x.sk === m.kstDate(Date.parse(at)));
  assert.equal(r.activated, 2);
  assert.deepEqual(r.all.w1, { eligible: 2, retained: 1 });
  assert.equal(r.all.w4, undefined);
  assert.deepEqual(r.watch2_3.w1, { eligible: 1, retained: 1 });
  assert.deepEqual(r.change.w1, { eligible: 1, retained: 1 });
  assert.deepEqual(r.nochange.w1, { eligible: 1, retained: 0 });
  const pending = rows.find((x) => x.pk === 'agg#retention' && x.sk === m.kstDate(NOW - 10 * m.DAY));
  assert.deepEqual([pending.activated, pending.all], [1, undefined]);
});

test('날짜별 표: 오늘은 빼고, 변화 확인은 새 거래가 있던 기기 중 상세를 연 기기', async () => {
  const m = await load();
  const day = (n, date, acts, extra = {}) => ({ pk: `dev#${ID(n)}`, sk: `d#${date}`, acts, n: acts.length, ...extra });
  const rows = m.aggregate([
    summary(9, { firstSeen: iso(NOW), flagged: true }),
    day(1, '2026-10-15', ['visit', 'view_watch', 'watch_change_available', 'watch_change_open'], { mobile: true }),
    day(2, '2026-10-15', ['visit', 'watch_change_available']),
    day(3, '2026-10-15', ['visit', 'search']),
    day(9, '2026-10-15', ['visit']),
    day(1, '2026-10-16', ['visit']),
  ], NOW);
  const d = rows.filter((r) => r.pk === 'agg#daily');
  assert.deepEqual(d.map((r) => r.sk), ['2026-10-15']);
  assert.equal(d[0].devices, 3);
  assert.equal(d[0].mobile, 1);
  assert.equal(d[0].acts.visit, 3);
  assert.deepEqual(d[0].change, { available: 2, opened: 1 });
});

test('재계산: 결과에서 사라진 기간 안의 집계 행만 지운다', async () => {
  const m = await load();
  const from = m.aggFrom(NOW);
  const rows = [{ pk: 'agg#daily', sk: '2026-10-15' }];
  const existing = [
    { pk: 'agg#daily', sk: '2026-10-15' },
    { pk: 'agg#daily', sk: '2026-10-14' }, // 유일한 기기가 차단돼 결과에서 빠짐
    { pk: 'agg#activation', sk: '2026-10-10' },
    { pk: 'agg#daily', sk: '2026-01-01' }, // 재계산 기간 밖은 그대로 보관
  ];
  assert.ok('2026-01-01' < from);
  assert.deepEqual(m.staleRows(existing, rows, NOW), [{ pk: 'agg#daily', sk: '2026-10-14' }, { pk: 'agg#activation', sk: '2026-10-10' }]);
  // 차단된 기기 1대뿐인 날짜는 결과에 없다
  assert.deepEqual(m.aggregate([{ pk: `dev#${ID(1)}`, sk: 's', firstSeen: iso(NOW - 3 * m.DAY), flagged: true }, { pk: `dev#${ID(1)}`, sk: 'd#2026-10-14', acts: ['visit'], n: 1 }], NOW), []);
});
