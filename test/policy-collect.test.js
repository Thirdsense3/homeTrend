const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/policy-collect');

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

test('목록 페이지에서 글 번호·제목·날짜·부처를 읽는다', () => {
  const html = `<p>총 <strong>1,234</strong>건</p>${li('101', '「주택 신속공급 방안」 후속&middot;조치 &quot;속도&quot;', '2026-08-18', '국토교통부')}${li('102', '청약 제도 개편', '2026.11.05', '국토교통부')}`;
  const { items, total } = pc.parseList(html);
  assert.equal(total, 1234);
  assert.deepEqual(items[0], { id: '101', title: '「주택 신속공급 방안」 후속·조치 "속도"', date: '2026-08-18', dept: '국토교통부', url: 'https://www.korea.kr/briefing/pressReleaseView.do?newsId=101' });
  assert.equal(items[1].date, '2026-11-05');
});

test('형식을 모르는 페이지는 빈 목록', () => {
  assert.deepEqual(pc.parseList('<html>점검 중</html>'), { items: [], total: null });
});

test('제목 키워드로 후보를 고른다', () => {
  assert.ok(pc.isCandidate('토지거래허가구역 내 실거주 유예 연장'));
  assert.ok(pc.isCandidate('2026년 9월 가계대출 동향(잠정) 및 가계부채 점검회의 개최'));
  assert.ok(pc.isCandidate('수도권 우수 입지에 2.3만 가구 공급 추진'));
  assert.ok(!pc.isCandidate('[장관동정] 장관, 주택공급 현장 점검'));
  assert.ok(!pc.isCandidate("'26년 9월 주택통계"));
  assert.ok(!pc.isCandidate('제11차 공급망안정화위원회 개최'));
});

test('이미 본 글은 빼고, 부처 공동 발표는 하나로 합친다', () => {
  const x = (id, title, dept, date = '2026-08-13') => ({ id, title, date, dept, url: `u${id}` });
  const out = pc.pickCandidates([
    x('3', '전세 제도 개선', '국토교통부', '2026-09-01'),
    x('1', '수도권 주택 공급', '국토교통부'),
    x('2', '수도권 주택  공급', '금융위원회'),
    x('4', '주택 정책', '국토교통부'),
    x('5', '철도 안전', '국토교통부'),
  ], new Set(['4']));
  assert.deepEqual(out.map((c) => [c.id, c.depts, c.ids]), [['1', ['국토교통부', '금융위원회'], ['1', '2']], ['3', ['국토교통부'], ['3']]]);
});

test('글 번호를 문서에서 꺼내고 이슈 본문을 만든다', () => {
  assert.deepEqual([...pc.newsIds('a newsId=12 b ?newsId=34&x newsId=12')], ['12', '34']);
  const md = pc.toMarkdown([{ id: '1', title: '제목', date: '2026-08-13', depts: ['국토교통부'], url: 'https://x?newsId=1' }], { from: '2026-08-01', to: '2026-08-14' });
  assert.match(md, /- \[ \] 2026-08-13 · 국토교통부 · \[제목\]\(https:\/\/x\?newsId=1\)/);
  assert.match(md, /2026-08-01 ~ 2026-08-14/);
});
