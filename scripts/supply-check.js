// 입주 예정 물량의 새 반기 파일 확인 (로드맵 20번, lib/supply.js updateIssue)
//   node scripts/supply-check.js [--seen 파일] --out 파일
// 공공데이터포털 상세 페이지(Markdown 형식)의 '수정일'을 data/supply.json의 updated와 비교한다.
// 출력: 열 이슈가 있으면 [{ marker, title, body }], 없으면 []. 페이지를 읽지 못하면 실패로 끝낸다 (새 파일을 놓쳤는지 알 수 없으므로)
const fs = require('fs');
const path = require('path');
const supply = require('../lib/supply');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const meta = require('../data/supply.json');

(async () => {
  const url = `${meta.source}?format=md`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const updated = supply.portalUpdated(await res.text());
  if (!updated) throw new Error(`${url}: 수정일을 찾지 못했습니다 (페이지 형식이 바뀌었을 수 있음)`);
  const seen = arg('seen') ? supply.markersIn(fs.readFileSync(arg('seen'), 'utf8')) : new Set();
  const issue = supply.updateIssue(meta, updated, seen);
  console.error(`포털 수정일 ${updated}, 저장소 ${meta.updated} → ${issue ? '새 파일 확인 이슈' : '열 이슈 없음'}`);
  const out = JSON.stringify(issue ? [issue] : [], null, 2) + '\n';
  if (arg('out')) fs.writeFileSync(path.resolve(arg('out')), out);
  else process.stdout.write(out);
})().catch((e) => { console.error(e.message); process.exit(1); });
