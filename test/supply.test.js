const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const supply = require('../lib/supply');
const regions = require('../data/regions.json');

const meta = { asOf: '2026-06-30', updated: '2026-08-28', source: 'https://www.data.go.kr/data/15111714/fileData.do' };
const HEAD = '﻿입주예정월,지역,사업유형,주소,아파트명,세대수\r\n';
const csv = (...rows) => HEAD + rows.join('\r\n') + '\r\n';
const run = (...rows) => supply.build(meta, csv(...rows), regions);

test('저장소의 입주 예정 자료가 형식을 지키고 추적 지역에 붙는다', () => {
  const d = supply.build(require('../data/supply.json'), fs.readFileSync(path.join(__dirname, '..', 'data', 'supply.csv'), 'utf8'), regions);
  assert.ok(d.kept > 0);
  assert.deepEqual(Object.keys(d.regions).sort(), regions.map((r) => r.code).sort());
});

test('지역 이름 → 주소 앞부분', () => {
  const by = (name) => supply.regionPrefix(regions.find((r) => r.name === name));
  assert.equal(by('강남구'), '서울특별시 강남구');
  assert.equal(by('성남 분당구 (판교)'), '경기도 성남시 분당구');
  assert.equal(by('과천시'), '경기도 과천시');
  assert.equal(by('화성 동탄구'), '경기도 화성시 동탄구');
});

test('따옴표 안 쉼표, 지역 연결, 위치에서 지번·택지 블록 빼기', () => {
  const d = run(
    '2027-12,경기,분양,경기도 안양시 동안구 비산동 354-10,"평촌자이 퍼스니티 (1,2단지)",2737',
    '2027-05,경기,임대,경기도 의왕시 포일동(의왕청계2 A1),의왕청계2 A1 ,500',
    '2028-04,경기,분양,경기도 남양주시 진접읍 내각리 0-0,남양주진접2B1(공공분양),260',
    '2027-01,서울,분양,서울특별시 중구 신당동 산 1-2,신당 단지,100',
  );
  const anyang = regions.find((r) => r.name.startsWith('안양 동안구')).code;
  assert.deepEqual(d.regions[anyang], [{ ym: '2027-12', type: '분양', name: '평촌자이 퍼스니티 (1,2단지)', units: 2737, loc: '비산동' }]);
  const uiwang = d.regions[regions.find((r) => r.name === '의왕시').code];
  assert.equal(uiwang[0].loc, '포일동');
  assert.equal(uiwang[0].name, '의왕청계2 A1');
  assert.equal(d.regions[regions.find((r) => r.name === '남양주시').code][0].loc, '진접읍 내각리');
  assert.equal(d.regions['11140'][0].loc, '신당동');
  assert.deepEqual(d.regions[regions.find((r) => r.name === '중랑구').code], []); // 중구가 중랑구와 섞이지 않는다
  assert.equal(d.kept, 4);
});

test('추적하지 않는 시도·시군·구는 버리고, 추적하는 시인데 안 붙으면 오류', () => {
  const d = run(
    '2027-01,부산,분양,부산광역시 해운대구 우동 1-1,부산 단지,300',
    '2027-01,경기,분양,경기도 부천시 소사구 괴안동 0-0,부천 단지,200',
    '2027-01,경기,분양,경기도 용인시 처인구 남동 1-1,처인 단지,200',
  );
  assert.equal(d.kept, 0);
  assert.equal(d.dropped, 3);
  // 구 신설 전 주소(구 이름 없음), 서울인데 구가 틀린 주소
  assert.throws(() => run('2027-01,경기,분양,경기도 화성시 동탄동 1-1,동탄 단지,300'), /2행: 추적 지역의 시인데/);
  assert.throws(() => run('2027-01,서울,분양,서울특별시 없는구 어느동 1-1,단지,300'), /추적 지역의 시인데/);
});

test('형식 오류는 행과 이유를 모아 알린다', () => {
  assert.throws(() => supply.build({ ...meta, asOf: '2026-6-30' }, csv(), regions), /asOf/);
  assert.throws(() => supply.build(meta, '월,지역\n', regions), /머리글/);
  assert.throws(() => run('2027-13,서울,분양,서울특별시 강남구 역삼동 1,a,100'), /입주예정월/);
  assert.throws(() => run('2027-01,서울,기타,서울특별시 강남구 역삼동 1,a,100'), /사업유형/);
  assert.throws(() => run('2027-01,서울,분양,서울특별시 강남구 역삼동 1,a,0'), /세대수/);
  assert.throws(() => run('2027-01,서울,분양,서울특별시 강남구 역삼동 1,a'), /열이 5개/);
  assert.throws(() => run('2027-01,서울,분양,서울특별시 강남구 역삼동 1,"a,100'), /따옴표/);
  assert.throws(() => run('2027-01,서울,기타,서울특별시 강남구 역삼동 1,a,100', 'x,서울,분양,서울특별시 강남구 역삼동 1,a,1'), (e) => /2행/.test(e.message) && /3행/.test(e.message));
});

test('배포: 이번 달 이전은 빼고, 월 미정(YYYY-00)은 그해까지 남긴다', () => {
  const d = run(
    '2026-10,서울,분양,서울특별시 강남구 역삼동 1,지난달,100',
    '2026-11,서울,분양,서울특별시 강남구 역삼동 1,이번달,100',
    '2026-00,서울,분양,서울특별시 강남구 역삼동 1,올해 미정,100',
    '2027-00,서울,임대,서울특별시 강남구 역삼동 1,내년 미정,100',
  );
  const p = supply.publish(d, '2026-11');
  assert.deepEqual(p.regions['11680'].map((x) => x.name), ['올해 미정', '이번달', '내년 미정']);
  assert.equal(p.past, 1);
  assert.equal(supply.publish(d, '2027-01').regions['11680'].map((x) => x.name).join(), '내년 미정');
  assert.equal(p.asOf, '2026-06-30');
});

test('새 파일 확인 이슈: 포털 수정일이 늦을 때 한 번만', () => {
  assert.equal(supply.portalUpdated('- 등록일: 2023-01-05\n- 수정일: 2027-02-27\n'), '2027-02-27');
  assert.equal(supply.portalUpdated('수정일 없음'), null);
  assert.equal(supply.updateIssue(meta, '2026-08-28'), null);
  assert.equal(supply.updateIssue(meta, null), null);
  const issue = supply.updateIssue(meta, '2027-02-27');
  assert.match(issue.title, /2027-02-27/);
  assert.ok(supply.markersIn(issue.body).has(issue.marker));
  assert.equal(supply.updateIssue(meta, '2027-02-27', supply.markersIn(issue.body)), null);
});
