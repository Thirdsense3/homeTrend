const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../infra/functions/sync/sync.mjs');
const NOW = Date.parse('2026-10-25T03:00:00Z');
const W = 'w:11680:대치동|은마';
const W2 = 'w:11650:반포동|래미안퍼스티지';
const R = 'r:11680';
const val = (area) => ({ name: '은마', jibun: '316', region: '강남구', ...(area && { area }) });

test('코드: 128비트 26자, 옮겨 적은 코드도 같은 코드로 읽는다', async () => {
  const m = await load();
  const max = m.newCode(Buffer.alloc(16, 0xff));
  assert.equal(max.length, 26);
  assert.equal(max[0], '7'); // 130비트 칸의 위 2비트는 늘 0
  assert.equal(m.newCode(Buffer.alloc(16)), '0'.repeat(26));
  const c = m.newCode();
  assert.equal(m.normalizeCode(c), c);
  const typed = c.toUpperCase().replace(/(.{5})/g, '$1-').replace(/0/g, 'O').replace(/1/g, 'l');
  assert.equal(m.normalizeCode(typed), c);
  assert.equal(m.normalizeCode('8' + c.slice(1)), null); // 128비트를 넘는 값
  assert.equal(m.normalizeCode(c.slice(1)), null);
  assert.equal(m.normalizeCode('u' + c.slice(1)), null);
  assert.notEqual(m.newCode(), m.newCode());
  assert.match(m.pkOf(c), /^sync#[0-9a-f]{64}$/);
  assert.ok(!m.pkOf(c).includes(c));
});

test('요청: 허용한 항목과 값만 받고 나머지는 버린다', async () => {
  const m = await load();
  const code = m.newCode();
  const r = m.parseRequest(JSON.stringify({ code, base: 3, changes: [
    { id: W, v: { ...val('84.97'), months: 60, checked: 812, memo: 'x' }, from: 2 },
    { id: R, v: { any: 1 }, from: 0 },
    { id: W2, v: null, from: 5 },
  ] }));
  assert.equal(r.code, code);
  assert.equal(r.base, 3);
  assert.deepEqual(r.changes, [
    { id: W, v: { ...val('84.97'), months: 60 }, from: 2 },
    { id: R, v: {}, from: 0 },
    { id: W2, v: null, from: 5 },
  ]);
  // 조회 기간·평형 형식이 틀리면 그 값만 뺀다
  assert.deepEqual(m.parseRequest(JSON.stringify({ code, changes: [{ id: W, v: { name: '은마', area: '84㎡', months: 24 }, from: 0 }] })).changes[0].v, { name: '은마' });
  assert.equal(m.parseRequest('{}', { needCode: false }).code, null);
});

test('요청: 형식이 틀리면 거부한다', async () => {
  const m = await load();
  const code = m.newCode();
  const bad = (o, opt) => assert.throws(() => m.parseRequest(typeof o === 'string' ? o : JSON.stringify(o), opt), m.BadRequest);
  bad('not json');
  bad({ code: 'abc' });
  bad({ changes: [] });
  bad({ code, base: -1 });
  bad({ code, changes: [{ id: 'x:1', v: {}, from: 0 }] });
  bad({ code, changes: [{ id: 'w:1168:a|b', v: val(), from: 0 }] });
  bad({ code, changes: [{ id: W, v: { area: '84.97' }, from: 0 }] }); // 이름 없음
  bad({ code, changes: [{ id: W, v: val(), from: 1.5 }] });
  bad({ code, changes: [{ id: W, v: val(), from: 0 }, { id: W, v: null, from: 0 }] });
  bad({ code, changes: Array.from({ length: m.MAX_CHANGES + 1 }, (_, i) => ({ id: `r:${10000 + i}`, v: {}, from: 0 })) });
  bad('x'.repeat(m.MAX_BODY + 1));
});

const seed = async () => {
  const m = await load();
  return m.apply(m.emptyDoc(), [{ id: W, v: val(), from: 0 }, { id: R, v: {}, from: 0 }], NOW).doc;
};

test('적용: 서로 다른 항목의 변경은 병합하고 리비전을 올린다', async () => {
  const m = await load();
  const d1 = await seed();
  assert.equal(d1.rev, 1);
  // 기기 A: 평형 저장 (W를 rev 1에서 봄), 기기 B: 다른 단지 추가 (A가 먼저 써서 서버는 rev 2)
  const a = m.apply(d1, [{ id: W, v: val('84.97'), from: 1 }], NOW);
  assert.deepEqual(a.conflicts, []);
  const b = m.apply(a.doc, [{ id: W2, v: { name: '래미안퍼스티지' }, from: 0 }, { id: R, v: null, from: 1 }], NOW);
  assert.deepEqual(b.conflicts, []);
  assert.equal(b.doc.rev, 3);
  assert.deepEqual(m.view(b.doc).items, {
    [W]: { r: 2, v: val('84.97') },
    [W2]: { r: 3, v: { name: '래미안퍼스티지' } },
    [R]: { r: 3, d: 1 },
  });
  assert.equal(d1.rev, 1); // 원본은 그대로
});

test('적용: 같은 항목을 다른 기기가 먼저 바꿨으면 충돌로 돌려주고 서버 값을 유지한다', async () => {
  const m = await load();
  const d1 = await seed();
  const a = m.apply(d1, [{ id: W, v: val('84.97'), from: 1 }], NOW).doc;
  // B는 아직 rev 1의 W를 보고 삭제
  const b = m.apply(a, [{ id: W, v: null, from: 1 }, { id: R, v: null, from: 1 }], NOW);
  assert.deepEqual(b.conflicts, [{ id: W, r: 2, v: val('84.97') }]);
  assert.deepEqual(m.view(b.doc).items[W], { r: 2, v: val('84.97') });
  assert.deepEqual(m.view(b.doc).items[R], { r: 3, d: 1 });
  // 사용자가 다시 적용: 지금 서버 리비전으로 보내면 적용된다
  const c = m.apply(b.doc, [{ id: W, v: null, from: 2 }], NOW);
  assert.deepEqual(c.conflicts, []);
  assert.deepEqual(m.view(c.doc).items[W], { r: 4, d: 1 });
});

test('적용: 결과가 같으면 충돌이 아니고, 서로 모르는 항목 추가는 삭제 표시가 있어도 받는다', async () => {
  const m = await load();
  const d1 = await seed();
  const same = m.apply(d1, [{ id: W, v: val(), from: 0 }, { id: 'r:11110', v: null, from: 0 }], NOW);
  assert.equal(same.changed, false);
  assert.deepEqual(same.conflicts, []);
  assert.equal(same.doc, d1);
  const del = m.apply(d1, [{ id: R, v: null, from: 1 }], NOW).doc;
  const add = m.apply(del, [{ id: R, v: {}, from: 0 }], NOW);
  assert.deepEqual(add.conflicts, []);
  assert.deepEqual(m.view(add.doc).items[R], { r: 3, v: {} });
  // 이미 있는 항목을 처음 보는 기기가 다른 값으로 추가하면 충돌
  const clash = m.apply(d1, [{ id: W, v: val('59.9'), from: 0 }], NOW);
  assert.deepEqual(clash.conflicts, [{ id: W, r: 1, v: val() }]);
});

test('삭제 표시: 90일 뒤 지우고, 그보다 오래된 리비전으로 보낸 변경은 적용하지 않는다', async () => {
  const m = await load();
  const d1 = await seed();
  const del = m.apply(d1, [{ id: R, v: null, from: 1 }], NOW).doc; // rev 2에 삭제
  const later = NOW + m.TOMBSTONE_DAYS * m.DAY;
  const p = m.apply(del, [{ id: W2, v: { name: '래미안퍼스티지' }, from: 0 }], later).doc;
  assert.equal(p.items[R], undefined);
  assert.equal(p.purged, 2);
  assert.equal(m.isStale(p, 1), true); // rev 1까지만 본 기기는 R이 삭제된 줄 모른다
  assert.equal(m.isStale(p, 2), false);
  assert.equal(m.isStale(d1, 0), false);
  // 89일째는 남아 있다
  assert.ok(m.apply(del, [{ id: W2, v: { name: 'x' }, from: 0 }], later - m.DAY).doc.items[R]);
});

test('항목 수 상한', async () => {
  const m = await load();
  const many = Array.from({ length: m.MAX_ITEMS }, (_, i) => ({ id: `r:${10000 + i}`, v: {}, from: 0 }));
  const d = m.apply(m.emptyDoc(), many, NOW).doc;
  assert.throws(() => m.apply(d, [{ id: W, v: val(), from: 0 }], NOW), m.BadRequest);
  // 삭제 표시는 세지 않는다
  const freed = m.apply(d, [{ id: 'r:10000', v: null, from: 1 }], NOW).doc;
  assert.equal(m.apply(freed, [{ id: W, v: val(), from: 0 }], NOW).conflicts.length, 0);
});

test('만료: 1년간 접근이 없으면 읽을 때도 없는 코드로 본다', async () => {
  const m = await load();
  assert.equal(m.ttl(NOW), Math.floor((NOW + 365 * m.DAY) / 1000));
  assert.ok(m.expired(undefined, NOW));
  assert.ok(m.expired({ expiresAt: m.ttl(NOW) }, NOW + 365 * m.DAY));
  assert.ok(!m.expired({ expiresAt: m.ttl(NOW) }, NOW + 364 * m.DAY));
});
