// 입주 예정 물량 (로드맵 20번). 한국부동산원 '주택공급정보_입주예정물량정보' 반기 CSV를 사람이 받아
// data/supply.csv에 두고, 기준일·수정일을 data/supply.json에 적는다. 빌드가 형식을 검사하고 지역별로 묶어 배포한다.
// 한국부동산원·부동산R114의 추정치라 기준일 뒤의 공사 중단·일정 변경은 반영되지 않는다. 화면에 기준일과 '추정치'를 적는다.
//
// CSV 열: 입주예정월(YYYY-MM, 월 미정이면 YYYY-00), 지역(시도 약칭), 사업유형(분양·임대·분양임대), 주소(지번), 아파트명, 세대수
// 주소의 '시도 시군 구' 앞부분을 지역 이름(data/regions.json)과 맞춘다. 추적하지 않는 시·군의 행은 버린다.
const HEADER = ['입주예정월', '지역', '사업유형', '주소', '아파트명', '세대수'];
const TYPES = ['분양', '임대', '분양임대'];
const SIDO = { 서울: '서울특별시', 경기: '경기도' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// 'YYYY-00'은 그해 중 입주 예정이지만 월이 정해지지 않은 행이다 (2026-06 기준 파일에 2건). 월별 막대에는 넣지 않고 목록에 '월 미정'으로 둔다
const isYm = (s) => /^\d{4}-(0\d|1[0-2])$/.test(s);

// 따옴표(쉼표가 든 아파트명)를 지원하는 CSV 파서. BOM과 CRLF를 처리한다
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (q) throw new Error('supply.csv: 닫히지 않은 따옴표');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 지역 이름 → 주소 앞부분. '성남 분당구 (판교)' → '경기도 성남시 분당구', '과천시' → '경기도 과천시', '강남구' → '서울특별시 강남구'
function regionPrefix(region) {
  const parts = region.name.replace(/\s*\(.+\)$/, '').split(/\s+/);
  if (parts.length === 2) parts[0] += '시';
  return [SIDO[region.group], ...parts].join(' ');
}

// 주소에서 지역 앞부분을 뺀 위치(법정동·읍면리). 지번과 택지 블록 표시는 뺀다
// '포일동(의왕청계2 A1)' 처럼 괄호 앞에 공백이 없는 경우도 있다
function locality(rest) {
  const out = [];
  for (const t of rest.replace(/\(.*$/, '').trim().split(/\s+/)) {
    if (!t || t === '산' || /^\d/.test(t)) break;
    out.push(t);
  }
  return out.join(' ');
}

// 형식 검사 + 지역 연결. 틀리면 무엇이 틀렸는지 모아 던진다 (빌드를 멈춰 잘못된 자료가 배포되지 않게)
// 추적하는 시(예: 성남시)의 행인데 어느 지역에도 붙지 않으면(구 이름이 바뀌는 등) 오류로 본다. 조용히 빠지지 않게
function build(meta, csv, regions) {
  const errors = [];
  if (!meta || !isDate(meta.asOf || '') || !isDate(meta.updated || '') || !/^https:\/\/\S+$/.test(meta.source || '')) {
    throw new Error('supply.json: asOf·updated(YYYY-MM-DD)와 source(https 주소)가 필요합니다');
  }
  const rows = parseCsv(csv);
  const head = (rows.shift() || []).map((h) => h.trim());
  if (head.join(',') !== HEADER.join(',')) throw new Error(`supply.csv: 머리글이 ${HEADER.join(',')} 이어야 합니다 (받은 것: ${head.join(',')})`);
  const tracked = regions.filter((r) => SIDO[r.group]).map((r) => ({ code: r.code, prefix: regionPrefix(r) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  // 구로 나눠 추적하는 시(성남·화성 등). 이 시의 주소인데 구 이름이 없으면(구 신설 전 주소 등) 오류.
  // 추적하지 않는 구(용인 처인구 등)는 버린다. 서울은 25개 구를 모두 추적하므로 안 붙으면 오류
  const guCities = new Set(tracked.filter((t) => t.prefix.split(' ').length === 3 && !t.prefix.startsWith(SIDO.서울)).map((t) => t.prefix.split(' ').slice(0, 2).join(' ')));
  const unmatchedIsError = (a) => {
    const p = a.split(' ');
    return p[0] === SIDO.서울 || (guCities.has(`${p[0]} ${p[1]}`) && !/구$/.test(p[2] || ''));
  };
  const out = {};
  for (const r of regions) out[r.code] = [];
  let kept = 0, dropped = 0;
  rows.forEach((cols, i) => {
    const at = `${i + 2}행`;
    if (cols.length !== HEADER.length) { errors.push(`${at}: 열이 ${cols.length}개 (6개여야 함)`); return; }
    const [ym, sido, type, addr, name, units] = cols.map((c) => c.trim());
    if (!isYm(ym)) errors.push(`${at}: 입주예정월 '${ym}'은 YYYY-MM(월 미정은 YYYY-00)이어야 함`);
    if (!TYPES.includes(type)) errors.push(`${at}: 사업유형 '${type}'은 ${TYPES.join('·')} 중 하나`);
    if (!/^[1-9]\d*$/.test(units)) errors.push(`${at}: 세대수 '${units}'는 양의 정수`);
    if (!name) errors.push(`${at}: 아파트명 없음`);
    if (!SIDO[sido]) { dropped++; return; }
    const addrN = addr.replace(/\s+/g, ' ');
    const hit = tracked.find((t) => addrN === t.prefix || addrN.startsWith(`${t.prefix} `));
    if (!hit) {
      if (unmatchedIsError(addrN)) errors.push(`${at}: 추적 지역의 시인데 어느 지역에도 맞지 않는 주소 '${addr}'`);
      dropped++;
      return;
    }
    out[hit.code].push({ ym, type, name: name.replace(/\s+/g, ' '), units: Number(units), loc: locality(addrN.slice(hit.prefix.length)) });
    kept++;
  });
  if (errors.length) throw new Error(`supply.csv 형식 오류 (${errors.length}건)\n  ${errors.slice(0, 30).join('\n  ')}`);
  for (const list of Object.values(out)) list.sort((a, b) => a.ym.localeCompare(b.ym) || b.units - a.units || a.name.localeCompare(b.name));
  return { asOf: meta.asOf, updated: meta.updated, source: meta.source, kept, dropped, regions: out };
}

// 배포용: fromYm(이번 달, YYYY-MM) 이전 입주 예정은 이미 입주했거나 미뤄졌을 수 있어 뺀다. 뺀 건수는 남긴다
function publish(data, fromYm) {
  const regions = {};
  let past = 0;
  for (const [code, list] of Object.entries(data.regions)) {
    // 월 미정(YYYY-00)은 그해가 끝나기 전까지 남긴다
    regions[code] = list.filter((x) => (x.ym.endsWith('-00') ? x.ym.slice(0, 4) >= fromYm.slice(0, 4) : x.ym >= fromYm));
    past += list.length - regions[code].length;
  }
  return { v: 1, asOf: data.asOf, updated: data.updated, source: data.source, from: fromYm, past, regions };
}

// 공공데이터포털 상세 페이지(?format=md)의 '수정일'. 새 반기 파일이 올라왔는지 확인할 때 쓴다
function portalUpdated(md) {
  const m = String(md).match(/수정일:\s*(\d{4}-\d{2}-\d{2})/);
  return m && isDate(m[1]) ? m[1] : null;
}

// 새 파일 확인 이슈 (scripts/supply-check.js). 포털 수정일이 저장소 자료의 수정일보다 늦으면 한 번 연다.
// 표시(marker)에 포털 수정일이 들어가므로 같은 수정본으로는 다시 열지 않는다. 내려받기는 사람이 한다
// (파일 id가 반기마다 바뀌고, 받은 파일의 형식은 빌드가 검사한다)
const markerOf = (updated) => `supply-update@${updated}`;
const markersIn = (text) => new Set([...String(text).matchAll(/<!-- (supply-update@[^\s]+) -->/g)].map((m) => m[1]));
function updateIssue(meta, updated, seen = new Set()) {
  if (!updated || updated <= meta.updated) return null;
  const marker = markerOf(updated);
  if (seen.has(marker)) return null;
  return {
    marker,
    title: `입주 예정 물량: 새 파일 확인 (포털 수정일 ${updated})`,
    body: [
      `공공데이터포털의 입주예정물량정보가 **${updated}**에 수정됐어요. 저장소 자료는 ${meta.updated} 수정본(${meta.asOf} 기준)이에요.`,
      '',
      `1. ${meta.source} 에서 CSV를 받아 \`data/supply.csv\`를 바꿔요 (파일 이름 끝의 날짜가 새 기준일이에요)`,
      `2. \`data/supply.json\`의 \`asOf\`(기준일)와 \`updated\`(${updated})를 고쳐요`,
      '3. `npm test`와 빌드로 형식 검사를 통과하는지 확인하고, PR 본문에 `Closes #이 이슈 번호`',
      '',
      '빌드가 머리글·입주예정월·사업유형·세대수와 지역 연결(추적하는 시의 주소가 어느 지역에도 안 붙으면 오류)을 검사해요.',
      '',
      `<!-- ${marker} -->`,
    ].join('\n') + '\n',
  };
}

module.exports = { HEADER, TYPES, parseCsv, regionPrefix, locality, build, publish, portalUpdated, markerOf, markersIn, updateIssue };
