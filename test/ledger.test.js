const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../lib/ledger');
const ch = require('../lib/changes');

const t = (date, price, extra = {}) => ({ dong: '동', apt: 'A', date, area: 84.97, floor: 10, price, kind: '중개거래', ...extra });
const month = (ym, rows, ok = true) => ({ ym, ok, rows: rows.map((r) => ({ ...r })) });
// 빌드마다 같은 조회 결과를 새로 만든다 (observe가 행에 firstSeen을 붙이므로)
const run = (prev, months, no) => ledger.observe(prev, months.map((m) => month(m.ym, m.rows, m.ok)), no);

test('빌드 번호: run_number × 100 + run_attempt, 순서 보존', () => {
  assert.equal(ledger.buildNo({ runNumber: 12, runAttempt: 3 }), 1203);
  assert.ok(ledger.buildNo({ runNumber: 12, runAttempt: 1 }) > ledger.buildNo({ runNumber: 11, runAttempt: 50 }));
  assert.equal(ledger.buildNo(null), 0);
  assert.throws(() => ledger.buildNo({ runNumber: 1, runAttempt: 100 }));
});

test('이력 시작: 지금 있는 거래는 새 거래가 아니다', () => {
  const r = run(null, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }], 101);
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.ledger.months['202608'][ledger.tradeKey(t('2026-08-03', 100000))], [0]);
  assert.equal(r.ledger.end, '202608');
});

test('늦은 신고·같은 계약일 복수 거래·중복 수집', () => {
  const base = [t('2026-08-03', 100000)];
  const l1 = run(null, [{ ym: '202608', rows: base }], 101).ledger;
  // 같은 결과를 다시 받아도 변화 없음
  assert.equal(run(l1, [{ ym: '202608', rows: base }], 201).added.length, 0);
  // 같은 날·같은 조건 거래가 하나 더 신고되고, 지난 계약일의 거래가 늦게 신고됨
  const r = run(l1, [{ ym: '202608', rows: [...base, t('2026-08-03', 100000), t('2026-08-01', 98000)] }], 201);
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.added.map((x) => x.firstSeen), [201, 201]);
  assert.deepEqual(r.ledger.months['202608'][ledger.tradeKey(base[0])], [0, 201]);
  assert.equal(r.removed.length, 0);
});

test('정정은 삭제 + 추가, 취소는 삭제 (늦게 확인한 쪽부터)', () => {
  const l1 = run(null, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }], 101).ledger;
  const l2 = run(l1, [{ ym: '202608', rows: [t('2026-08-03', 100000), t('2026-08-03', 100000)] }], 201).ledger;
  const fix = run(l2, [{ ym: '202608', rows: [t('2026-08-03', 100000), t('2026-08-03', 101000)] }], 301);
  assert.equal(fix.added.length, 1);
  assert.equal(fix.removed.length, 1);
  assert.equal(fix.removed[0].firstSeen, 201);
  assert.equal(fix.removed[0].price, 100000);
  assert.equal(fix.removed[0].apt, 'A');
  const cancel = run(fix.ledger, [{ ym: '202608', rows: [t('2026-08-03', 101000)] }], 401);
  assert.deepEqual(cancel.removed.map((x) => [x.price, x.firstSeen]), [[100000, 0]]);
});

test('수집 실패한 달은 삭제로 보지 않고 이전 이력 유지, 복구되면 그 사이 신고분만 새 거래', () => {
  const l1 = run(null, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }, { ym: '202609', rows: [t('2026-09-03', 100000)] }], 101).ledger;
  const fail = run(l1, [{ ym: '202608', rows: [], ok: false }, { ym: '202609', rows: [t('2026-09-03', 100000)] }], 201);
  assert.equal(fail.removed.length, 0);
  assert.deepEqual(fail.ledger.months['202608'], l1.months['202608']);
  const back = run(fail.ledger, [{ ym: '202608', rows: [t('2026-08-03', 100000), t('2026-08-20', 99000)] }, { ym: '202609', rows: [t('2026-09-03', 100000)] }], 301);
  assert.deepEqual(back.added.map((x) => x.date), ['2026-08-20']);
});

test('실제 거래 0건으로 바뀐 달은 삭제로 본다', () => {
  const l1 = run(null, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }], 101).ledger;
  const r = run(l1, [{ ym: '202608', rows: [] }], 201);
  assert.equal(r.removed.length, 1);
  assert.deepEqual(r.ledger.months['202608'], {});
});

test('조회 기간 이동: 빠진 달은 삭제가 아니고, 새로 들어온 달의 거래는 새로 확인된 거래', () => {
  const l1 = run(null, [{ ym: '202607', rows: [t('2026-07-03', 100000)] }, { ym: '202608', rows: [t('2026-08-03', 100000)] }], 101).ledger;
  const r = run(l1, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }, { ym: '202609', rows: [t('2026-09-02', 100000)] }], 201);
  assert.equal(r.removed.length, 0);
  assert.deepEqual(r.added.map((x) => x.date), ['2026-09-02']);
  assert.deepEqual(r.opened, ['202609']);
  assert.equal(r.ledger.months['202607'], undefined);
  assert.equal(r.ledger.end, '202609');
});

test('이력 시작 때 수집에 실패한 달은 나중에 받아도 새 거래로 표시하지 않는다', () => {
  const l1 = run(null, [{ ym: '202607', rows: [], ok: false }, { ym: '202608', rows: [t('2026-08-03', 100000)] }], 101).ledger;
  const r = run(l1, [{ ym: '202607', rows: [t('2026-07-03', 100000)] }, { ym: '202608', rows: [t('2026-08-03', 100000)] }], 201);
  assert.equal(r.added.length, 0);
  // 새로 들어온 달이 첫 빌드에서 실패하면 pending에 두고, 다음 성공 때 새로 들어온 달로 본다
  const f = run(r.ledger, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }, { ym: '202609', rows: [], ok: false }], 301);
  assert.deepEqual(f.ledger.pending, ['202609']);
  assert.equal(run(f.ledger, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }, { ym: '202609', rows: [t('2026-09-01', 1)] }], 401).added.length, 1);
});

test('이력 시작 빌드에서 지역 수집이 모두 실패해도 다음 빌드에 조회 기간 전체가 새 거래로 뜨지 않는다', () => {
  const l1 = run(null, [{ ym: '202608', rows: [], ok: false }, { ym: '202609', rows: [], ok: false }], 101).ledger;
  assert.equal(l1.end, '202609');
  const r = run(l1, [{ ym: '202608', rows: [t('2026-08-03', 100000)] }, { ym: '202609', rows: [t('2026-09-03', 100000)] }], 201);
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.opened, []);
});

test('이력 키는 원본 단지명: 대표 단지 별칭이 바뀌어도 삭제·추가로 기록하지 않는다', () => {
  const before = t('2026-08-03', 100000, { apt: '한진(609-1)' });
  const l1 = run(null, [{ ym: '202608', rows: [before] }], 101).ledger;
  const after = { ...before, apt: '한신한진', sourceApt: '한진(609-1)' };
  const r = run(l1, [{ ym: '202608', rows: [after] }], 201);
  assert.equal(r.added.length + r.removed.length, 0);
});

test('이력 파일: 없으면 null, 깨져 있으면 멈춘다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  try {
    assert.equal(ledger.read('11110', dir), null);
    ledger.write('11110', { v: 1, last: null, months: {} }, dir);
    assert.equal(ledger.read('11110', dir).v, 1);
    fs.writeFileSync(path.join(dir, '11110.json'), '{"v":0}');
    assert.throws(() => ledger.read('11110', dir), /형식/);
    fs.writeFileSync(path.join(dir, '11110.json'), '{');
    assert.throws(() => ledger.read('11110', dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 변화 ----------
const TODAY = '2026-10-18';
// 직전 6개월에 10억 안팎 거래 n건
const history = (n = 4, price = 100000) => Array.from({ length: n }, (_, i) => ({ ...t(`2026-0${4 + i}-10`, price + i * 100), firstSeen: 0 }));
const changes = (trades, added, extra = {}) => ch.tradeChanges({ code: '11110', trades, added, removed: [], no: 301, today: TODAY, complete: true, ...extra });

test('신고가: 이전에 확인된 같은 평형 최고가를 넘은 새 거래', () => {
  const old = history();
  const fresh = { ...t('2026-10-01', 100500), firstSeen: 301 };
  const [item] = changes([...old, fresh], [fresh]);
  assert.equal(item.type, 'new');
  assert.ok(item.flags.includes('high'));
  assert.equal(item.key, '동|A');
  // 다른 평형의 첫 거래는 비교 대상이 없어 신고가가 아니다
  const other = { ...t('2026-10-01', 200000, { area: 114.5 }), firstSeen: 301 };
  assert.equal(changes([...old, other], [other])[0].flags, undefined);
});

test('급등: 중위값 +10% 거래가 60일 안에 2건이면 급등, 1건이면 높은 가격 거래', () => {
  const old = history();
  const a = { ...t('2026-09-20', 111000), firstSeen: 201 };
  const b = { ...t('2026-10-05', 111500), firstSeen: 301 };
  const items = changes([...old, a, b], [b]);
  assert.ok(items[0].flags.includes('surge'));
  assert.equal(items[0].basis.count, 2);
  assert.equal(items[0].basis.n, 5); // 앞선 높은 거래도 직전 6개월 기준에 들어간다
  const event = items.find((x) => x.type === 'surge');
  assert.ok(event && event.basis.rise >= 0.1);
  // 1건뿐이고 직전 6개월 최고가(10억 8천)를 5% 넘지 않으면 높은 가격 거래
  const peak = { ...t('2026-08-10', 108000), firstSeen: 0 };
  const single = changes([...old, peak, b], [b]);
  assert.ok(single[0].flags.includes('highPrice'));
  assert.ok(!single.some((x) => x.type === 'surge'));
  // 1건이어도 최고가를 5% 넘으면 급등
  const big = { ...t('2026-10-05', 120000), firstSeen: 301 };
  assert.ok(changes([...old, big], [big])[0].flags.includes('surge'));
});

test('급등 판정 제외: 기준 거래 부족, 직거래·저층, 수집 실패, 60일보다 오래된 계약', () => {
  const big = (extra) => ({ ...t('2026-10-05', 130000, extra), firstSeen: 301 });
  const x = big();
  assert.equal(changes([...history(2), x], [x])[0].flags?.includes('surge') ?? false, false);
  for (const y of [big({ kind: '직거래' }), big({ floor: 2 })]) {
    assert.ok(!(changes([...history(), y], [y])[0].flags || []).some((f) => f === 'surge' || f === 'highPrice'));
  }
  // 직거래·저층 고가 거래는 기준값에도 들어가지 않는다
  const low = Array.from({ length: 3 }, (_, i) => ({ ...t(`2026-0${5 + i}-01`, 150000, { floor: 1 }), firstSeen: 0 }));
  assert.equal(changes([...history(), ...low, x], [x])[0].basis.n, 4);
  assert.equal(changes([...history(), x], [x], { complete: false })[0].flags, undefined);
  const late = { ...t('2026-07-30', 130000), firstSeen: 301 };
  assert.ok(!(changes([...history(), late], [late])[0].flags || []).includes('surge'));
  // 60일 안이면 늦게 신고된 거래도 판정한다
  const lateOk = { ...t('2026-08-25', 130000), firstSeen: 301 };
  assert.ok(changes([...history(), lateOk], [lateOk])[0].flags.includes('surge'));
});

test('같은 단지·평형 급등은 30일에 한 번만', () => {
  const x = { ...t('2026-10-05', 130000), firstSeen: 301 };
  const recent = [{ type: 'surge', code: '11110', key: '동|A', area: 84.97, d: '2026-10-01' }];
  assert.ok(!changes([...history(), x], [x], { recent }).some((i) => i.type === 'surge'));
  const old = [{ ...recent[0], d: '2026-09-10' }];
  assert.ok(changes([...history(), x], [x], { recent: old }).some((i) => i.type === 'surge'));
});

test('삭제된 거래와 변화 id는 같은 입력이면 같다', () => {
  const removed = [{ key: 'k', dong: '동', apt: 'A', date: '2026-08-03', area: 84.97, floor: 10, price: 1, firstSeen: 0 }];
  const a = ch.tradeChanges({ code: '11110', trades: [], added: [], removed, no: 301, today: TODAY, complete: true });
  const b = ch.tradeChanges({ code: '11110', trades: [], added: [], removed, no: 301, today: TODAY, complete: true });
  assert.equal(a[0].type, 'del');
  assert.equal(a[0].key, '동|A');
  assert.equal(a[0].id, b[0].id);
});

test('지역: 국면 변화, 급등은 조건이 새로 충족될 때만', () => {
  const ind = (id, chg3m = 0, currentYm = '202609') => ({ phase: { id }, chg3m, currentYm });
  const go = (prev, i, extra = {}) => ch.regionChanges({ code: '11110', prev, ind: i, weekly: null, complete: true, no: 301, today: TODAY, ...extra });
  assert.deepEqual(go(null, ind(1)).items, []);
  // 같은 기준월 안에서 국면이 바뀌면 값만 갱신하고 변화로 내지 않는다 (경계값 근처 깜빡임)
  const same = go({ phase: 2, phaseYm: '202609', surge: false }, ind(1));
  assert.deepEqual(same.items, []);
  assert.deepEqual(same.state, { phase: 1, phaseYm: '202609', surge: false });
  // 기준월이 바뀌면 지난 기준월의 마지막 국면과 비교
  const p = go({ phase: 2, phaseYm: '202608', surge: false }, ind(1, 0.035));
  assert.deepEqual(p.items.map((x) => x.type), ['phase', 'regionSurge']);
  assert.deepEqual(p.state, { phase: 1, phaseYm: '202609', surge: true });
  assert.deepEqual(go(p.state, ind(1, 0.04)).items, []); // 계속 충족 중
  // 수집 실패: 판정하지 않고 상태 유지
  assert.deepEqual(go({ phase: 2, phaseYm: '202608', surge: false }, ind(1, 0.05), { complete: false }), { items: [], state: { phase: 2, phaseYm: '202608', surge: false } });
  // 주간지수 2주 연속 +0.3%
  const weekly = { dates: ['a', 'b', 'c'], sale: [100, 100.31, 100.62] };
  assert.equal(go({ phase: 1, surge: false }, ind(1), { weekly }).items[0].type, 'regionSurge');
  // 30일 안에 같은 지역 급등이 있었으면 다시 충족돼도 보내지 않는다
  const recent = [{ type: 'regionSurge', code: '11110', d: '2026-10-01' }];
  assert.deepEqual(go({ phase: 1, surge: false }, ind(1), { weekly, recent }).items, []);
});

test('피드: 같은 날 여러 빌드는 모으고, 날짜가 바뀌면 새로 시작', () => {
  const a = ch.mergeFeed(null, { today: TODAY, no: 301, items: [{ id: 'x' }], regions: { 11110: { added: 2, removed: 0, opened: [] } } });
  const b = ch.mergeFeed(a, { today: TODAY, no: 302, items: [{ id: 'y' }], regions: { 11110: { added: 1, removed: 1, opened: [] } } });
  assert.deepEqual(b.builds, [301, 302]);
  assert.equal(b.items.length, 2);
  assert.equal(b.regions[11110].added, 3);
  const c = ch.mergeFeed(b, { today: '2026-10-19', no: 401, items: [], regions: {} });
  assert.deepEqual(c, { date: '2026-10-19', builds: [401], items: [], regions: {} });
});

test('피드: 지역마다 눈에 띄는 거래는 모두, 나머지는 최근 계약 30건만, 일괄 거래는 뺀다', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: 'new', code: '11110', date: `2026-09-${String(i % 28 + 1).padStart(2, '0')}`, price: i }));
  items.push({ id: 'h', type: 'new', code: '11110', date: '2026-01-01', price: 1, flags: ['high'] }, { id: 'b', type: 'new', code: '11110', date: '2026-09-30', price: 1, bulk: 1 }, { id: 'd', type: 'del', code: '11110' });
  const f = ch.mergeFeed(null, { today: TODAY, no: 301, items, regions: {} });
  assert.equal(f.items.filter((x) => x.type === 'new' && !x.flags).length, ch.FEED_PER_REGION);
  assert.ok(f.items.some((x) => x.id === 'h') && f.items.some((x) => x.id === 'd') && !f.items.some((x) => x.id === 'b'));
  assert.ok(!f.items.some((x) => 'drop' in x));
});

test('빌드 날짜 표는 최근 90일만', () => {
  assert.deepEqual(ch.pruneBuilds({ 101: '2026-07-01', 201: '2026-10-01' }, TODAY), { 201: '2026-10-01' });
});

test('최근 30일 목록: 삭제·급등·국면만, 30일 지나면 빠지고 같은 id는 한 번', () => {
  const r = ch.updateRecent([{ id: 'old', type: 'del', d: '2026-09-10' }, { id: 'a', type: 'del', d: '2026-10-01' }],
    [{ id: 'a', type: 'del', d: TODAY }, { id: 'n', type: 'new', d: TODAY }, { id: 'p', type: 'phase', d: TODAY }], TODAY);
  assert.deepEqual(r.map((x) => x.id), ['a', 'p']);
});
