// 정책 후보 수집 (로드맵 9번 후속). 보도자료 목록에서 부동산·대출 관련 글을 골라 "검토할 후보"로만 낸다.
// data/policies.json에 자동으로 넣지 않는다. 대상 지역·시행일·요약은 사람이 원문을 읽고 채운다 (lib/policies.js)
//
// 출처
//   정책브리핑 보도자료 목록 https://www.korea.kr/briefing/pressReleaseList.do (RSS는 서비스 중단, HTML을 읽는다)
//   서울시 보도자료 RSS https://seoulboard.seoul.go.kr/rss/RSSGenerator?bbsNo=158 (토지거래허가구역 등 서울시 발표)
// 국토부 사이트는 자동 접속을 막아서 쓰지 않는다
const KOREA_LIST_URL = 'https://www.korea.kr/briefing/pressReleaseList.do';
const KOREA_VIEW_URL = 'https://www.korea.kr/briefing/pressReleaseView.do?newsId=';
const SEOUL_RSS_URL = 'https://seoulboard.seoul.go.kr/rss/RSSGenerator?bbsNo=158';
const SEOUL_VIEW_URL = 'https://www.seoul.go.kr/news/news_report.do#view/';

// 정책브리핑의 부처 코드. 국세청(B00004)·행정안전부(A00031)는 시험해 보니 신고 안내·화재 예방 글만 걸리고
// 세제 개편은 재정경제부가 발표해서 뺐다 (2026-08~11 기준)
const DEPTS = { A00006: '국토교통부', C00003: '금융위원회', A00041: '재정경제부' };

// 제목에 하나라도 있으면 후보. 너무 넓으면 이슈가 쓸모없어지므로 기간을 정해 돌려 보고 조정한다
const INCLUDE = [
  '부동산', '주택', '아파트', '주담대', '주택담보', 'DSR', '가계부채', '가계대출',
  '토지거래허가', '투기과열', '조정대상', '규제지역', '분양가', '전세', '전월세', '임대차',
  '택지', '재건축', '재개발', '정비사업', '청약', '집값', '만 가구', '만가구', '만호', '만 호',
  '양도세', '양도소득세', '종부세', '종합부동산세', '취득세', '보유세', '재산세', '세제개편',
];
// 정책 발표가 아닌 글 (동정·인사·행사·통계 등). 월별 "가계대출 동향 및 가계부채 점검회의"는 대출 규제가 함께 나와서 남긴다
const EXCLUDE = ['동정', '[인사]', '설명회', '모집', '공모', '시상', '피싱', '채용', '통계', '기업경기조사'];
// 서울시는 보도자료가 많고(3개월 약 1,100건) 개별 정비사업·행사 글이 대부분이라, 규제·대책 키워드만 본다
const SEOUL_INCLUDE = ['토지거래허가', '투기과열', '조정대상', '규제지역', '분양가상한', '부동산 대책', '부동산대책', '공급 대책', '공급대책', '공급 방안', '집값'];
// 키워드가 다른 낱말 안에 우연히 들어 있는 경우 (예: "재난안전세미나"의 "전세", "인재개발원"의 "재개발")
const FALSE_HIT = [/안전세/g, /인재개발/g];

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&middot;/g, '·').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// 원문 주소 → 출처별 고유 키. 이슈 본문·policies.json에서 이미 본 글을 찾을 때도 같은 규칙을 쓴다
const keyOf = (url) => {
  const k = String(url).match(/korea\.kr\/[^\s)]*?newsId=(\d+)/);
  if (k) return `korea:${k[1]}`;
  const s = String(url).match(/seoul\.go\.kr\/news\/news_report\.do#view\/(\d+)/);
  return s ? `seoul:${s[1]}` : null;
};
const sourceKeys = (text) => new Set([...String(text).matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => keyOf(m[0])).filter(Boolean));

// 목록 항목 하나라도 필수 필드(주소·날짜, 정책브리핑은 제목·부처 칸)를 못 읽으면 broken으로 센다 → 수집 스크립트가 실패로 끝낸다
// (구조가 바뀌어 일부만 조용히 빠지는 것을 막는다)

// 정책브리핑 목록 페이지 HTML → { items: [{ key, id, title, date, dept, url }], total, broken, untitled }
function parseList(html) {
  const items = [];
  let broken = 0, untitled = 0;
  const re = /<a href="\/briefing\/pressReleaseView\.do\?newsId=(\d+)[^"]*">([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html));) {
    const body = m[2];
    const title = body.match(/<strong>([\s\S]*?)<\/strong>/);
    const src = body.match(/<span class="source">\s*<span>(\d{4})[.-](\d{2})[.-](\d{2})<\/span>\s*<span>([^<]*)<\/span>/);
    if (!title || !src) { broken++; continue; }
    if (!decode(title[1])) untitled++;
    const url = KOREA_VIEW_URL + m[1];
    items.push({ key: keyOf(url), id: m[1], title: decode(title[1]), date: `${src[1]}-${src[2]}-${src[3]}`, dept: decode(src[4]), url });
  }
  const total = html.match(/총 <strong>([\d,]+)/);
  return { items, total: total ? Number(total[1].replace(/,/g, '')) : null, broken, untitled };
}

// 서울시 보도자료 RSS → { items, total, broken, untitled }. 제목 앞 "(엠바고10시)(석간)" 같은 표시는 뺀다
const SEOUL_PREFIX = /^(?:\s*\((?:석간|조간|즉시|자료제공|설명|참고|엠바고[^)]*|보도시점[^)]*)\))+\s*/;
function parseSeoulRss(xml) {
  const items = [];
  let broken = 0, untitled = 0;
  // 요소가 없으면 null, 있는데 내용이 비었으면 '' (구조 변경과 원문 공란을 구분한다)
  const tag = (s, name) => { const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : null; };
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const s = m[1];
    const link = tag(s, 'link'), rawTitle = tag(s, 'title'), date = (tag(s, 'pubDate') ?? '').slice(0, 10);
    const key = link == null ? null : keyOf(link);
    if (!key || rawTitle == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { broken++; continue; }
    const title = rawTitle.replace(SEOUL_PREFIX, '');
    if (!title) untitled++; // <title>은 있는데 원문 자체가 제목 없이 올라온 글. 키워드에 걸리지 않으므로 후보는 안 된다
    items.push({ key, id: key.split(':')[1], title, date, dept: ['서울시', tag(s, 'dept')].filter((d) => d && d !== 'null').join(' '), url: SEOUL_VIEW_URL + key.split(':')[1] });
  }
  const total = xml.match(/<totalCnt>(\d+)<\/totalCnt>/);
  return { items, total: total ? Number(total[1]) : null, broken, untitled };
}

function isCandidate(title, source = 'korea') {
  if (EXCLUDE.some((w) => title.includes(w))) return false;
  const t = FALSE_HIT.reduce((s, re) => s.replace(re, ' '), title);
  return (source === 'seoul' ? SEOUL_INCLUDE : INCLUDE).some((w) => t.includes(w));
}

// 후보만 남기고, 이미 본 글(seen: 출처 키 집합)은 뺀다.
// 같은 날 같은 제목(부처 공동 발표)만 하나로 합치고, 날짜가 다르면 후속 발표로 보고 따로 둔다.
// 합친 글의 원문 주소는 모두 남긴다 (이슈에 전부 적어야 다음 실행에서 다시 올라오지 않는다)
function pickCandidates(items, seen = new Set()) {
  const groups = new Map();
  for (const x of items) {
    if (seen.has(x.key) || !isCandidate(x.title, x.key.split(':')[0])) continue;
    const g = `${x.date}|${x.title.replace(/\s/g, '')}`;
    const prev = groups.get(g);
    if (prev) { if (!prev.links.some((l) => l.key === x.key)) prev.links.push({ key: x.key, dept: x.dept, url: x.url }); continue; }
    groups.set(g, { title: x.title, date: x.date, links: [{ key: x.key, dept: x.dept, url: x.url }] });
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.links[0].key.localeCompare(b.links[0].key));
}

// 이슈 본문 (markdown). 합친 글의 원문 링크를 모두 적는다
function toMarkdown(cands, { from, to, sources }) {
  const lines = [
    `${sources.join(', ')}에서 ${from} ~ ${to}에 올라온 부동산·대출 관련 글 ${cands.length}건이에요.`,
    '',
    '`data/policies.json`에 넣을 것만 골라 주세요. 대상 지역·시행일·요약은 원문을 읽고 채웁니다. 이 목록은 제목 키워드로만 고른 것이라 빠지거나 관련 없는 글이 섞일 수 있어요.',
    '',
  ];
  for (const c of cands) lines.push(`- [ ] ${c.date} · ${c.title} — ${c.links.map((l) => `[${l.dept}](${l.url})`).join(' · ')}`);
  return lines.join('\n') + '\n';
}

// ---------- 페이지 순회 (누락 감지) ----------
// fetchPage(page) → parseList/parseSeoulRss 결과. 다 읽었는지 확신할 수 없으면 던진다:
// 필드 해석 실패, 전체 건수 없음, 앞 페이지와 같은 글만 나옴(페이지 넘기기 고장), 페이지 상한 도달.
// 같은 글이 여러 페이지에 나와도 고유 글만 센다 (건수를 채운 것처럼 보이지 않게)
async function crawl(name, fetchPage, { done, maxPages = 60, wait = async () => {}, log = () => {} }) {
  const byKey = new Map();
  let total = null;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error(`${name}: ${maxPages}쪽을 넘었습니다 (기간을 줄이세요)`);
    const r = await fetchPage(page);
    if (r.broken) throw new Error(`${name} ${page}쪽: 항목 ${r.broken}개를 해석하지 못했습니다 (페이지 구조가 바뀌었을 수 있음)`);
    if (r.total == null) throw new Error(`${name} ${page}쪽: 전체 건수를 찾지 못했습니다 (페이지 구조가 바뀌었을 수 있음)`);
    if (r.untitled) log(`${name} ${page}쪽: 제목이 비어 있는 글 ${r.untitled}건 (원문 그대로, 후보에서 빠짐)`);
    if (page === 1) total = r.total;
    if (!r.items.length) break;
    const fresh = r.items.filter((x) => !byKey.has(x.key));
    if (!fresh.length) throw new Error(`${name} ${page}쪽: 앞 페이지와 같은 글만 나왔습니다 (페이지 넘기기가 동작하지 않음)`);
    for (const x of fresh) byKey.set(x.key, x);
    if (done(byKey, total, r)) break;
    await wait();
  }
  return { items: [...byKey.values()], total };
}

// 정책브리핑: 서버가 기간·부처로 걸러 주므로 전체 건수와 고유 글 수가 같아야 한다. 정상적인 0건(전체 0)은 성공.
// 수집 중에 새 글이 올라오면 페이지가 밀려 어긋날 수 있어 한 번 더 시도한다
async function crawlKorea(fetchPage, from, to, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await crawl('정책브리핑', fetchPage, { ...opts, done: (byKey, total) => byKey.size >= total });
    const outside = r.items.filter((x) => x.date < from || x.date > to);
    if (outside.length) throw new Error(`정책브리핑: 기간 밖의 글 ${outside.length}건이 나왔습니다 (기간 필터가 동작하지 않음)`);
    if (r.items.length === r.total) return r.items;
    if (attempt >= 2) throw new Error(`정책브리핑: 전체 ${r.total}건 중 고유 글 ${r.items.length}건만 읽었습니다`);
    (opts.log || (() => {}))(`정책브리핑: 전체 ${r.total}건 중 ${r.items.length}건 → 다시 읽습니다`);
  }
}

// 서울시 RSS: 기간 필터가 없어 최신순으로 넘기다가, 한 페이지가 통째로 기간 이전이 되면 멈춘다
// (날짜가 완전히 정렬돼 있다고 보지 않으므로 한 건이 아니라 페이지 전체로 판단)
// 정상 종료는 두 가지뿐이다: 전체 건수만큼 읽음, 또는 기간 이전 페이지에 도달함.
// 그 전에 빈 페이지가 나오면(항목 구조가 바뀌어 하나도 못 읽은 경우 포함) 실패한다
async function crawlSeoul(fetchPage, from, to, opts = {}) {
  let reachedBefore = false;
  const r = await crawl('서울시', fetchPage, {
    ...opts,
    done: (byKey, total, page) => byKey.size >= total || (reachedBefore = page.items.every((x) => x.date < from)),
  });
  if (!reachedBefore && r.items.length < r.total) {
    throw new Error(`서울시: 전체 ${r.total}건 중 ${r.items.length}건만 읽었는데 기간(${from}) 이전에 닿기 전에 빈 페이지가 나왔습니다 (구조가 바뀌었을 수 있음)`);
  }
  return r.items.filter((x) => x.date >= from && x.date <= to);
}

module.exports = { crawl, crawlKorea, crawlSeoul, KOREA_LIST_URL, SEOUL_RSS_URL, DEPTS, INCLUDE, EXCLUDE, SEOUL_INCLUDE, keyOf, sourceKeys, parseList, parseSeoulRss, isCandidate, pickCandidates, toMarkdown };
