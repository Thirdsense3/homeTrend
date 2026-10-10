// 빌드된 지역 JSON으로 과거 시점 점수와 이후 가격 변화의 관계를 탐색한다.
// node scripts/evaluate-candidates.js [데이터 디렉터리=dist/data] [예측기간(개월)=60]
// 각 시점 점수에는 그 시점까지의 거래만 사용한다. 결과는 예측 보증이 아니다.
const fs = require('fs');
const path = require('path');
const an = require('../lib/analyze');
const root = process.argv[2] || path.join(__dirname, '..', 'dist', 'data');
const horizon = Number(process.argv[3] || 60);
if (!Number.isInteger(horizon) || horizon < 1) throw new Error('예측기간은 양의 정수 개월이어야 합니다');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'));
if (meta.source !== 'live') throw new Error('실데이터 빌드만 평가할 수 있습니다 (데모 데이터 제외)');
const date = (n) => { const s = String(n); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; };
const samples = [];
let skippedMissing = 0;
for (const r of meta.regions) {
  if ((meta.missing || []).some((m) => m.startsWith(`${r.code}/`))) { skippedMissing++; continue; }
  const file = fs.existsSync(path.join(root, 'region', `${r.code}.json`)) ? path.join(root, 'region', `${r.code}.json`) : path.join(root, `${r.code}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = an.normalizeRows(r.code, p.t.map(([i,d,a,f,price,direct]) => ({dong:p.apts[i][0],apt:p.apts[i][1],jibun:p.apts[i][3],date:date(d),area:a/100,floor:f,price,kind:direct?'직거래':'중개거래'})));
  const j = an.normalizeRows(r.code, p.j.map(([i,d,a,f,deposit]) => ({dong:p.apts[i][0],apt:p.apts[i][1],jibun:p.apts[i][3],date:date(d),area:a/100,floor:f,deposit,monthly:0})));
  // 완성월36개 + 신고 중인 마지막 달 하나를 포함한 시점부터, 6개월 간격.
  for (let n = 37; n + horizon <= p.yms.length; n += 6) {
    const yms = p.yms.slice(0, n);
    const through = yms[n-1];
    const ym = (x) => x.date.slice(0,4)+x.date.slice(5,7);
    const historical = an.regionSummary(yms,t.filter((x)=>ym(x)<=through),j.filter((x)=>ym(x)<=through));
    const candidate = an.candidateScore(historical.indicators,historical.series);
    if (!candidate) continue;
    // 실현 변화는 이후 시점까지의 동일 보정 지수에서 같은 두 달을 비교한다.
    const futureYms = p.yms.slice(0,n+horizon);
    const end = futureYms[futureYms.length-1];
    const future = an.regionSummary(futureYms,t.filter((x)=>ym(x)<=end),j.filter((x)=>ym(x)<=end));
    const baseline = future.series[n-2].ma;
    const target = future.series[n+horizon-2].ma;
    if (!(baseline > 0 && target > 0)) continue;
    samples.push({code:r.code,asOf:candidate.asOf,score:candidate.score,change:target/baseline-1});
  }
}
const mean = (rows) => rows.length ? rows.reduce((s,r)=>s+r.change,0)/rows.length : null;
const byScore = [...samples].sort((a,b)=>b.score-a.score);
const quarter = Math.ceil(samples.length/4);
console.log(JSON.stringify({ horizonMonths:horizon, sampleCount:samples.length, skippedMissing,
  status:samples.length ? 'exploratory' : 'insufficient_history',
  meanReturn:mean(samples), topQuarterReturn:mean(byScore.slice(0,quarter)), bottomQuarterReturn:mean(quarter ? byScore.slice(-quarter) : []),
  limitations:['실험 가중치; 보정·확률 교정 없음','동일 지역의 중첩 기간은 독립 표본이 아님','상위/하위 평균은 시점별 순위가 아닌 전체 표본 요약','공급·교통·정비사업 미반영','전용면적 구성이 바뀌는 경우 보정 지수에도 추정 오차가 있음']
},null,2));
