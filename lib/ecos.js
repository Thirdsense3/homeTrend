// 한국은행 경제통계시스템(ECOS) Open API 클라이언트: 금리·주택가격 전망 심리 (전국, 월별)
const https = require('https');

// [통계표 코드, 주기, 항목 코드1, 항목 코드2]
const SERIES = [
  { id: 'baseRate', name: '기준금리', unit: '%', path: ['722Y001', 'M', '0101000'] },
  { id: 'mortgageRate', name: '주택담보대출 금리', unit: '%', path: ['121Y006', 'M', 'BECBLA0302'] },
  { id: 'jeonseLoanRate', name: '전세자금대출 금리', unit: '%', path: ['121Y006', 'M', 'BECBLA03041'] },
  { id: 'housingCsi', name: '주택가격전망 CSI', unit: '', path: ['511Y002', 'M', 'FMFB', '99988'] },
];

const apiKey = () => (process.env.ECOS_API_KEY || '').trim();

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error(`ECOS 응답 형식 오류: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ECOS 요청 시간 초과')));
    req.on('error', reject);
  });
}

// 한 계열의 [ym, 값] 목록. 데이터가 없는 기간이면 빈 배열
async function fetchSeries(s, from, to) {
  const [stat, cycle, ...items] = s.path;
  const rows = apiKey() === 'sample' ? 10 : 1000; // 공개 sample 키는 10건까지만 (개발 확인용)
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(apiKey())}/json/kr/1/${rows}/${stat}/${cycle}/${from}/${to}/${items.join('/')}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const d = await getJson(url);
      if (d.StatisticSearch) return d.StatisticSearch.row.map((r) => [r.TIME, Number(r.DATA_VALUE)]).filter(([, v]) => isFinite(v));
      if (d.RESULT?.CODE === 'INFO-200') return []; // 해당 데이터 없음
      throw new Error(`[${d.RESULT?.CODE}] ${d.RESULT?.MESSAGE}`);
    } catch (e) {
      if (attempt < 2 && !/^\[/.test(e.message)) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      throw new Error(`ECOS ${s.name}: ${e.message}`);
    }
  }
}

// { series: [{ id, name, unit, points: [[ym, v]] }], missing: [이름] } — 키가 없으면 null
async function getMacro(from, to) {
  if (!apiKey()) return null;
  const series = [], missing = [];
  for (const s of SERIES) {
    try {
      series.push({ id: s.id, name: s.name, unit: s.unit, points: await fetchSeries(s, from, to) });
    } catch (e) {
      console.warn(e.message);
      missing.push(s.name);
    }
  }
  return { series, missing };
}

module.exports = { getMacro, SERIES };
