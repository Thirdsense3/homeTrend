const test = require('node:test');
const assert = require('node:assert');
const { parseXml, weekly, mergeWeekly, buyerSeries, summarize, CODES } = require('../lib/reb');
const regions = require('../data/regions.json');

test('부동산원: 모든 지역에 서로 다른 주간지수·매입자 거주지 코드가 있음', () => {
  for (const r of regions) assert.ok(CODES[r.code], `${r.name} 코드 없음`);
  const ids = Object.values(CODES);
  assert.strictEqual(new Set(ids.map((x) => x[0])).size, ids.length);
  assert.strictEqual(new Set(ids.map((x) => x[1])).size, ids.length);
});

test('parseXml: 정상 응답의 행과 오류 응답의 코드', () => {
  const ok = parseXml(`<?xml version="1.0"?><SttsApiTblData><head><list_total_count>2</list_total_count><RESULT><CODE>INFO-000</CODE><MESSAGE>정상</MESSAGE></RESULT></head>
    <row><CLS_FULLNM>서울&gt;강남구</CLS_FULLNM><DTA_VAL>99.5</DTA_VAL><WRTTIME_DESC>2026-10-05</WRTTIME_DESC></row>
    <row><CLS_FULLNM>서울&gt;강남구</CLS_FULLNM><DTA_VAL>99.1</DTA_VAL><WRTTIME_DESC>2026-09-28</WRTTIME_DESC></row></SttsApiTblData>`);
  assert.strictEqual(ok.code, 'INFO-000');
  assert.strictEqual(ok.total, 2);
  assert.strictEqual(ok.rows[0].CLS_FULLNM, '서울>강남구');
  assert.deepStrictEqual(weekly(ok.rows), [['2026-09-28', 99.1], ['2026-10-05', 99.5]]);
  const err = parseXml('<RESULT><CODE>ERROR-336</CODE><MESSAGE>최대 1,000건</MESSAGE></RESULT>');
  assert.strictEqual(err.code, 'ERROR-336');
  assert.deepStrictEqual(err.rows, []);
});

test('mergeWeekly: 매매·전세를 날짜로 맞추고 빠진 주는 null', () => {
  const w = mergeWeekly([['2026-09-28', 100], ['2026-10-05', 101]], [['2026-10-05', 100.5]]);
  assert.deepStrictEqual(w, { dates: ['2026-09-28', '2026-10-05'], sale: [100, 101], jeonse: [null, 100.5] });
});

const buyerRows = (months) => months.flatMap(([ym, total, local, seoul]) => [
  ['500001', total], ['500002', local], ['500003', 0], ['500004', seoul], ['500005', total - local - seoul],
].map(([CLS_ID, v]) => ({ CLS_ID, WRTTIME_IDTFR_ID: ym, DTA_VAL: String(v) })));

test('summarize: 외지인 비중은 최근 3개월 합, 2년 미만이면 장기 평균 없음', () => {
  const b = buyerSeries(buyerRows([['202606', 100, 60, 10], ['202607', 100, 50, 20], ['202608', 200, 90, 30]]));
  assert.deepStrictEqual(b.yms, ['202606', '202607', '202608']);
  const s = summarize({ buyers: b }).buyers;
  assert.strictEqual(s.ym, '202608');
  assert.strictEqual(s.count3m, 400);
  assert.strictEqual(s.outsideShare, (40 + 50 + 110) / 400);
  assert.strictEqual(s.seoulShare, 60 / 400);
  assert.strictEqual(s.outsideLong, null);
});

test('summarize: 장기 평균은 최근 36개월 합 기준', () => {
  const months = Array.from({ length: 40 }, (_, i) => {
    const y = 2023 + Math.floor(i / 12), m = (i % 12) + 1;
    return [`${y}${String(m).padStart(2, '0')}`, 100, i < 4 ? 0 : 50, 0]; // 36개월 창 밖 4개월은 전부 외지인
  });
  const s = summarize({ buyers: buyerSeries(buyerRows(months)) }).buyers;
  assert.strictEqual(s.outsideLong, 0.5);
});

test('summarize: 주간 지수 n주 전 대비 변화', () => {
  const sale = [100, 101, 102, 103, 104, 105], jeonse = [50, 50, 50, 50, 50, 51];
  const w = summarize({ weekly: { dates: sale.map((_, i) => `2026-09-0${i + 1}`), sale, jeonse } }).weekly;
  assert.strictEqual(w.date, '2026-09-06');
  assert.strictEqual(w.chg1w, 105 / 104 - 1);
  assert.strictEqual(w.chg4w, 105 / 101 - 1);
  assert.strictEqual(w.chg12w, null);
  assert.strictEqual(w.jeonseChg4w, 51 / 50 - 1);
});
