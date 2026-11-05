// 정책 후보 수집 (로드맵 9번 후속). 정책브리핑 보도자료 목록에서 부동산·대출 관련 글을 골라 "검토할 후보"로만 낸다.
// data/policies.json에 자동으로 넣지 않는다. 대상 지역·시행일·요약은 사람이 원문을 읽고 채운다 (lib/policies.js)
//
// 출처: https://www.korea.kr/briefing/pressReleaseList.do (RSS는 서비스 중단). 국토부 사이트는 자동 접속을 막아서 쓰지 않는다
const LIST_URL = 'https://www.korea.kr/briefing/pressReleaseList.do';
const VIEW_URL = 'https://www.korea.kr/briefing/pressReleaseView.do?newsId=';

// 정책브리핑의 부처 코드
const DEPTS = { A00006: '국토교통부', C00003: '금융위원회', A00041: '재정경제부' };

// 제목에 하나라도 있으면 후보. 너무 넓으면 이슈가 쓸모없어지므로 3개월치로 돌려 보고 조정한다
const INCLUDE = [
  '부동산', '주택', '아파트', '주담대', '주택담보', 'DSR', '가계부채', '가계대출',
  '토지거래허가', '투기과열', '조정대상', '규제지역', '분양가', '전세', '전월세', '임대차',
  '택지', '재건축', '재개발', '정비사업', '청약', '집값', '만 가구', '만가구', '만호', '만 호',
  '양도세', '양도소득세', '종부세', '종합부동산세', '취득세', '보유세', '세제개편',
];
// 정책 발표가 아닌 글 (동정·인사·행사·통계 등). 월별 "가계대출 동향 및 가계부채 점검회의"는 대출 규제가 함께 나와서 남긴다
const EXCLUDE = ['동정', '[인사]', '설명회', '모집', '공모', '시상', '피싱', '채용', '통계', '기업경기조사'];

const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&middot;/g, '·').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// 목록 페이지 HTML → [{ id, title, date, dept, url }], 전체 건수
function parseList(html) {
  const items = [];
  const re = /<a href="\/briefing\/pressReleaseView\.do\?newsId=(\d+)[^"]*">([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html));) {
    const body = m[2];
    const title = body.match(/<strong>([\s\S]*?)<\/strong>/);
    const src = body.match(/<span class="source">\s*<span>(\d{4})[.-](\d{2})[.-](\d{2})<\/span>\s*<span>([^<]*)<\/span>/);
    if (!title || !src) continue;
    items.push({ id: m[1], title: decode(title[1]), date: `${src[1]}-${src[2]}-${src[3]}`, dept: decode(src[4]), url: VIEW_URL + m[1] });
  }
  const total = html.match(/총 <strong>([\d,]+)/);
  return { items, total: total ? Number(total[1].replace(/,/g, '')) : null };
}

function isCandidate(title) {
  if (EXCLUDE.some((w) => title.includes(w))) return false;
  return INCLUDE.some((w) => title.includes(w));
}

// 후보만 남기고, 이미 본 글(seen: newsId 집합)과 같은 제목(부처 공동 발표)을 하나로 합친다
function pickCandidates(items, seen = new Set()) {
  const byTitle = new Map();
  for (const x of items) {
    if (seen.has(x.id) || !isCandidate(x.title)) continue;
    const key = x.title.replace(/\s/g, '');
    const prev = byTitle.get(key);
    if (prev) { if (!prev.depts.includes(x.dept)) prev.depts.push(x.dept); prev.ids.push(x.id); continue; }
    byTitle.set(key, { ...x, depts: [x.dept], ids: [x.id] });
  }
  return [...byTitle.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// 글에 들어 있는 정책브리핑 newsId를 모두 꺼낸다 (기존 정책 원문 링크, 지난 후보 이슈 본문)
const newsIds = (text) => new Set([...String(text).matchAll(/newsId=(\d+)/g)].map((m) => m[1]));

// 이슈 본문 (markdown)
function toMarkdown(cands, { from, to }) {
  const lines = [
    `정책브리핑 보도자료(${Object.values(DEPTS).join('·')})에서 ${from} ~ ${to}에 올라온 부동산·대출 관련 글 ${cands.length}건이에요.`,
    '',
    '`data/policies.json`에 넣을 것만 골라 주세요. 대상 지역·시행일·요약은 원문을 읽고 채웁니다. 이 목록은 제목 키워드로만 고른 것이라 빠지거나 관련 없는 글이 섞일 수 있어요.',
    '',
  ];
  for (const c of cands) lines.push(`- [ ] ${c.date} · ${c.depts.join('·')} · [${c.title}](${c.url})`);
  return lines.join('\n') + '\n';
}

module.exports = { LIST_URL, DEPTS, INCLUDE, EXCLUDE, parseList, isCandidate, pickCandidates, newsIds, toMarkdown };
