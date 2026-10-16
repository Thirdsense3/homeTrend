const test = require('node:test');
const assert = require('node:assert');
const h = require('../lib/history');

// S3 조건부 쓰기(If-Match / If-None-Match)를 흉내 내는 메모리 저장소
function memStore() {
  const objects = new Map();
  let n = 0;
  const log = [];
  const store = {
    objects, log,
    failNext: null, // { op, key } 한 번만 실패시키기
    async get(key) {
      const o = objects.get(key);
      return o ? { ...o } : null;
    },
    async put(key, body, { ifMatch, ifNoneMatch } = {}) {
      if (store.failNext && store.failNext.op === 'put' && store.failNext.key === key) {
        store.failNext = null;
        throw new Error('네트워크 오류');
      }
      const cur = objects.get(key);
      if ((ifNoneMatch === '*' && cur) || (ifMatch && (!cur || cur.etag !== ifMatch))) {
        const e = new Error('precondition');
        e.code = 'PreconditionFailed';
        throw e;
      }
      objects.set(key, { body, etag: `"${++n}"` });
      log.push(`put ${key}`);
    },
    async copy(src, dst) {
      if (!objects.has(src)) throw new Error(`없음: ${src}`);
      objects.set(dst, { ...objects.get(src), etag: `"${++n}"` });
      log.push(`copy ${src} ${dst}`);
    },
  };
  return store;
}

const seq = (runNumber, runAttempt = 1) => ({ runNumber, runAttempt });
const pointerSeq = (s) => JSON.parse(s.objects.get(h.POINTER).body).seq;
const withSnapshot = (s, q) => s.objects.set(h.snapshotKey(q), { body: 'tar', etag: '"s"' });

test('빌드 순번: run_number 먼저, 같으면 run_attempt로 비교', () => {
  assert.ok(h.compareSeq(seq(10, 1), seq(9, 3)) > 0);
  assert.ok(h.compareSeq(seq(10, 2), seq(10, 1)) > 0);
  assert.strictEqual(h.compareSeq(seq(10, 2), seq(10, 2)), 0);
  assert.throws(() => h.parseSeq(null));
  assert.throws(() => h.parseSeq({ runNumber: 3, runAttempt: 0 }));
});

test('복원: 포인터가 없으면 첫 이전, 있으면 빌드 스냅샷 → 장기 보관본 순서', async () => {
  const s = memStore();
  assert.deepStrictEqual(await h.restorePlan(s), { bootstrap: true, keys: [] });
  withSnapshot(s, seq(5));
  await h.confirm(s, seq(5), { builtAt: 't' });
  assert.deepStrictEqual((await h.restorePlan(s)).keys, ['builds/5-1/cache.tar.gz', h.HISTORY]);
});

test('확정: 포인터·장기 보관본·마커, 포인터 갱신 뒤 실패한 재시도는 마커만 다시', async () => {
  const s = memStore();
  withSnapshot(s, seq(7));
  s.failNext = { op: 'put', key: h.markerKey(seq(7)) };
  await assert.rejects(h.confirm(s, seq(7), { builtAt: 't' }), /네트워크/);
  assert.deepStrictEqual(pointerSeq(s), seq(7));
  assert.ok(!s.objects.has(h.markerKey(seq(7))));

  assert.strictEqual(await h.precheck(s, seq(7)), 'retry');
  const r = await h.confirm(s, seq(7), { builtAt: 't' });
  assert.strictEqual(r.updated, false);
  assert.ok(s.objects.has(h.markerKey(seq(7))));
  assert.ok(s.objects.has(h.HISTORY));
});

test('확정 마커는 재시도해도 같은 내용 (멱등)', async () => {
  const s = memStore();
  withSnapshot(s, seq(3));
  let i = 0;
  const now = () => `t${i++}`;
  await h.confirm(s, seq(3), { builtAt: 'b', now });
  const first = s.objects.get(h.markerKey(seq(3))).body;
  await h.confirm(s, seq(3), { builtAt: 'b', now });
  assert.strictEqual(s.objects.get(h.markerKey(seq(3))).body, first);
});

test('최신 확정 뒤 과거 실행 재실행: 배포 전 확인과 확정 모두 거부, 포인터 유지', async () => {
  const s = memStore();
  withSnapshot(s, seq(10, 2));
  await h.confirm(s, seq(10, 2), { builtAt: 't' });
  await assert.rejects(h.precheck(s, seq(10, 1)), h.StaleBuildError);
  await assert.rejects(h.precheck(s, seq(9, 3)), h.StaleBuildError);
  const before = s.log.length;
  await assert.rejects(h.confirm(s, seq(9, 3), { builtAt: 't' }), h.StaleBuildError);
  assert.strictEqual(s.log.length, before);
  assert.deepStrictEqual(pointerSeq(s), seq(10, 2));
  // 같은 실행을 전체 재실행하면 새 run_attempt라 더 큰 순번
  assert.strictEqual(await h.precheck(s, seq(10, 3)), 'newer');
});

test('확정: 그 사이 포인터가 더 큰 순번으로 바뀌면 확정하지 않음', async () => {
  const s = memStore();
  withSnapshot(s, seq(4));
  withSnapshot(s, seq(5));
  await h.confirm(s, seq(4), { builtAt: 't' });
  // 4를 읽은 직후 다른 실행이 5를 확정한 상황: 조건부 쓰기가 실패하고 다시 읽으면 더 최신
  const realPut = s.put;
  let raced = false;
  s.put = async (key, body, cond) => {
    if (key === h.POINTER && !raced) {
      raced = true;
      await h.confirm({ ...s, put: realPut }, seq(5), { builtAt: 't' });
    }
    return realPut(key, body, cond);
  };
  await assert.rejects(h.confirm(s, seq(4, 2), { builtAt: 't' }), h.StaleBuildError);
  assert.deepStrictEqual(pointerSeq(s), seq(5));
});

test('포인터 읽기 실패는 배포 전 확인을 통과시키지 않음', async () => {
  const s = memStore();
  s.get = async () => { throw new Error('AccessDenied'); };
  await assert.rejects(h.precheck(s, seq(1)), /AccessDenied/);
  await assert.rejects(h.restorePlan(s), /AccessDenied/);
});
