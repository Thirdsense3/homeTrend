// 거래 관측 이력: 거래마다 처음 확인한 빌드 번호를 기억해 "새로 확인된 거래"를 계산한다 (로드맵 세부 사항 3)
// 이력은 data/cache/ledger/에 두어 국토부 원본 캐시와 함께 S3 스냅샷으로 보관된다 (lib/history.js).
// 다음 빌드는 확정(Pages 배포 성공)된 빌드의 스냅샷만 읽으므로, 배포에 실패한 빌드의 관측은 다음 빌드에서 다시 비교된다
//
// 빌드 번호: 빌드 순번 (run_number, run_attempt)을 run_number × 100 + run_attempt 한 정수.
//   GitHub는 재실행을 50번까지만 허용하므로 사전식 순서가 그대로 보존된다. 0은 이력을 처음 만들 때 이미 있던 거래
//
// 지역 파일 <지역>.json
//   { v, end, pending, months: { '<ym>': { '<거래 키>': [처음 확인한 빌드 번호, ...] } }, phase, phaseYm, surge, lastAdded }
//   end: 지난 빌드 조회 기간의 마지막 계약월. 이보다 새 달은 조회 기간에 새로 들어온 달이라 그 거래를 모두 새로 확인된 거래로 본다
//   pending: 새로 들어왔지만 그 빌드에서 수집에 실패한 달. 처음 받는 빌드에서 새로 들어온 달로 본다
//   이력 시작 때 수집에 실패한 달은 비교 기준이 없어 나중에 받으면 기존 거래(0)로 둔다 (한꺼번에 새 거래로 뜨지 않게)
//   거래 키가 같은 실제 복수 거래는 배열 길이(개수)로 보존한다
//   phase·surge: 지역 국면 번호와 지역 급등 조건 충족 여부 (lib/changes.js regionChanges)
//   names: { '<동>|<원본 명칭>': 대표 단지 이름 } 거래 키는 원본 명칭이라, 그 명칭의 거래가 모두 사라진 뒤에도
//          삭제 항목을 대표 단지(화면의 단지 키)로 잇기 위해 보존한다. 대표 단지 이름은 지번까지 맞아야 정해져(lib/complexes.js) 키만으로는 복원할 수 없다
//   lastAdded: 마지막으로 새 거래가 확인된 날과 건수 { d, n }
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const DIR = path.join(__dirname, '..', 'data', 'cache', 'ledger');

function buildNo(seq) {
  if (!seq) return 0;
  const { runNumber, runAttempt } = seq;
  if (!(Number.isInteger(runNumber) && runNumber >= 1 && Number.isInteger(runAttempt) && runAttempt >= 1 && runAttempt < 100)) {
    throw new Error(`빌드 순번 형식 오류: ${JSON.stringify(seq)}`);
  }
  return runNumber * 100 + runAttempt;
}

// 매매 자료에는 거래 고유번호가 없다 → 단지·계약일·면적·층·금액으로 같은 거래를 찾는다.
// 단지는 원본 명칭으로 둔다. 대표 단지 별칭(lib/complexes.js)이 바뀌어도 키가 그대로라 대량 삭제·추가로 기록되지 않는다
const tradeKey = (r) => `${r.dong}|${r.sourceApt || r.apt}|${r.date}|${Math.round(r.area * 100)}|${r.floor}|${r.price}`;
// apt는 원본 명칭이다 (대표 단지로 잇는 건 lib/changes.js)
function parseKey(k) {
  const p = k.split('|');
  const [date, area, floor, price] = p.slice(-4);
  return { dong: p[0], apt: p.slice(1, -4).join('|'), date, area: Number(area) / 100, floor: Number(floor), price: Number(price) };
}

// 지역 이력 읽기. 없으면 null(이 지역은 이력 시작). 읽었는데 깨져 있으면 새로 만들지 않고 멈춘다 (throw)
function read(code, dir = DIR) {
  let body;
  try { body = fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const l = JSON.parse(body);
  if (l.v !== VERSION || typeof l.months !== 'object') throw new Error(`거래 이력 형식 오류: ${code}`);
  return l;
}

function write(code, ledger, dir = DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${code}.json`), JSON.stringify(ledger));
}

// 지역이 아닌 상태 파일: feed(오늘 변화), recent(최근 30일 변화), builds(빌드 번호 → 날짜). 이름이 숫자가 아니라 지역 파일과 겹치지 않는다
function readState(name, dir = DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
const writeState = (name, data, dir = DIR) => write(name, data, dir);

// 이번 수집 결과를 이전 이력과 비교한다
//   prev: 이전 이력 (null이면 이력 시작: 지금 있는 거래는 모두 0)
//   months: [{ ym, ok, rows }] 이번 조회 기간의 월별 수집 결과. ok=false(수집 실패)인 달은 이전 이력을 그대로 둔다
//   no: 이번 빌드 번호
// 반환: { ledger, added, removed, opened }. 각 행에 firstSeen(처음 확인한 빌드 번호)을 붙인다
//   removed: [{ key, firstSeen, dong, apt(대표 단지 이름), sourceApt(원본 명칭), date, area, floor, price }]
//   조회 기간에서 빠진 달은 이력에서 지우지만 거래 삭제로 보지 않는다
function observe(prev, months, no) {
  const end = months.reduce((m, x) => (x.ym > m ? x.ym : m), '') || prev?.end || null;
  const next = { v: VERSION, end, pending: [], names: { ...prev?.names }, months: {} };
  for (const { rows } of months) for (const r of rows) next.names[`${r.dong}|${r.sourceApt || r.apt}`] = r.apt;
  // 삭제된 거래: 거래 키(원본 명칭)와 함께 대표 단지 이름(apt)을 붙인다
  const gone = (k, firstSeen) => {
    const r = parseKey(k);
    return { key: k, firstSeen, ...r, sourceApt: r.apt, apt: next.names[`${r.dong}|${r.apt}`] || r.apt };
  };
  const added = [], removed = [], opened = [];
  for (const { ym, ok, rows } of months) {
    const before = prev?.months[ym];
    // 이전 이력에 없는 달: 지난 조회 기간보다 새 달(또는 그때 실패해 미뤄 둔 달)이면 새로 들어온 달, 아니면 비교 기준이 없어 0
    const fresh = !before && !!prev?.end && (ym > prev.end || (prev.pending || []).includes(ym));
    if (!ok) {
      if (before) next.months[ym] = before;
      else if (fresh) next.pending.push(ym);
      continue;
    }
    if (fresh && rows.length) opened.push(ym);
    const groups = new Map();
    for (const r of rows) {
      const k = tradeKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const out = {};
    for (const [k, rs] of groups) {
      const seen = [...(before?.[k] || [])].sort((a, b) => a - b);
      if (rs.length > seen.length) {
        const base = before || fresh ? no : 0;
        while (seen.length < rs.length) seen.push(base);
      } else if (rs.length < seen.length) {
        // 어느 쪽이 없어졌는지 알 수 없으므로 가장 늦게 확인한 것부터 지운다
        for (const b of seen.splice(rs.length)) removed.push(gone(k, b));
      }
      rs.forEach((r, i) => {
        r.firstSeen = seen[i];
        if (no && seen[i] === no) added.push(r);
      });
      out[k] = seen;
    }
    for (const k of Object.keys(before || {})) {
      if (!groups.has(k)) for (const b of before[k]) removed.push(gone(k, b));
    }
    next.months[ym] = out;
  }
  return { ledger: next, added, removed, opened };
}

module.exports = { VERSION, DIR, buildNo, tradeKey, parseKey, read, write, readState, writeState, observe };
