// 정책 만료 전 확인 이슈 목록을 JSON으로 낸다 (lib/policy-reviews.js)
//   node scripts/policy-reviews.js [--today YYYY-MM-DD] [--seen 파일] --out 파일
// 출력: [{ marker, title, body }]. 열 이슈가 없으면 빈 배열
const fs = require('fs');
const path = require('path');
const { validate } = require('../lib/policies');
const pr = require('../lib/policy-reviews');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const today = arg('today') ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) { console.error('--today는 YYYY-MM-DD'); process.exit(1); }

const data = validate(require('../data/policies.json'), require('../data/regions.json'));
const seen = arg('seen') ? pr.markersIn(fs.readFileSync(arg('seen'), 'utf8')) : new Set();
const due = pr.dueReviews(data, today, seen);
const pending = data.items.flatMap((p) => (p.reviews || []).filter((r) => !r.done).map((r) => `${p.id}/${r.id}@${r.by}`));
console.error(`${today}: 확인 대기 ${pending.length}건 (${pending.join(', ') || '없음'}), 새로 열 이슈 ${due.length}건`);
const out = JSON.stringify(due, null, 2) + '\n';
if (arg('out')) fs.writeFileSync(path.resolve(arg('out')), out);
else process.stdout.write(out);
