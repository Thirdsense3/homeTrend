// 빌드 사이의 변화: 새로 확인된 거래·삭제된 거래·신고가·급등·국면 변화 (로드맵 세부 사항 3, 3-1)
// 이미 신고된 거래와 공개 지수로만 판정한다. 앞으로의 가격을 예측하지 않는다
//
// 변화 항목: { id, type, b(빌드 번호), d(빌드 날짜, KST), code, ... }
//   new          새로 확인된 거래. flags: high(신고가), surge(급등 조건 충족), highPrice(높은 가격 거래 1건)
//   del          이전 빌드에 있었는데 사라진 거래 (해제·정정을 구분할 근거가 없어 삭제로만 표시)
//   surge        단지·평형 급등. 같은 단지·평형은 30일에 한 번만
//   regionSurge  지역 급등. 조건이 풀렸다가 다시 충족되고, 30일 안에 같은 지역 항목이 없을 때만
//   phase        지역 국면 변화
// id는 같은 빌드를 다시 계산해도 같다. 알림(6·8번)은 이 id로 중복 발송을 막는다
const crypto = require('crypto');
const an = require('./analyze');
const { tradeKey } = require('./ledger');

// 기준값은 초안이다. scripts/surge-frequency.js로 과거 데이터의 발생 빈도를 보고 조정한다 (docs/roadmap.md 3-1)
const SURGE = { baseMonths: 6, rise: 0.10, overMax: 0.05, minBase: 3, recentDays: 60, minCount: 2 };
const REGION_SURGE = { weekly: 0.003, weeks: 2, chg3m: 0.03 };
const REPEAT_DAYS = 30;
const RECENT_DAYS = 30;
// 피드에 남기는 새로 확인된 거래: 지역마다 신고가·급등·높은 가격 거래는 모두, 나머지는 최근 계약순으로 이만큼.
// 월초에 지난달 거래가 한꺼번에 들어와도 첫 화면 파일이 커지지 않게 한다 (건수는 regions에 따로 센다)
const FEED_PER_REGION = 30;
// 최근 30일 목록에 남기는 종류 (새로 확인된 거래는 지역 데이터의 firstSeen으로 볼 수 있어 뺀다)
const KEEP = new Set(['del', 'surge', 'regionSurge', 'phase']);

const changeId = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 16);
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const addMonths = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const groupKey = (r) => `${an.aptKey(r)}|${an.areaKey(r.area)}`;

const tradeFields = (r) => ({
  key: an.aptKey(r), date: r.date, area: r.area, floor: r.floor, price: r.price,
  ...(r.kind === '직거래' && { direct: 1 }),
});

// 기준 거래에서 빼는 거래: 직거래(가족 간 거래 등), 1~2층, 일괄 거래
const usable = (r) => r.kind !== '직거래' && r.floor > 2 && !r.bulk;

// 단지 급등 판정 (세부 사항 3-1). group: 같은 단지·평형의 시장 거래, t: 판정할 거래
//   직전 6개월 중위값보다 10% 이상 높은 거래가 최근 60일 안에 2건 이상이거나, 직전 6개월 최고가를 5% 이상 넘으면 surge
//   높은 거래가 1건뿐이면 highPrice. 기준 거래가 3건 미만이면 판정하지 않는다. p: 기준값 (빈도 점검용)
function surgeTest(group, t, today, p = SURGE) {
  const from = addDays(today, -p.recentDays);
  if (!usable(t) || t.date < from || t.date > today) return null;
  const base = (x) => group.filter((o) => usable(o) && o.date < x.date && o.date >= addMonths(x.date, -p.baseMonths)).map((o) => o.price);
  const high = (x) => { const b = base(x); return b.length >= p.minBase && x.price >= median(b) * (1 + p.rise) ? b : null; };
  const b = high(t);
  if (!b) return null;
  const med = median(b), max = Math.max(...b);
  const count = group.filter((o) => usable(o) && o.date >= from && o.date <= today && high(o)).length;
  const basis = { median: med, rise: r4(t.price / med - 1), n: b.length, count, max };
  return { kind: count >= p.minCount || t.price >= max * (1 + p.overMax) ? 'surge' : 'highPrice', basis };
}

const repeated = (recent, today, match) => recent.some((x) => x.d >= addDays(today, -REPEAT_DAYS) && match(x));

// 한 지역의 거래 변화. complete=false(이 지역 매매 수집에 실패한 달이 있음)면 여러 달을 보는 신고가·급등은 판정하지 않는다
function tradeChanges({ code, trades, added, removed, no, today, complete, recent = [] }) {
  const isAdded = new Set(added);
  const marked = an.markBulk(trades); // 사본이라 원본 순서로 다시 잇는다
  const groups = new Map();
  marked.forEach((r) => { if (!r.bulk) { const k = groupKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); } });
  const items = [], surges = new Map(), occurrences = new Map();
  marked.forEach((t, i) => {
    if (!isAdded.has(trades[i])) return;
    const flags = [];
    let basis;
    if (complete && !t.bulk) {
      const group = groups.get(groupKey(t));
      const prior = group.filter((o) => o.firstSeen < no);
      if (prior.length && t.price > Math.max(...prior.map((o) => o.price))) flags.push('high');
      const s = surgeTest(group, t, today);
      if (s) {
        flags.push(s.kind);
        basis = s.basis;
        const gk = groupKey(t);
        if (s.kind === 'surge' && !(surges.get(gk)?.t.price >= t.price)) surges.set(gk, { t, basis });
      }
    }
    // 조건이 같은 복수 거래는 몇 번째인지로 구분한다
    const k = tradeKey(t), n = occurrences.get(k) || 0;
    occurrences.set(k, n + 1);
    items.push({
      id: changeId('new', code, k, n, no),
      type: 'new', b: no, d: today, code, name: t.apt, ...tradeFields(t),
      ...(t.bulk && { bulk: 1 }), ...(flags.length && { flags }), ...(basis && { basis }),
    });
  });
  for (const [k, { t, basis }] of surges) {
    if (repeated(recent, today, (x) => x.type === 'surge' && x.code === code && `${x.key}|${an.areaKey(x.area)}` === k)) continue;
    items.push({ id: changeId('surge', code, k, no), type: 'surge', b: no, d: today, code, name: t.apt, ...tradeFields(t), basis });
  }
  const seenDel = new Map();
  for (const r of removed) { // r.key: 거래 키 (lib/ledger.js)
    const n = seenDel.get(r.key) || 0;
    seenDel.set(r.key, n + 1);
    // r.apt는 이력이 보존한 대표 단지 이름 (lib/ledger.js names) → 화면의 단지 키(aptKey)와 같다
    items.push({
      id: changeId('del', code, r.key, n, no), type: 'del', b: no, d: today, code, name: r.apt,
      key: `${r.dong}|${r.apt}`, date: r.date, area: r.area, floor: r.floor, price: r.price, firstSeen: r.firstSeen,
    });
  }
  return items;
}

// 주간 매매지수가 최근 2주 연속 0.3% 이상 올랐는지. 빈 값이 끼면 판정하지 않는다 (null)
function weeklyHit(weekly) {
  const s = weekly?.sale;
  if (!s || s.length < REGION_SURGE.weeks + 1) return null;
  const w = s.slice(-(REGION_SURGE.weeks + 1));
  if (w.some((v) => !(v > 0))) return null;
  const chg = w.slice(1).map((v, i) => v / w[i] - 1);
  return { hit: chg.every((c) => c >= REGION_SURGE.weekly), chg: chg.map(r4), date: weekly.dates[weekly.dates.length - 1] };
}

// 한 지역의 지역 단위 변화와 다음 빌드에 넘길 상태 { phase, phaseYm, surge }
//   prev: 이전 이력 (phase: 국면 번호, phaseYm: 그 국면의 기준월, surge: 지역 급등 조건 충족 여부)
//   ind: 이번 빌드의 지역 지표 (analyze.regionSummary), weekly: 부동산원 주간 지수 (없으면 null)
function regionChanges({ code, prev, ind, weekly, complete, no, today, recent = [] }) {
  const items = [];
  // 국면은 기준월(완성월)이 바뀔 때만 지난 기준월의 마지막 값과 비교한다. 같은 기준월 안에서는 늦은 신고로
  // 경계값 근처를 오가도 변화로 내지 않고 값만 갱신한다 (빌드마다 국면이 번갈아 뜨지 않게)
  const judged = complete && ind.phase && ind.currentYm;
  const phase = judged ? ind.phase.id : prev?.phase ?? null;
  const phaseYm = judged ? ind.currentYm : prev?.phaseYm ?? null;
  if (judged && prev?.phase != null && prev.phaseYm && ind.currentYm > prev.phaseYm && prev.phase !== ind.phase.id) {
    items.push({ id: changeId('phase', code, prev.phase, ind.phase.id, ind.currentYm), type: 'phase', b: no, d: today, code, from: prev.phase, to: ind.phase.id, ym: ind.currentYm });
  }
  const w = weeklyHit(weekly);
  const monthly = complete && ind.chg3m != null ? ind.chg3m >= REGION_SURGE.chg3m : null;
  // 둘 다 판정할 수 없으면 이전 상태를 유지한다
  const surge = w == null && monthly == null ? prev?.surge ?? false : !!(w?.hit || monthly);
  if (surge && prev && !prev.surge && !repeated(recent, today, (x) => x.type === 'regionSurge' && x.code === code)) {
    items.push({
      id: changeId('regionSurge', code, no), type: 'regionSurge', b: no, d: today, code,
      basis: { ...(w?.hit && { weekly: w.chg, week: w.date }), ...(monthly && { chg3m: r4(ind.chg3m), ym: ind.currentYm }) },
    });
  }
  return { items, state: { phase, phaseYm, surge } };
}

// 오늘(KST) 피드: 같은 날 여러 번 배포돼도 그날 확인된 변화를 모은다. 날짜가 바뀌면 새로 시작
//   regions: { code: { added, removed, failed, opened } } 이번 빌드의 지역별 집계 (added: 일괄 거래를 뺀 새로 확인된 거래 수)
function capFeed(items) {
  const kept = new Map();
  const plain = items.filter((x) => x.type === 'new' && !x.bulk && !x.flags?.length)
    .sort((a, b) => b.date.localeCompare(a.date) || b.price - a.price);
  for (const x of plain) {
    const n = kept.get(x.code) || 0;
    if (n < FEED_PER_REGION) kept.set(x.code, n + 1);
    else x.drop = true;
  }
  const out = items.filter((x) => !x.drop && !(x.type === 'new' && x.bulk));
  plain.forEach((x) => delete x.drop);
  return out;
}

function mergeFeed(prev, { today, no, items, regions }) {
  const same = prev && prev.date === today;
  const feed = { date: today, builds: [...(same ? prev.builds : []), no], items: capFeed([...(same ? prev.items : []), ...items]), regions: {} };
  const keys = new Set([...Object.keys(same ? prev.regions : {}), ...Object.keys(regions)]);
  for (const code of keys) {
    const a = (same && prev.regions[code]) || {}, b = regions[code] || {};
    feed.regions[code] = {
      added: (a.added || 0) + (b.added || 0),
      removed: (a.removed || 0) + (b.removed || 0),
      failed: !!b.failed,
      opened: [...new Set([...(a.opened || []), ...(b.opened || [])])],
    };
  }
  return feed;
}

// 최근 30일 변화 목록 (삭제된 거래·급등·국면 변화). 같은 id는 한 번만
function updateRecent(recent, items, today) {
  const from = addDays(today, -RECENT_DAYS);
  const ids = new Set();
  return [...recent, ...items.filter((x) => KEEP.has(x.type))]
    .filter((x) => x.d > from && !ids.has(x.id) && ids.add(x.id));
}

// 빌드 번호 → 날짜 표는 최근 90일만 둔다 (meta.json으로 매번 보내므로). 그보다 오래 확인하지 않은 관심단지는 날짜 없이 센다
const pruneBuilds = (builds, today) => Object.fromEntries(Object.entries(builds || {}).filter(([, d]) => d >= addDays(today, -90)));

module.exports = { SURGE, FEED_PER_REGION, pruneBuilds, REGION_SURGE, surgeTest, tradeChanges, regionChanges, weeklyHit, mergeFeed, updateRecent, addDays, addMonths };
