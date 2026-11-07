// 정책 만료 전 확인 알림 (로드맵 9-1 다음 할 일 1). data/policies.json의 reviews를 보고 검토 이슈를 낸다.
// 예정 종료일이 와도 policies.json을 바꾸지 않는다. 사람이 원문에서 연장·해제를 확인한 뒤 PR로 반영한다:
//   연장 → summary 갱신 또는 새 항목, 새 기한이면 reviews에 새 항목 추가
//   종료·해제 → ended에 실제 종료일
//   어느 쪽이든 확인한 review의 done에 확인일을 적고 PR에 "Closes #이슈"
//
// 이슈마다 본문에 표시(marker)를 남겨 같은 이슈를 다시 열지 않는다. 표시에 확인 예정일이 들어가므로
// 예정일을 바꾸면 새 이슈가 열린다. 예정일이 지나도 done이 없으면 "기한 지남" 이슈를 한 번 더 연다.
const LEAD_DAYS = 45; // 주 1회 실행이라 예정일 6주 전부터 몇 번은 확인 기회가 있게

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const markerOf = (policyId, reviewId, by, stage) => `policy-review:${policyId}/${reviewId}@${by}${stage === 'overdue' ? ':overdue' : ''}`;
const markersIn = (text) => new Set([...String(text).matchAll(/<!-- (policy-review:[^\s]+) -->/g)].map((m) => m[1]));

// today 기준으로 열어야 할 이슈 목록. seen: 지난 이슈 본문의 marker 집합(열림·닫힘 모두)
function dueReviews(data, today, seen = new Set()) {
  const out = [];
  for (const p of data.items) {
    for (const r of p.reviews || []) {
      if (r.done) continue;
      const stage = today > r.by ? 'overdue' : today >= addDays(r.by, -LEAD_DAYS) ? 'upcoming' : null;
      if (!stage) continue;
      const marker = markerOf(p.id, r.id, r.by, stage);
      if (seen.has(marker)) continue;
      out.push({ marker, title: `${stage === 'overdue' ? '[기한 지남] ' : ''}정책 확인: ${p.title} (${r.by})`, body: issueBody(p, r, stage, marker) });
    }
  }
  return out;
}

function issueBody(p, r, stage, marker) {
  return [
    stage === 'overdue'
      ? `확인 예정일 **${r.by}**이 지났는데 아직 확인 완료(\`done\`)가 없어요.`
      : `확인 예정일 **${r.by}**이 다가와요.`,
    '',
    `- 정책: ${p.title} (\`${p.id}\`, ${p.announced} 발표)`,
    `- 확인할 조치: ${r.what}`,
    `- 원문: ${p.source}`,
    '',
    '원문(정책브리핑·국토부·금융위·서울시 발표)에서 연장·해제 여부를 확인하고 `data/policies.json`을 고쳐 주세요.',
    '',
    '- 연장됐으면: `summary`를 고치거나 새 항목을 넣고, 새 기한이 있으면 `reviews`에 새 확인 예정을 추가',
    '- 끝났거나 해제됐으면: `ended`에 실제 종료일',
    `- 어느 쪽이든 이 확인 예정(\`${r.id}\`)의 \`done\`에 확인한 날을 적고, PR 본문에 \`Closes #이 이슈 번호\``,
    '',
    '예정 종료일이 지났다는 것만으로 `ended`를 채우지 않아요. `ended`는 원문으로 확인한 실제 종료만 뜻해요.',
    '',
    `<!-- ${marker} -->`,
  ].join('\n') + '\n';
}

module.exports = { LEAD_DAYS, addDays, markerOf, markersIn, dueReviews };
