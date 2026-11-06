const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pc = require('../lib/policy-collect');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// 정책브리핑 목록 페이지의 항목 모양 (날짜 필터를 걸면 YYYY-MM-DD, 안 걸면 YYYY.MM.DD로 나온다)
const li = (id, title, date, dept) => `
  <li>
    <a href="/briefing/pressReleaseView.do?newsId=${id}&amp;pageIndex=1&amp;repCodeType=&srchWord=&amp;period=">
      <span class="text">
        <strong>${title}</strong>
        <span class="lead">본문 요약</span>
        <span class="source">
          <span>${date}</span>
          <span>${dept}</span>
        </span>
      </span>
    </a>
  </li>`;
const it = (id, title, date = '2026-08-13', dept = '국토교통부') => {
  const url = `https://www.korea.kr/briefing/pressReleaseView.do?newsId=${id}`;
  return { key: pc.keyOf(url), id, title, date, dept, url };
};

test('정책브리핑 실제 응답 표본을 읽는다', () => {
  const r = pc.parseList(fixture('korea-press-list.html'));
  assert.equal(r.total, 24);
  assert.equal(r.broken, 0);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items[1], it('156774505', '[참고] 서소문 고가차도 붕괴사고, 승인 없는 작업·위험 미보고 등 확인', '2026-08-14'));
});

test('서울시 RSS 실제 응답 표본을 읽는다 (제목 앞 표시 제거, 제목 없는 원문은 따로 센다)', () => {
  const r = pc.parseSeoulRss(fixture('seoul-press-rss.xml'));
  assert.equal(r.total, 64278);
  assert.equal(r.broken, 0);
  assert.equal(r.untitled, 1);
  assert.deepEqual(r.items[0], {
    key: 'seoul:469707', id: '469707', title: "자전거 타다 쉬고, 한강버스로 이동하고… 서울시, '잠실 한강 자전거장' 14일 개장",
    date: '2026-11-05', dept: '서울시 체육진흥과', url: 'https://www.seoul.go.kr/news/news_report.do#view/469707',
  });
  const prefixed = '<totalCnt>1</totalCnt><item><title><![CDATA[ (엠바고10시)(석간) 토지거래허가구역 지정 ]]></title><link><![CDATA[ https://www.seoul.go.kr/news/news_report.do#view/1 ]]></link><pubDate>2026-11-05 05:00:00</pubDate><dept><![CDATA[ null ]]></dept></item>';
  assert.deepEqual(pc.parseSeoulRss(prefixed).items.map((x) => [x.title, x.dept]), [['토지거래허가구역 지정', '서울시']]);
});

test('필수 필드를 못 읽은 항목은 broken으로 센다', () => {
  const html = `총 <strong>2</strong>${li('101', '제목', '2026-08-18', '국토교통부')}<a href="/briefing/pressReleaseView.do?newsId=102">구조가 바뀐 항목</a>`;
  const r = pc.parseList(html);
  assert.equal(r.items.length, 1);
  assert.equal(r.broken, 1);
  assert.equal(pc.parseSeoulRss('<totalCnt>1</totalCnt><item><title>제목</title><link>https://x</link><pubDate>2026-11-05</pubDate></item>').broken, 1);
  assert.deepEqual(pc.parseList('<html>점검 중</html>'), { items: [], total: null, broken: 0, untitled: 0 });
});

test('제목 키워드로 후보를 고른다', () => {
  assert.ok(pc.isCandidate('토지거래허가구역 내 실거주 유예 연장'));
  assert.ok(pc.isCandidate('2026년 9월 가계대출 동향(잠정) 및 가계부채 점검회의 개최'));
  assert.ok(pc.isCandidate('수도권 우수 입지에 2.3만 가구 공급 추진'));
  assert.ok(!pc.isCandidate('[장관동정] 장관, 주택공급 현장 점검'));
  assert.ok(!pc.isCandidate("'26년 9월 주택통계"));
  assert.ok(!pc.isCandidate('제11차 공급망안정화위원회 개최'));
  assert.ok(!pc.isCandidate('제30회 재난안전세미나 개최'), '안전세미나의 "전세"');
  assert.ok(!pc.isCandidate('지방자치인재개발원 봉사활동'), '인재개발원의 "재개발"');
  // 서울시는 규제·대책 키워드만
  assert.ok(pc.isCandidate('잠실·삼성·대치·청담 토지거래허가구역 해제', 'seoul'));
  assert.ok(!pc.isCandidate('제17차 정비사업 통합심의위원회 개최결과', 'seoul'));
});

test('같은 날 같은 제목만 합치고, 날짜가 다르면 따로 둔다', () => {
  const out = pc.pickCandidates([
    it('3', '전세 제도 개선', '2026-09-01'),
    it('1', '수도권 주택 공급', '2026-08-13', '국토교통부'),
    it('2', '수도권 주택  공급', '2026-08-13', '금융위원회'),
    it('6', '수도권 주택 공급', '2026-08-20'),
    it('4', '주택 정책'),
    it('5', '철도 안전'),
  ], new Set(['korea:4']));
  assert.deepEqual(out.map((c) => [c.date, c.links.map((l) => l.key)]), [
    ['2026-08-13', ['korea:1', 'korea:2']],
    ['2026-08-20', ['korea:6']],
    ['2026-09-01', ['korea:3']],
  ]);
});

test('회귀: 이슈 본문을 seen으로 다시 읽으면 공동 발표의 모든 글이 빠진다', () => {
  const items = [it('1', '수도권 주택 공급', '2026-08-13', '국토교통부'), it('2', '수도권 주택 공급', '2026-08-13', '금융위원회'), it('3', '전세 제도 개선', '2026-08-14')];
  const md = pc.toMarkdown(pc.pickCandidates(items), { from: '2026-08-01', to: '2026-08-14', sources: ['정책브리핑'] });
  assert.match(md, /- \[ \] 2026-08-13 · 수도권 주택 공급 — \[국토교통부\]\(https:\/\/www\.korea\.kr\/briefing\/pressReleaseView\.do\?newsId=1\) · \[금융위원회\]\([^)]*newsId=2\)/);
  const seen = pc.sourceKeys(md);
  assert.deepEqual([...seen].sort(), ['korea:1', 'korea:2', 'korea:3']);
  assert.deepEqual(pc.pickCandidates([...items, it('4', '주택 정책', '2026-08-15')], seen).map((c) => c.links[0].key), ['korea:4']);
});

test('원문 주소 → 출처 키', () => {
  assert.equal(pc.keyOf('https://www.korea.kr/news/policyNewsView.do?newsId=148970016'), 'korea:148970016');
  assert.equal(pc.keyOf('https://www.seoul.go.kr/news/news_report.do#view/469707'), 'seoul:469707');
  assert.equal(pc.keyOf('https://mediahub.seoul.go.kr/archives/2013415'), null);
});

// 페이지 순회: 응답을 흉내 내는 fetchPage
const pages = (list) => async (page) => list[page - 1] ?? { items: [], total: list[0]?.total ?? 0, broken: 0, untitled: 0 };
const pg = (total, ids, extra = {}) => ({ items: ids.map((id) => it(String(id), '제목')), total, broken: 0, untitled: 0, ...extra });

test('누락 감지: 다 읽었는지 확신할 수 없으면 실패한다', async () => {
  const F = '2026-08-01', T = '2026-08-31';
  // 정상
  assert.equal((await pc.crawlKorea(pages([pg(3, [1, 2]), pg(3, [3])]), F, T)).length, 3);
  // 정상적인 0건은 성공
  assert.deepEqual(await pc.crawlKorea(pages([pg(0, [])]), F, T), []);
  // 전체 10건인데 해석 0건 (구조 변경)
  await assert.rejects(pc.crawlKorea(pages([pg(10, [], { broken: 10 })]), F, T), /해석하지 못했습니다/);
  // 전체 10건인데 항목 자체가 안 보임
  await assert.rejects(pc.crawlKorea(pages([pg(10, [])]), F, T), /전체 10건 중 고유 글 0건/);
  // 전체 건수 없음
  await assert.rejects(pc.crawlKorea(pages([pg(null, [1])]), F, T), /전체 건수/);
  // 반복 페이지 (페이지 넘기기 고장): 같은 글이 건수를 채운 것처럼 보이지 않게
  await assert.rejects(pc.crawlKorea(pages([pg(4, [1, 2]), pg(4, [1, 2])]), F, T), /같은 글만/);
  // 일부만 반복돼 고유 글이 모자람
  await assert.rejects(pc.crawlKorea(pages([pg(4, [1, 2]), pg(4, [2, 3])]), F, T), /전체 4건 중 고유 글 3건/);
  // 페이지 상한
  await assert.rejects(pc.crawlKorea(pages([pg(9, [1]), pg(9, [2]), pg(9, [3])]), F, T, { maxPages: 2 }), /2쪽을 넘었습니다/);
  // 기간 밖의 글
  await assert.rejects(pc.crawlKorea(pages([{ ...pg(1, []), items: [it('1', '제목', '2026-07-01')] }]), F, T), /기간 밖/);
});

test('서울시는 한 페이지가 통째로 기간 이전이 되면 멈추고 기간 안의 글만 남긴다', async () => {
  const s = (id, date) => ({ ...it(String(id), '제목', date), key: `seoul:${id}` });
  const list = [
    { items: [s(5, '2026-08-20'), s(4, '2026-08-10')], total: 100, broken: 0 },
    { items: [s(3, '2026-07-31'), s(2, '2026-08-01')], total: 100, broken: 0 }, // 정렬이 어긋나도 이 페이지는 계속
    { items: [s(1, '2026-07-20'), s(0, '2026-07-10')], total: 100, broken: 0 },
    { items: [s(9, '2026-07-01')], total: 100, broken: 0 },
  ];
  let read = 0;
  const out = await pc.crawlSeoul(async (p) => { read = p; return list[p - 1]; }, '2026-08-01', '2026-08-31');
  assert.deepEqual(out.map((x) => x.id), ['5', '4', '2']);
  assert.equal(read, 3);
});
