// 월 범위 조회 + 동시성 제한. 키가 있으면 국토부 API, 없으면 데모 데이터.
const molit = require('./molit');
const demo = require('./demo');
const { kstNow } = require('./kst');

const source = () => (molit.hasKey() ? molit : demo);
const mode = () => (molit.hasKey() ? 'live' : 'demo');

// 이번 달은 신고가 거의 안 들어와서 제외, 지난달부터 거꾸로 n개월
function monthRange(n, now = kstNow()) {
  const out = [];
  let y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0-based → 지난달
  if (m === 0) { y--; m = 12; }
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}${String(m).padStart(2, '0')}`);
    if (--m === 0) { y--; m = 12; }
  }
  return out;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getRange(kind, lawd, months) {
  const yms = monthRange(months);
  const chunks = await pool(yms, 6, (ym) => source().getMonth(kind, lawd, ym));
  return { yms, rows: chunks.flat() };
}

const getMonth = (kind, lawd, ym) => source().getMonth(kind, lawd, ym);

module.exports = { getRange, getMonth, monthRange, mode, pool };
