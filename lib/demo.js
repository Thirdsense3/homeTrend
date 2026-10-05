// API 키가 없을 때 쓰는 합성 데이터. 실제 시세가 아님 — UI 확인용.
const regions = require('../data/regions.json');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)), (s >>>= 0) / 4294967296);
}
function poisson(r, lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

// 2016-01 = 0 기준 월 인덱스. 대략적인 수도권 사이클을 흉내 낸 가격 지수
function marketIndex(t) {
  const pts = [[0, 0.55], [24, 0.68], [48, 0.85], [69, 1.08], [84, 0.82], [102, 0.9], [114, 0.95], [130, 1.12]];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}
function volumeIndex(t) {
  const pts = [[0, 1], [40, 1.3], [54, 1.5], [70, 0.5], [84, 0.25], [100, 0.6], [110, 0.85], [118, 0.55], [130, 0.8]];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

const BRANDS = ['래미안', '자이', '힐스테이트', '푸르지오', '아이파크', '롯데캐슬', 'e편한세상', '더샵', 'SK뷰', '센트럴', '파크', '리버뷰'];
const DONGS = ['중앙동', '신정동', '대치동', '역삼동', '삼성동', '행복동', '푸른동', '새솔동'];

function apartments(lawd) {
  const region = regions.find((r) => r.code === lawd) || { demoBase: 3000 };
  const r = rng(hash('apts' + lawd));
  return Array.from({ length: 14 }, (_, i) => {
    const dong = DONGS[Math.floor(r() * DONGS.length)];
    const built = 1988 + Math.floor(r() * 36);
    return {
      apt: `${dong.replace('동', '')}${BRANDS[i % BRANDS.length]}${r() < 0.3 ? (Math.floor(r() * 3) + 1) + '차' : ''}`,
      seq: `${lawd}-${i}`,
      dong,
      built,
      ppy: region.demoBase * (0.7 + r() * 0.6) * (built > 2010 ? 1.15 : 1),
      size: 0.4 + r() * 1.6,
      beta: 0.7 + r() * 0.7, // 시장 대비 변동성
      areas: [59.9, 84.9, 114.8].filter(() => r() < 0.85).concat(84.9),
    };
  });
}

function genMonth(kind, lawd, ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4));
  const t = (y - 2016) * 12 + (m - 1);
  const r = rng(hash(kind + lawd + ym));
  const idx = marketIndex(t), vol = volumeIndex(t);
  const days = new Date(y, m, 0).getDate();
  const rows = [];
  for (const a of apartments(lawd)) {
    const aptIdx = 1 + (idx / marketIndex(130) - 1) * a.beta;
    const n = poisson(r, a.size * (kind === 'trade' ? vol * 1.6 : 2.6));
    for (let i = 0; i < n; i++) {
      const area = a.areas[Math.floor(r() * a.areas.length)];
      const pyeong = area / 3.305785;
      const base = a.ppy * aptIdx * pyeong * (area > 100 ? 1.05 : area < 60 ? 0.95 : 1);
      const floor = 1 + Math.floor(r() * 25);
      const date = `${y}-${String(m).padStart(2, '0')}-${String(1 + Math.floor(r() * days)).padStart(2, '0')}`;
      const common = { apt: a.apt, seq: a.seq, dong: a.dong, area, floor, date, built: a.built };
      if (kind === 'trade') {
        const price = Math.round((base * (0.93 + r() * 0.12) * (floor < 3 ? 0.93 : 1)) / 100) * 100;
        rows.push({ ...common, jibun: '', price, kind: r() < 0.1 ? '직거래' : '중개거래', canceled: false });
      } else {
        // 전세가는 매매보다 완만하게 움직인다
        const jIdx = 0.55 + (marketIndex(t) - 0.55) * 0.5;
        const deposit = Math.round((a.ppy * pyeong * jIdx * 0.62 * (0.92 + r() * 0.14)) / 100) * 100;
        const monthly = r() < 0.4 ? Math.round(50 + r() * 200) : 0;
        rows.push({ ...common, deposit: monthly ? Math.round(deposit * 0.3) : deposit, monthly });
      }
    }
  }
  return rows;
}

module.exports = { getMonth: async (kind, lawd, ym) => genMonth(kind, lawd, ym) };
