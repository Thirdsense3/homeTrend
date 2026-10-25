// 정책 자료 (data/policies.json, 로드맵 9번). 사람이 확인한 뒤 PR로 추가하고, 빌드가 형식을 검사해 배포한다
// 날짜와 원문만 보여 준다. "정책 때문에 올랐다/내렸다" 같은 해석은 하지 않는다
//
// 항목: { id, announced, effective, ended, title, category, regions, summary, source }
//   announced  발표일 (차트 마커 기준), effective 시행일, ended 해제·종료일 (없으면 null). 지운 정책도 ended를 채워 남긴다
//   regions    'all'(전국), 묶음 이름('서울'·'경기'), 지역 코드(data/regions.json)
const CATEGORIES = ['대출', '규제지역', '토지거래허가', '세제', '공급'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// 형식이 틀리면 무엇이 틀렸는지 모아 던진다 (빌드를 멈춰 잘못된 자료가 배포되지 않게)
function validate(data, regions) {
  const errors = [];
  const codes = new Set(regions.map((r) => r.code)), groups = new Set(regions.map((r) => r.group));
  if (!data || !isDate(data.updated || '') || !Array.isArray(data.items)) throw new Error('policies.json: updated(날짜)와 items(배열)가 필요합니다');
  const ids = new Set();
  data.items.forEach((p, i) => {
    const at = `items[${i}]${p?.id ? ` (${p.id})` : ''}`;
    const bad = (msg) => errors.push(`${at}: ${msg}`);
    if (!/^[a-z0-9-]+$/.test(p.id || '')) bad('id는 영문 소문자·숫자·하이픈');
    else if (ids.has(p.id)) bad('id 중복');
    ids.add(p.id);
    if (!isDate(p.announced || '')) bad('announced는 YYYY-MM-DD');
    for (const k of ['effective', 'ended']) {
      if (p[k] != null && !isDate(p[k])) bad(`${k}는 YYYY-MM-DD 또는 null`);
    }
    if (p.ended && p.ended < (p.effective || p.announced)) bad('ended가 시작일보다 이릅니다');
    if (!p.title || typeof p.title !== 'string') bad('title 필요');
    if (!CATEGORIES.includes(p.category)) bad(`category는 ${CATEGORIES.join('·')} 중 하나`);
    if (!Array.isArray(p.regions) || !p.regions.length) bad('regions 필요');
    else p.regions.forEach((r) => { if (r !== 'all' && !groups.has(r) && !codes.has(r)) bad(`알 수 없는 지역: ${r}`); });
    if (!p.summary || typeof p.summary !== 'string') bad('summary 필요');
    if (!/^https:\/\/\S+$/.test(p.source || '')) bad('source는 https 주소');
  });
  if (errors.length) throw new Error(`policies.json 형식 오류\n  ${errors.join('\n  ')}`);
  return data;
}

// 이 지역에 해당하는 정책인지. 브라우저(public/app.js policyFor)도 같은 규칙을 쓴다
const appliesTo = (p, region) => p.regions.some((r) => r === 'all' || r === region.group || r === region.code);

module.exports = { CATEGORIES, validate, appliesTo };
