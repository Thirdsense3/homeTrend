// 관심 목록 동기화 규칙 (로드맵 5번, docs/roadmap.md 세부 사항 5). DynamoDB와 무관한 부분만 두어 테스트한다
//
// 테이블 hometrend의 항목 (코드 하나 = 항목 하나)
//   pk sync#<코드 해시>  sk s   { v: 형식 버전, rev: 서버 리비전, purged, items: { <항목 id>: { r, v } | { r, d } }, createdAt, updatedAt, touchedAt, expiresAt }
// 코드 원문은 저장하지 않는다. 128비트 무작위 값이라 느린 해시 없이 SHA-256으로 충분하다
//
// 병합: 클라이언트는 항목별로 마지막으로 본 항목 리비전(from)과 새 값을 보낸다. 서버 값의 리비전이 from과 같으면 적용하고,
// 다르면(다른 기기가 먼저 바꿈) 충돌로 돌려준다. 서로 다른 항목은 각각 판정하므로 자연히 병합된다. 기기 시각은 쓰지 않는다
import { createHash, randomBytes } from 'node:crypto';

export const FORMAT = 1; // 동기화 데이터 형식 버전
export const DAY = 24 * 60 * 60 * 1000;
export const TOMBSTONE_DAYS = 90; // 삭제 표시 보관 기간
export const IDLE_DAYS = 365; // 이 기간 접근이 없으면 코드와 목록을 지운다 (TTL)
export const TOUCH_EVERY = DAY; // 접근 시각(만료 연장)은 하루에 한 번만 쓴다
export const MAX_ITEMS = 300; // 삭제 표시를 뺀 항목 수
export const MAX_CHANGES = 300;
export const MAX_BODY = 64 * 1024;
export const MONTHS = [36, 60, 120, 192]; // 단지 화면 조회 기간 (public/app.js APT_MONTHS)

export class BadRequest extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Crockford base32 (i·l·o·u 없음). 26자 = 130비트 칸에 128비트를 담는다
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const CODE_LEN = 26;
export function newCode(bytes = randomBytes(16)) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) { s = ALPHABET[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
// 사람이 옮겨 적은 코드: 대소문자·하이픈·공백 무시, 헷갈리는 글자(i·l → 1, o → 0)는 고쳐 읽는다
export function normalizeCode(s) {
  if (typeof s !== 'string' || s.length > 64) return null;
  const c = s.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  return c.length === CODE_LEN && [...c].every((ch) => ALPHABET.includes(ch)) && c[0] <= '7' ? c : null;
}
export const hashCode = (code) => createHash('sha256').update(code).digest('hex');
export const pkOf = (code) => `sync#${hashCode(code)}`;

// 항목 id와 값. 관심단지 w:<지역 코드>:<단지 키>, 좋아요한 지역 r:<지역 코드>
// 관심단지 값에는 화면에 다시 그리는 데 필요한 것만 둔다. 마지막 확인 빌드(checked)는 기기마다 달라 보내지 않는다
const str = (max, min = 0) => (v) => (typeof v === 'string' && v.length >= min && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : undefined);
const WATCH = {
  name: str(100, 1),
  jibun: str(40),
  region: str(40),
  area: (v) => (typeof v === 'string' && /^\d{1,4}(\.\d{1,2})?$/.test(v) ? v : undefined),
  months: (v) => (MONTHS.includes(v) ? v : undefined),
};
export function parseId(id) {
  if (typeof id !== 'string' || id.length > 160) return null;
  let m = /^w:(\d{5}):(.+)$/.exec(id);
  if (m && str(120, 1)(m[2]) !== undefined) return { kind: 'w', code: m[1], key: m[2] };
  m = /^r:(\d{5})$/.exec(id);
  return m ? { kind: 'r', code: m[1] } : null;
}
export function cleanValue(id, v) {
  const p = parseId(id);
  if (!p) throw new BadRequest('항목 id');
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest('항목 값');
  if (p.kind === 'r') return {};
  const out = {};
  for (const [k, check] of Object.entries(WATCH)) {
    const x = check(v[k]);
    if (x !== undefined) out[k] = x;
  }
  if (!out.name) throw new BadRequest('항목 값');
  return out;
}

// 요청 본문: { code?, base?: 마지막으로 본 서버 리비전, changes?: [{ id, v: 값 | null(삭제), from: 마지막으로 본 항목 리비전(처음 보면 0) }] }
export function parseRequest(body, { needCode = true } = {}) {
  if (typeof body !== 'string' || body.length > MAX_BODY) throw new BadRequest('본문 크기', 413);
  let j;
  try { j = JSON.parse(body || '{}'); } catch (_) { throw new BadRequest('JSON 아님'); }
  if (!j || typeof j !== 'object') throw new BadRequest('JSON 아님');
  const code = needCode ? normalizeCode(j.code) : null;
  if (needCode && !code) throw new BadRequest('코드');
  const base = j.base === undefined ? 0 : j.base;
  if (!Number.isInteger(base) || base < 0) throw new BadRequest('리비전');
  const raw = j.changes === undefined ? [] : j.changes;
  if (!Array.isArray(raw) || raw.length > MAX_CHANGES) throw new BadRequest('변경 수', 413);
  const seen = new Set();
  const changes = [];
  for (const c of raw) {
    if (!c || !Number.isInteger(c.from) || c.from < 0) throw new BadRequest('변경 형식');
    const v = cleanValue(c.id, c.v);
    if (seen.has(c.id)) throw new BadRequest('같은 항목 중복');
    seen.add(c.id);
    changes.push({ id: c.id, v, from: c.from });
  }
  return { code, base, changes };
}

export const emptyDoc = () => ({ v: FORMAT, rev: 0, purged: 0, items: {} });
const valueOf = (it) => (it && !it.d ? it.v : null);
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

// 오래 동기화하지 않은 기기: 그 뒤 지운 삭제 표시가 있으면 그 기기의 목록으로는 삭제 여부를 알 수 없다.
// 변경을 적용하지 않고 서버 목록을 돌려줘, 클라이언트가 먼저 받고 사용자 확인 뒤 다시 보내게 한다
export const isStale = (doc, base) => base < (doc.purged || 0);

// 변경 적용. 원본 doc은 바꾸지 않는다. 반환: 새 doc, 충돌(현재 서버 값), 실제로 바뀌었는지
export function apply(doc, changes, now = Date.now()) {
  const items = { ...doc.items };
  const rev = doc.rev + 1;
  const conflicts = [];
  let changed = false;
  for (const c of changes) {
    const cur = items[c.id];
    const curValue = valueOf(cur);
    // 결과가 이미 같으면(두 기기가 같은 단지를 저장 등) 충돌로 보지 않고 그대로 둔다
    if (same(curValue, c.v)) continue;
    // 처음 보는 항목(from 0)을 추가하는데 서버에도 없으면(삭제 표시뿐이어도) 새 추가로 받는다
    const absentBoth = c.from === 0 && curValue === null;
    if (!absentBoth && c.from !== (cur?.r || 0)) {
      conflicts.push({ id: c.id, r: cur?.r || 0, v: curValue });
      continue;
    }
    items[c.id] = c.v === null ? { r: rev, d: new Date(now).toISOString() } : { r: rev, v: c.v };
    changed = true;
  }
  // 90일 지난 삭제 표시를 지우고, 지운 것 중 가장 큰 리비전을 남긴다 (isStale 판정)
  let purged = doc.purged || 0;
  for (const [id, it] of Object.entries(items)) {
    if (it.d && Date.parse(it.d) + TOMBSTONE_DAYS * DAY <= now) {
      purged = Math.max(purged, it.r);
      delete items[id];
      changed = true;
    }
  }
  if (Object.values(items).filter((it) => !it.d).length > MAX_ITEMS) throw new BadRequest('항목 수', 413);
  return { doc: changed ? { ...doc, rev, purged, items } : doc, conflicts, changed };
}

// 클라이언트에 돌려줄 목록: 항목 리비전과 값, 삭제 표시는 리비전만
export function view(doc) {
  const items = {};
  for (const [id, it] of Object.entries(doc.items)) items[id] = it.d ? { r: it.r, d: 1 } : { r: it.r, v: it.v };
  return { v: doc.v, rev: doc.rev, items };
}

export const ttl = (ms) => Math.floor((ms + IDLE_DAYS * DAY) / 1000);
// TTL 삭제는 며칠 늦을 수 있어 읽을 때도 만료를 확인한다
export const expired = (item, now) => !item || (item.expiresAt && item.expiresAt * 1000 <= now);
