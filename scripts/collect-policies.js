// 정책 후보 수집: 정책브리핑 보도자료 목록과 서울시 보도자료 RSS를 읽어 부동산·대출 관련 글을 markdown 목록으로 낸다 (lib/policy-collect.js)
//   node scripts/collect-policies.js [--days 14] [--from YYYY-MM-DD --to YYYY-MM-DD] [--seen 파일] [--out 파일]
// --seen: 이 파일에 나온 원문 주소는 건너뛴다 (지난 후보 이슈 본문). data/policies.json 원문 링크도 항상 건너뛴다
// 후보가 없으면 --out 파일을 만들지 않는다.
// 다 읽었는지 확신할 수 없으면 실패로 끝낸다: 필드 해석 실패, 반복 페이지, 페이지 상한 도달, 전체 건수와 고유 글 수 불일치.
// 기간 안에 글이 없는 정상적인 0건은 성공이다
const fs = require('fs');
const path = require('path');
const pc = require('../lib/policy-collect');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const ymd = (d) => d.toISOString().slice(0, 10);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(new Date(`${s}T00:00:00Z`)) === s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (compatible; homeTrend-policy-collector)';
const MAX_DAYS = 120;
const MAX_PAGES = 60; // 정책브리핑 20건/쪽(120일 3개 부처 약 800건), 서울시 50건/쪽(120일 약 1,400건)

async function get(url, init, what) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 3) throw new Error(`${what}을(를) 읽지 못했습니다: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
}

const opts = { maxPages: MAX_PAGES, wait: () => sleep(1000), log: (m) => console.error(m) };

const collectKorea = (from, to) => pc.crawlKorea((page) => get(pc.KOREA_LIST_URL, {
  method: 'POST',
  body: new URLSearchParams({ repCodeType: '정부부처', repCode: Object.keys(pc.DEPTS).join(','), startDate: from, endDate: to, pageIndex: String(page) }),
}, `정책브리핑 목록 ${page}쪽`).then(pc.parseList), from, to, opts);

const collectSeoul = (from, to) => pc.crawlSeoul((page) => get(`${pc.SEOUL_RSS_URL}&page=${page}`, {}, `서울시 보도자료 RSS ${page}쪽`).then(pc.parseSeoulRss), from, to, opts);

(async () => {
  const today = ymd(new Date(Date.now() + 9 * 3600e3)); // KST
  const days = arg('days') ?? '14';
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > MAX_DAYS) throw new Error(`--days는 1~${MAX_DAYS} 사이 정수여야 합니다: ${days}`);
  const to = arg('to') ?? today;
  const from = arg('from') ?? ymd(new Date(Date.parse(`${to}T00:00:00Z`) - Number(days) * 86400e3));
  if (!isYmd(from) || !isYmd(to)) throw new Error('--from, --to는 YYYY-MM-DD');
  if (from > to) throw new Error('--from이 --to보다 늦습니다');
  if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86400e3) throw new Error(`기간은 ${MAX_DAYS}일까지입니다`);

  const korea = await collectKorea(from, to);
  const seoul = await collectSeoul(from, to);

  const seen = pc.sourceKeys(fs.readFileSync(path.join(__dirname, '../data/policies.json'), 'utf8'));
  if (arg('seen')) for (const k of pc.sourceKeys(fs.readFileSync(arg('seen'), 'utf8'))) seen.add(k);
  const cands = pc.pickCandidates([...korea, ...seoul], seen);
  console.error(`${from} ~ ${to}: 정책브리핑 ${korea.length}건, 서울시 ${seoul.length}건 중 후보 ${cands.length}건`);
  if (!cands.length) return;
  const md = pc.toMarkdown(cands, { from, to, sources: [`정책브리핑 보도자료(${Object.values(pc.DEPTS).join('·')})`, '서울시 보도자료'] });
  if (arg('out')) fs.writeFileSync(arg('out'), md);
  else process.stdout.write(md);
})().catch((e) => { console.error(e.message); process.exit(1); });
