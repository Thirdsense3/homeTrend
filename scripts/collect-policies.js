// 정책 후보 수집: 정책브리핑 보도자료 목록을 읽어 부동산·대출 관련 글을 markdown 목록으로 낸다 (lib/policy-collect.js)
//   node scripts/collect-policies.js [--days 14] [--from YYYY-MM-DD --to YYYY-MM-DD] [--seen 파일] [--out 파일]
// --seen: 이 파일에 나온 newsId는 건너뛴다 (지난 후보 이슈 본문). data/policies.json 원문 링크도 항상 건너뛴다
// 후보가 없으면 --out 파일을 만들지 않는다. 목록을 읽지 못하면 실패로 끝낸다
const fs = require('fs');
const path = require('path');
const pc = require('../lib/policy-collect');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const ymd = (d) => d.toISOString().slice(0, 10);
const kstToday = () => new Date(Date.now() + 9 * 3600e3);

const MAX_PAGES = 40; // 한 페이지 20건. 3개월치 3개 부처가 약 600건(30쪽)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(from, to, page) {
  const body = new URLSearchParams({ repCodeType: '정부부처', repCode: Object.keys(pc.DEPTS).join(','), startDate: from, endDate: to, pageIndex: String(page) });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(pc.LIST_URL, { method: 'POST', body, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; homeTrend-policy-collector)' }, signal: AbortSignal.timeout(30e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return pc.parseList(await res.text());
    } catch (e) {
      if (attempt >= 3) throw new Error(`정책브리핑 목록 ${page}쪽을 읽지 못했습니다: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
}

(async () => {
  const to = arg('to') || ymd(kstToday());
  const from = arg('from') || ymd(new Date(Date.parse(`${to}T00:00:00Z`) - (Number(arg('days')) || 14) * 86400e3));

  const all = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchPage(from, to, page);
    if (page === 1) total = r.total;
    if (page === 1 && r.total == null && !r.items.length) throw new Error('목록 형식을 알아보지 못했습니다 (페이지 구조가 바뀌었을 수 있음)');
    all.push(...r.items);
    if (!r.items.length || (total != null && all.length >= total)) break;
    await sleep(1000);
  }
  if (total != null && all.length < total) console.error(`경고: 전체 ${total}건 중 ${all.length}건만 읽었습니다 (최대 ${MAX_PAGES}쪽)`);

  const seen = pc.newsIds(fs.readFileSync(path.join(__dirname, '../data/policies.json'), 'utf8'));
  if (arg('seen') && fs.existsSync(arg('seen'))) for (const id of pc.newsIds(fs.readFileSync(arg('seen'), 'utf8'))) seen.add(id);
  const cands = pc.pickCandidates(all, seen);
  console.error(`${from} ~ ${to}: 보도자료 ${all.length}건 중 후보 ${cands.length}건`);
  if (!cands.length) return;
  const md = pc.toMarkdown(cands, { from, to });
  if (arg('out')) fs.writeFileSync(arg('out'), md);
  else process.stdout.write(md);
})().catch((e) => { console.error(e.message); process.exit(1); });
