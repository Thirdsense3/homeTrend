// 거래 이력(국토부 원본 캐시) S3 보관 규칙: 빌드 순번 비교, 배포 전 확인, 확정 포인터 갱신
// 저장소 접근은 store로 주입한다 (운영: scripts/history.js의 AWS CLI, 테스트: 메모리)
//   store.get(key) → { body, etag } | null(없음). 그 외 오류는 throw
//   store.put(key, body, { ifMatch, ifNoneMatch }) → 조건 불일치면 err.code = 'PreconditionFailed'
//   store.copy(src, dst)
//
// S3 경로
//   builds/<순번>/cache.tar.gz  빌드마다 남기는 캐시 스냅샷 (수명 주기로 30일 뒤 삭제)
//   confirmed.json              마지막으로 Pages 배포까지 끝난 빌드 (확정 포인터)
//   confirmed/<순번>.json       확정 마커. 알림 발송 준비(6·8번)가 이 경로만 구독한다
//   history/cache.tar.gz        확정된 스냅샷의 장기 보관본 (빌드 스냅샷이 만료돼도 이어 받기)

const POINTER = 'confirmed.json';
const HISTORY = 'history/cache.tar.gz';
const MAX_TRIES = 5;

// 빌드 순번: (run_number, run_attempt). 재실행해도 run_number는 그대로라 둘을 사전식으로 비교한다
function parseSeq(s) {
  const runNumber = Number(s && s.runNumber), runAttempt = Number(s && s.runAttempt);
  if (!Number.isInteger(runNumber) || runNumber < 1 || !Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error(`빌드 순번 형식 오류: ${JSON.stringify(s)}`);
  }
  return { runNumber, runAttempt };
}
const compareSeq = (a, b) => a.runNumber - b.runNumber || a.runAttempt - b.runAttempt;
const seqId = (s) => `${s.runNumber}-${s.runAttempt}`;
const snapshotKey = (s) => `builds/${seqId(s)}/cache.tar.gz`;
const markerKey = (s) => `confirmed/${seqId(s)}.json`;

class StaleBuildError extends Error {
  constructor(seq, current) {
    super(`이미 확정된 빌드(${seqId(current)})가 이 빌드(${seqId(seq)})보다 최신입니다 (과거 실행 재실행). 배포·확정하지 않습니다.`);
    this.name = 'StaleBuildError';
  }
}

async function readPointer(store) {
  const r = await store.get(POINTER);
  if (!r) return null;
  const p = JSON.parse(r.body);
  return { ...p, seq: parseSeq(p.seq), etag: r.etag };
}

// 빌드 시작: 이어 받을 스냅샷 경로 (앞의 것이 없으면 다음 것). 포인터가 없으면 첫 이전
async function restorePlan(store) {
  const p = await readPointer(store);
  if (!p) return { bootstrap: true, keys: [] };
  return { bootstrap: false, seq: p.seq, keys: [snapshotKey(p.seq), HISTORY] };
}

// 배포 전 확인: 이 빌드보다 큰 순번이 확정돼 있으면 Pages 배포와 확정을 모두 건너뛴다 (throw)
// 같은 순번이면 배포 job만 재실행한 확정 재시도
async function precheck(store, seq) {
  const p = await readPointer(store);
  if (!p) return 'first';
  const c = compareSeq(seq, p.seq);
  if (c < 0) throw new StaleBuildError(seq, p.seq);
  return c === 0 ? 'retry' : 'newer';
}

// Pages 배포 성공 뒤: 포인터를 조건부로 올리고, 장기 보관본과 확정 마커를 쓴다
// 포인터가 이미 이 순번이면(마커 쓰기 전에 실패한 재시도) 빠진 단계만 다시 한다. 모두 멱등
async function confirm(store, seq, { builtAt, now = () => new Date().toISOString() } = {}) {
  const marker = JSON.stringify({ seq, builtAt, snapshot: snapshotKey(seq) });
  for (let i = 0; i < MAX_TRIES; i++) {
    const p = await readPointer(store);
    const c = p ? compareSeq(seq, p.seq) : 1;
    if (c < 0) throw new StaleBuildError(seq, p.seq);
    if (c > 0) {
      const body = JSON.stringify({ seq, builtAt, snapshot: snapshotKey(seq), confirmedAt: now() });
      try {
        await store.put(POINTER, body, p ? { ifMatch: p.etag } : { ifNoneMatch: '*' });
      } catch (e) {
        if (e.code === 'PreconditionFailed') continue; // 그 사이 포인터가 바뀜 → 다시 읽고 판단
        throw e;
      }
    }
    await store.copy(snapshotKey(seq), HISTORY);
    await store.put(markerKey(seq), marker);
    return { updated: c > 0 };
  }
  throw new Error(`확정 포인터 갱신이 ${MAX_TRIES}번 충돌했습니다`);
}

module.exports = {
  POINTER, HISTORY, parseSeq, compareSeq, seqId, snapshotKey, markerKey,
  StaleBuildError, readPointer, restorePlan, precheck, confirm,
};
