// 거래 이력 S3 보관 (GitHub Actions에서 사용). 규칙은 lib/history.js, 여기는 AWS CLI·tar 연결
// 사용: HISTORY_BUCKET=<버킷> node scripts/history.js <명령> [--meta dist/data/meta.json]
//   restore  빌드 전: 확정된 스냅샷을 data/cache로 풀기. 포인터가 없으면 bootstrap=true 출력 (첫 이전)
//   save     빌드 뒤: data/cache를 builds/<순번>/cache.tar.gz로 올리기
//   check    배포 전: 더 최신 빌드가 확정돼 있으면 실패 (Pages 배포·확정을 건너뛰고 알람)
//   confirm  배포 뒤: 확정 포인터 갱신 + 장기 보관본 + 확정 마커
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('../lib/history');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BUCKET = process.env.HISTORY_BUCKET;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function fail(r, what) {
  const e = new Error(`${what}: ${(r.stderr || r.stdout || '').trim()}`);
  if (/\((PreconditionFailed|ConditionalRequestConflict)\)/.test(r.stderr)) e.code = 'PreconditionFailed';
  return e;
}

const store = {
  get(key) {
    const file = path.join(tmp, 'get.json');
    const r = run('aws', ['s3api', 'get-object', '--bucket', BUCKET, '--key', key, file]);
    if (r.status !== 0) {
      if (/\(NoSuchKey\)/.test(r.stderr)) return null;
      throw fail(r, `s3://${BUCKET}/${key} 읽기 실패`);
    }
    return { body: fs.readFileSync(file, 'utf8'), etag: JSON.parse(r.stdout).ETag };
  },
  put(key, body, { ifMatch, ifNoneMatch } = {}) {
    const file = path.join(tmp, 'put.json');
    fs.writeFileSync(file, body);
    const args = ['s3api', 'put-object', '--bucket', BUCKET, '--key', key, '--body', file, '--content-type', 'application/json'];
    if (ifMatch) args.push('--if-match', ifMatch);
    if (ifNoneMatch) args.push('--if-none-match', ifNoneMatch);
    const r = run('aws', args);
    if (r.status !== 0) throw fail(r, `s3://${BUCKET}/${key} 쓰기 실패`);
  },
  copy(src, dst) {
    // 태그 복사는 권한이 더 필요하고 쓰지 않으므로 끈다
    const r = run('aws', ['s3', 'cp', `s3://${BUCKET}/${src}`, `s3://${BUCKET}/${dst}`, '--copy-props', 'none', '--only-show-errors']);
    if (r.status !== 0) throw fail(r, `${src} → ${dst} 복사 실패`);
  },
  download(key, file) {
    const r = run('aws', ['s3', 'cp', `s3://${BUCKET}/${key}`, file, '--only-show-errors']);
    if (r.status === 0) return true;
    if (/\(404\)|NoSuchKey/.test(r.stderr)) return false;
    throw fail(r, `s3://${BUCKET}/${key} 받기 실패`);
  },
  upload(file, key) {
    const r = run('aws', ['s3', 'cp', file, `s3://${BUCKET}/${key}`, '--only-show-errors']);
    if (r.status !== 0) throw fail(r, `s3://${BUCKET}/${key} 올리기 실패`);
  },
};

function tar(args) {
  const r = run('tar', args);
  if (r.status !== 0) throw fail(r, `tar ${args[0]}`);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// 빌드 순번은 환경 변수가 아니라 배포 아티팩트(meta.json)에 기록된 값을 쓴다
function metaOf(argv) {
  const i = argv.indexOf('--meta');
  const file = i >= 0 ? argv[i + 1] : path.join(__dirname, '..', 'dist', 'data', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { seq: h.parseSeq(meta.build), builtAt: meta.builtAt };
}

const commands = {
  async restore() {
    const plan = await h.restorePlan(store);
    output('bootstrap', plan.bootstrap);
    if (plan.bootstrap) {
      console.log('확정 포인터 없음 → 첫 이전 (Actions 캐시에서 시작)');
      return;
    }
    const file = path.join(tmp, 'cache.tar.gz');
    for (const key of plan.keys) {
      if (!store.download(key, file)) { console.log(`${key} 없음`); continue; }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      tar(['-xzf', file, '-C', DATA_DIR]); // 파일 수정 시각을 보존해야 캐시 TTL(lib/molit.js)이 맞는다
      console.log(`확정 빌드 ${h.seqId(plan.seq)}의 이력 복원: ${key} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB)`);
      return;
    }
    // 포인터는 있는데 스냅샷이 없으면 새로 만들지 않고 멈춘다 (빈 이력으로 덮어쓰지 않게)
    throw new Error(`확정 빌드 ${h.seqId(plan.seq)}의 스냅샷을 찾지 못했습니다`);
  },
  async save(argv) {
    const { seq } = metaOf(argv);
    const file = path.join(tmp, 'cache.tar.gz');
    tar(['-czf', file, '-C', DATA_DIR, 'cache']);
    store.upload(file, h.snapshotKey(seq));
    console.log(`이력 저장: ${h.snapshotKey(seq)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB)`);
  },
  async check(argv) {
    const { seq } = metaOf(argv);
    const r = await h.precheck(store, seq);
    console.log(`배포 전 확인 통과: 빌드 ${h.seqId(seq)} (${{ first: '첫 확정', retry: '같은 빌드 확정 재시도', newer: '새 빌드' }[r]})`);
  },
  async confirm(argv) {
    const { seq, builtAt } = metaOf(argv);
    const r = await h.confirm(store, seq, { builtAt });
    console.log(`확정: 빌드 ${h.seqId(seq)}${r.updated ? '' : ' (포인터는 이미 갱신됨, 마커만 다시 씀)'}`);
  },
};

(async () => {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!commands[cmd]) throw new Error(`명령: ${Object.keys(commands).join(' | ')}`);
  if (!BUCKET) throw new Error('HISTORY_BUCKET이 없습니다');
  await commands[cmd](argv);
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true })).catch((e) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});
