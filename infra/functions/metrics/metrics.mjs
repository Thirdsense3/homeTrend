// 방문 측정 규칙 (로드맵 2번, docs/roadmap.md 세부 사항 2). DynamoDB와 무관한 부분만 두어 테스트한다
//
// 테이블 hometrend의 항목 (기기 ID 하나 = 파티션 하나라서 기기 기록 삭제가 Query + 삭제 한 번이다)
//   pk dev#<기기>  sk e#<이벤트 ID>   원본 이벤트. 90일 뒤 삭제
//   pk dev#<기기>  sk d#<KST 날짜>    방문 날짜별 행동 요약(행동 종류, 건수). 90일 뒤 삭제
//   pk dev#<기기>  sk s               기기 요약(첫 방문·활성화·재방문 날짜). 마지막 활동 기준 90일 뒤 삭제
//   pk agg#<표>    sk <KST 날짜>      매일 집계. 기기를 식별할 수 없는 숫자만 있고 장기 보관

// 측정 정의 버전. 이벤트·지표 정의를 바꾸면 올리고 집계 행에도 남긴다
// 2: 관심 평형 저장(watch_add a, watch_area)과 첫 방문 안내(guide), 평형까지 저장한 활성화
// 3: 동기화 코드(sync). 기존 지표 정의는 그대로
export const VERSION = 3;
export const AREA_VERSION = 2; // 이 버전부터 첫 방문한 기기만 '평형까지 저장한 활성화'의 분모에 넣는다
export const DAY = 24 * 60 * 60 * 1000;
export const RAW_TTL_DAYS = 90;
export const MAX_EVENTS = 30; // 요청 하나에 담는 이벤트 수
export const MAX_BODY = 16 * 1024;
export const DAILY_MAX = 500; // 기기 하루 이벤트 상한. 넘으면 이후 요청을 거부하고 그 기기를 집계에서 뺀다
export const ACTIVATION_WINDOW = DAY; // 첫 방문 후 24시간
export const RETENTION = { w1: [7, 13], w4: [28, 34] }; // 활성화 후 날짜 구간 (경과 일수)
export const AGG_DAYS = 60; // 매일 다시 계산하는 집계 기간. 기기 요약이 남아 있는 기간(90일) 안
// 측정 도입 전부터 쓰던 브라우저의 첫 방문 값. 신규 기기로 세지 않는다
export const LEGACY_FIRST_VISIT = '2020-01-01T00:00:00.000Z';

const int = (max) => (v) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const oneOf = (...xs) => (v) => (xs.includes(v) ? v : undefined);
const buildId = (v) => (typeof v === 'string' && /^\d{1,9}(\.\d{1,3})?$/.test(v) ? v : undefined);

// 이벤트 종류 허용 목록과 종류별로 받는 값. 검색어·단지 이름·관심 목록은 받지 않는다
export const EVENTS = {
  visit: {}, // 페이지를 열 때 한 번
  view_overview: {},
  view_region: {},
  view_apt: {},
  view_watch: { n: int(1000) }, // 관심단지 요약 확인. n: 관심단지 수
  view_privacy: {},
  search: { k: oneOf('apt', 'region') }, // 검색 결과 선택. 무엇을 골랐는지 종류만
  watch_add: { n: int(1000), a: oneOf(0, 1) }, // a: 관심 평형까지 골라 저장했는지 (어떤 평형인지는 받지 않는다)
  watch_remove: { n: int(1000) },
  watch_area: {}, // 저장한 단지의 관심 평형을 저장·변경
  sync: { k: oneOf('create', 'link', 'rotate', 'delete', 'unlink', 'conflict') }, // 동기화 코드 행동 종류만 (코드·목록은 받지 않는다)
  guide: { k: oneOf('show', 'search', 'close') }, // 첫 방문 안내: 보임, 검색 시작, 닫음
  watch_change_available: { b: buildId, c: int(1000), t: int(100000) }, // 관심단지 화면에 새 거래가 있었음. b: 데이터 빌드, c: 단지 수, t: 거래 수
  watch_change_open: { b: buildId, t: int(100000) }, // 새 거래가 있는 단지를 눌러 상세 확인
};
// 핵심 재방문으로 세는 행동 (관심단지 변화 확인). 7번(후보 비교)에서 비교 확인을 더한다
export const CORE = new Set(['view_watch', 'watch_change_open']);

export class BadRequest extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isDeviceId = (s) => typeof s === 'string' && UUID.test(s);

// 요청 본문: { d: 기기 ID, fv: 첫 방문 시각, m: 1(모바일)|0, e: [{ id, type, p }] }
export function parseBatch(body, now = Date.now()) {
  if (typeof body !== 'string' || !body || body.length > MAX_BODY) throw new BadRequest('본문 크기');
  let j;
  try { j = JSON.parse(body); } catch (_) { throw new BadRequest('JSON 아님'); }
  if (!j || !isDeviceId(j.d)) throw new BadRequest('기기 ID');
  if (!Array.isArray(j.e) || !j.e.length || j.e.length > MAX_EVENTS) throw new BadRequest('이벤트 수');
  const seen = new Set();
  const events = [];
  for (const e of j.e) {
    if (!e || !isDeviceId(e.id) || !Object.hasOwn(EVENTS, e.type)) throw new BadRequest('이벤트 형식');
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const props = {};
    for (const [k, check] of Object.entries(EVENTS[e.type])) {
      const v = check(e.p?.[k]);
      if (v !== undefined) props[k] = v;
    }
    events.push({ id: e.id, type: e.type, props });
  }
  return { device: j.d, firstVisit: firstVisit(j.fv, now), mobile: j.m === 1, events };
}

// 브라우저가 기억하는 첫 방문 시각. 미래·형식 오류는 지금으로 본다
export function firstVisit(fv, now = Date.now()) {
  const t = typeof fv === 'string' ? Date.parse(fv) : NaN;
  if (!Number.isFinite(t) || t > now || t < Date.parse(LEGACY_FIRST_VISIT)) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

export const kstDate = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
export const ttl = (ms, days = RAW_TTL_DAYS) => Math.floor((ms + days * DAY) / 1000);
export const daysSince = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY);

// 활성화 후 경과 일수. 재방문 구간 중 가장 늦은 날까지만 기록한다
export function coreDay(activatedAt, now) {
  if (!activatedAt) return null;
  const d = daysSince(activatedAt, now);
  return d >= 0 && d <= RETENTION.w4[1] ? d : null;
}

const watchSegment = (n) => (!n ? null : n === 1 ? 'watch1' : n <= 3 ? 'watch2_3' : 'watch4p');
const ratio = () => ({ eligible: 0, retained: 0 });

// 매일 집계: 기기 요약(sk s)과 날짜별 요약(sk d#…)으로 기기를 식별할 수 없는 표를 만든다.
// 관찰 구간이 끝난 기기만 분모에 넣고, 최근 AGG_DAYS일 행을 매번 다시 계산해 덮어쓴다(멱등)
export const aggFrom = (now) => kstDate(now - AGG_DAYS * DAY);
export const AGG_TABLES = ['activation', 'retention', 'daily'];

export function aggregate(items, now = Date.now()) {
  const today = kstDate(now);
  const from = aggFrom(now);
  const summaries = new Map();
  const days = [];
  for (const it of items) {
    if (!it.pk?.startsWith('dev#')) continue;
    if (it.sk === 's') summaries.set(it.pk, it);
    else if (it.sk?.startsWith('d#')) days.push(it);
  }
  const flagged = new Set([...summaries].filter(([, s]) => s.flagged).map(([pk]) => pk));
  const rows = new Map();
  const row = (table, date, init) => {
    const k = `${table}|${date}`;
    if (!rows.has(k)) rows.set(k, { pk: `agg#${table}`, sk: date, ...init() });
    return rows.get(k);
  };

  for (const s of summaries.values()) {
    if (s.flagged || !s.firstSeen) continue;
    // 활성화: 첫 방문 후 24시간이 지난 기기만
    const fd = kstDate(Date.parse(s.firstSeen));
    if (fd >= from && Date.parse(s.firstSeen) + ACTIVATION_WINDOW <= now) {
      const r = row('activation', fd, () => ({ devices: 0, activated: 0, mobile: { devices: 0, activated: 0 }, desktop: { devices: 0, activated: 0 }, area: { devices: 0, activated: 0 } }));
      for (const t of [r, r[s.mobile ? 'mobile' : 'desktop']]) {
        t.devices++;
        if (s.activatedAt) t.activated++;
      }
      // 평형까지 저장하고 요약을 확인한 기기. 관심 평형 저장이 생긴 뒤(firstV) 처음 온 기기만 분모에 넣어 기존 기준선과 따로 본다
      if ((s.firstV || 1) >= AREA_VERSION) {
        r.area.devices++;
        if (s.activatedAreaAt) r.area.activated++;
      }
    }
    // 핵심 재방문: 활성화 날짜별, 구간이 끝난 기기만
    if (!s.activatedAt) continue;
    const ad = kstDate(Date.parse(s.activatedAt));
    if (ad < from) continue;
    const segs = ['all', s.mobile ? 'mobile' : 'desktop', watchSegment(s.watchCount), s.hadChange ? 'change' : 'nochange'].filter(Boolean);
    const r = row('retention', ad, () => ({ activated: 0 }));
    r.activated++;
    const core = new Set(s.coreDays || []);
    for (const [w, [a, b]] of Object.entries(RETENTION)) {
      if (daysSince(s.activatedAt, now) <= b) continue;
      const hit = [...core].some((d) => d >= a && d <= b);
      for (const seg of segs) {
        r[seg] ||= {};
        r[seg][w] ||= ratio();
        r[seg][w].eligible++;
        if (hit) r[seg][w].retained++;
      }
    }
  }

  // 날짜별: 방문 기기 수, 행동별 기기 수, 변화 확인(새 거래가 있던 기기 중 상세를 연 기기)
  for (const d of days) {
    const date = d.sk.slice(2);
    if (date < from || date >= today || flagged.has(d.pk)) continue;
    const r = row('daily', date, () => ({ devices: 0, mobile: 0, events: 0, acts: {}, change: { available: 0, opened: 0 } }));
    const acts = new Set(d.acts || []);
    r.devices++;
    if (d.mobile) r.mobile++;
    r.events += d.n || 0;
    for (const a of acts) r.acts[a] = (r.acts[a] || 0) + 1;
    if (acts.has('watch_change_available')) {
      r.change.available++;
      if (acts.has('watch_change_open')) r.change.opened++;
    }
  }
  const updatedAt = new Date(now).toISOString();
  return [...rows.values()].map((r) => ({ ...r, v: VERSION, updatedAt }));
}

// 다시 계산한 기간(aggFrom 이후)에 있던 집계 행 중 이번 결과에 없는 행. 그 날짜의 기기가 모두 차단·삭제된 경우라 지운다
export function staleRows(existing, rows, now = Date.now()) {
  const from = aggFrom(now);
  const keep = new Set(rows.map((r) => `${r.pk}|${r.sk}`));
  return existing.filter((r) => r.pk.startsWith('agg#') && r.sk >= from && !keep.has(`${r.pk}|${r.sk}`)).map(({ pk, sk }) => ({ pk, sk }));
}
