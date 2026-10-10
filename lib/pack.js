// 지역 실거래 데이터를 브라우저로 보내기 위한 압축 포맷
// 단지 정보는 한 번만 두고, 거래는 숫자 배열로. 월세는 화면에서 쓰지 않아 제외(전세만).
//   apts: [[동, 단지명, 준공연도, 지번]]
//   names: 원본 명칭 목록 (v2). 대표 단지로 연결해도 거래별 원본을 보존한다
//   t:    [[단지idx, yyyymmdd, 전용면적×100, 층, 거래가(만원), 직거래?1:0, 원본명idx]]
//   j:    [[단지idx, yyyymmdd, 전용면적×100, 층, 보증금(만원), 원본명idx]]
const dateInt = (d) => Number(d.replace(/-/g, ''));

function pack(yms, trades, rents) {
  const apts = [];
  const names = [];
  const nameIndex = new Map();
  const source = (r) => {
    const name = r.sourceApt || r.apt;
    if (!nameIndex.has(name)) { nameIndex.set(name, names.length); names.push(name); }
    return nameIndex.get(name);
  };
  const index = new Map();
  const idx = (r) => {
    const k = `${r.dong}|${r.apt}`;
    if (!index.has(k)) {
      index.set(k, apts.length);
      apts.push([r.dong, r.apt, r.built || 0, r.jibun || '']);
    } else if (r.jibun && !apts[index.get(k)][3]) {
      apts[index.get(k)][3] = r.jibun;
    }
    return index.get(k);
  };
  const t = trades.map((r) => [idx(r), dateInt(r.date), Math.round(r.area * 100), r.floor, r.price, r.kind === '직거래' ? 1 : 0, source(r)]);
  const j = rents
    .filter((r) => r.monthly === 0 && r.deposit > 0)
    .map((r) => [idx(r), dateInt(r.date), Math.round(r.area * 100), r.floor, r.deposit, source(r)]);
  return { v: 2, yms, apts, names, t, j };
}

module.exports = { pack };
