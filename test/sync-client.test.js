// 브라우저의 동기화 로직(public/app.js의 sync)을 Node VM에서 실행하고, 서버는 sync.mjs 규칙으로 흉내 낸다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const an = require('../lib/analyze');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function browser(fetch) {
  const storage = {};
  const ctx = {
    window: { Analyze: an }, console, setTimeout, clearTimeout, fetch,
    document: { getElementById: () => null, addEventListener: () => {}, dispatchEvent: () => {} },
    localStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
    location: { hash: '#/' }, route: () => {}, regionOf: () => null, Event: class { constructor(t) { this.type = t; } },
  };
  // 좋아요한 지역(regionLikes)은 app.js 뒤쪽에 있어 같은 동작으로 둔다
  vm.runInNewContext(`${source.slice(0, source.indexOf('function sparkline'))}
    const regionLikes = {
      list() { try { const v = JSON.parse(localStorage.getItem('homeTrend.regionLikes')); return Array.isArray(v) ? v : []; } catch (_) { return []; } },
      save(list, quiet) { localStorage.setItem('homeTrend.regionLikes', JSON.stringify(list)); if (!quiet) sync.schedule(); },
    };
    state.meta = { api: 'https://api.test', buildNo: 100 };
    globalThis.result = { sync, watch, regionLikes, SYNC_BATCH };`, ctx);
  return { ...ctx.result, storage };
}

// sync.mjs 규칙으로 동작하는 메모리 서버
async function server() {
  const S = await import('../infra/functions/sync/sync.mjs');
  const db = new Map();
  const sizes = [];
  const fetch = async (url, { body }) => {
    const op = url.split('/').pop();
    const reply = (status, j) => ({ ok: status < 300, status, statusText: String(status), json: async () => j });
    try {
      const r = S.parseRequest(body, { needCode: op !== 'create' });
      sizes.push(r.changes.length);
      if (op === 'create') { const { doc } = S.apply(S.emptyDoc(), r.changes); const code = S.newCode(); db.set(code, doc); return reply(200, { code, ...S.view(doc) }); }
      const doc = db.get(r.code);
      if (!doc) return reply(404, { error: 'code' });
      if (r.changes.length && S.isStale(doc, r.base)) return reply(200, { stale: true, ...S.view(doc) });
      const { doc: next, conflicts } = S.apply(doc, r.changes);
      db.set(r.code, next);
      return reply(200, { ...S.view(next), conflicts });
    } catch (e) {
      return reply(e.status || 500, { error: e.message });
    }
  };
  return { S, db, sizes, fetch };
}

const likes = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));
const live = (doc) => Object.entries(doc.items).filter(([, it]) => !it.d).map(([id]) => id).sort();
const settle = async (b) => { while (b.sync.busy) await b.sync.busy; };

test('이전 코드의 늦은 404는 새로 연결한 코드를 끊지 않는다', async () => {
  let release;
  const b = browser((url, { body }) => {
    if (JSON.parse(body).code === 'old') return new Promise((ok) => { release = () => ok({ ok: false, status: 404, statusText: '404', json: async () => ({ error: 'code' }) }); });
    throw new Error('unexpected');
  });
  b.storage['homeTrend.sync'] = JSON.stringify({ code: 'old', rev: 1, snap: {} });
  const running = b.sync.run();
  // 요청이 끝나기 전에 다른 코드로 연결
  b.storage['homeTrend.sync'] = JSON.stringify({ code: 'new', rev: 3, snap: {} });
  release();
  await running;
  assert.equal(b.sync.conf()?.code, 'new');
});

test('변경이 서버 한도를 넘으면 삭제부터 나눠 보내고, 아직 보내지 않은 변경은 지키며 끝까지 맞춘다', async () => {
  const srv = await server();
  const b = browser(srv.fetch);
  b.regionLikes.save(likes(10000, 150), true);
  await b.sync.create();
  // 오프라인에서 150개를 모두 지우고 새 151개로 바꿈 → 변경 301건 (서버 MAX_CHANGES 300 초과)
  b.regionLikes.save(likes(20000, 151), true);
  assert.equal(b.sync.pending(b.sync.conf()).length, 301);
  srv.sizes.length = 0;
  await b.sync.run();
  await settle(b);
  const [code] = srv.db.keys();
  assert.deepEqual(live(srv.db.get(code)), likes(20000, 151).map((c) => `r:${c}`).sort());
  assert.deepEqual([...b.regionLikes.list()].sort(), likes(20000, 151));
  assert.equal(b.sync.pending(b.sync.conf()).length, 0);
  assert.ok(srv.sizes.every((n) => n <= b.SYNC_BATCH), `요청별 변경 수 ${srv.sizes}`);
  assert.ok(srv.sizes.length >= 4);
});

test('오래된 기기: 나눠 보내야 할 만큼 변경이 많아도 남은 묶음까지 모두 확인을 받는다', async () => {
  const srv = await server();
  const b = browser(srv.fetch);
  b.regionLikes.save(['11110'], true);
  await b.sync.create();
  const [code] = srv.db.keys();
  const doc = srv.db.get(code);
  srv.db.set(code, { ...doc, purged: doc.rev + 5, rev: doc.rev + 5 }); // 그 뒤 다른 기기가 지운 삭제 표시가 정리됨
  b.regionLikes.save(['11110', ...likes(30000, 150)], true);
  await b.sync.run();
  await settle(b);
  assert.equal(b.sync.held()?.reason, 'stale');
  assert.equal(b.sync.held().changes.length, 150);
  assert.deepEqual([...b.regionLikes.list()], ['11110']); // 서버 목록을 먼저 받고, 확인 전에는 보내지 않음
  assert.deepEqual(live(srv.db.get(code)), ['r:11110']);
});
