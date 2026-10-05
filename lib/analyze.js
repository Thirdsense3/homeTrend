// 실거래 데이터 → 월별 시계열, 추세 지표, 국면(벌집순환모형) 판단
// Node(서버·빌드)와 브라우저(정적 사이트) 양쪽에서 쓴다 → 전역 이름 충돌을 피하려고 IIFE로 감쌈
(function (root) {
  const PYEONG = 3.305785;

  const ymOf = (date) => date.slice(0, 4) + date.slice(5, 7);
  // 매매 API는 aptSeq를 주지 않고 전월세 API만 준다 → 두 데이터를 잇기 위해 동+단지명으로 묶는다
  const aptKey = (r) => `${r.dong}|${r.apt}`;
  const areaKey = (area) => String(Math.round(area));

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const round = (x, d = 0) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

  function rolling(values, w) {
    return values.map((_, i) => {
      const win = values.slice(Math.max(0, i - w + 1), i + 1).filter((v) => v != null);
      return win.length ? mean(win) : null;
    });
  }

  const isJeonse = (r) => r.monthly === 0 && r.deposit > 0;

  function groupBy(rows, fn) {
    const m = new Map();
    for (const r of rows) {
      const k = fn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }

  // 월별 시계열. valueFn: 행 → 비교 가능한 값 (평당가 또는 가격)
  function monthly(yms, trades, rents, valueFn, rentValueFn, w = 3) {
    const t = groupBy(trades, (r) => ymOf(r.date));
    const j = groupBy(rents.filter(isJeonse), (r) => ymOf(r.date));
    const rows = yms.map((ym) => {
      const tr = t.get(ym) || [];
      const jr = j.get(ym) || [];
      return {
        ym,
        count: tr.length,
        median: round(median(tr.map(valueFn))),
        jeonse: round(median(jr.map(rentValueFn))),
        jeonseCount: jr.length,
      };
    });
    const ma = rolling(rows.map((r) => r.median), w);
    const jma = rolling(rows.map((r) => r.jeonse), w);
    rows.forEach((r, i) => { r.ma = round(ma[i]); r.jeonseMa = round(jma[i]); });
    return rows;
  }

  const PHASES = {
    1: { name: '회복기', desc: '가격↑ 거래량↑', note: '상승 초입. 거래가 붙으며 가격이 오르기 시작하는 구간' },
    2: { name: '호황기', desc: '가격↑ 거래량↓', note: '상승 후반. 매물이 줄며 호가 위주로 오르는 구간 — 추격매수 주의' },
    3: { name: '침체진입', desc: '가격→ 거래량↓', note: '거래가 끊기며 가격이 멈춘 구간' },
    4: { name: '침체기', desc: '가격↓ 거래량↓', note: '하락 진행 중. 바닥 확인 전 관망 구간' },
    5: { name: '불황기', desc: '가격↓ 거래량↑', note: '급매 소진 단계. 바닥 탐색 구간 — 관심 단지 리스트업 시점' },
    6: { name: '회복진입', desc: '가격→ 거래량↑', note: '하락이 멈추고 거래가 늘어나는 구간 — 매수 검토가 많이 시작되는 시점' },
    0: { name: '보합', desc: '가격→ 거래량→', note: '뚜렷한 방향 없음' },
  };

  function phaseOf(priceChg, volChg) {
    if (priceChg == null || volChg == null) return null;
    const p = priceChg > 0.015 ? 1 : priceChg < -0.015 ? -1 : 0;
    const v = volChg > 0.15 ? 1 : volChg < -0.15 ? -1 : 0;
    let id;
    if (p > 0) id = v > 0 ? 1 : 2;
    else if (p < 0) id = v > 0 ? 5 : 4;
    else id = v > 0 ? 6 : v < 0 ? 3 : 0;
    return { id, ...PHASES[id] };
  }

  // series: monthly() 결과. 마지막 달은 신고기한(30일) 때문에 거래량이 덜 잡혀 거래량 지표에서 제외
  function indicators(series) {
    const L = series.length - 1;
    const ma = series.map((r) => r.ma);
    const at = (i) => (i >= 0 ? ma[i] : null);
    const chg = (a, b) => (a != null && b ? a / b - 1 : null);

    const cur = at(L);
    let peak = null, peakYm = null, low = null, lowYm = null;
    series.forEach((r) => {
      if (r.ma == null) return;
      if (peak == null || r.ma > peak) { peak = r.ma; peakYm = r.ym; }
    });
    // 고점 이후 저점 (고점이 마지막이면 저점 없음)
    const peakIdx = series.findIndex((r) => r.ym === peakYm);
    series.slice(peakIdx).forEach((r) => {
      if (r.ma != null && (low == null || r.ma < low)) { low = r.ma; lowYm = r.ym; }
    });

    const counts = series.slice(0, L).map((r) => r.count); // 마지막 달 제외
    const C = counts.length;
    const vRecent = mean(counts.slice(Math.max(0, C - 3)));
    const vPrev = mean(counts.slice(Math.max(0, C - 6), Math.max(0, C - 3)));
    const vLong = mean(counts.slice(Math.max(0, C - 36)));

    const last6 = series.slice(-6);
    const tMed = median(last6.map((r) => r.median).filter((v) => v != null));
    const jMed = median(last6.map((r) => r.jeonse).filter((v) => v != null));

    const priceChg3 = chg(cur, at(L - 3));
    const volChg = chg(vRecent, vPrev);
    return {
      current: round(cur),
      chg3m: round(priceChg3, 4),
      chg12m: round(chg(cur, at(L - 12)), 4),
      peak: round(peak), peakYm,
      fromPeak: round(chg(cur, peak), 4),
      low: lowYm === peakYm ? null : round(low), lowYm: lowYm === peakYm ? null : lowYm,
      fromLow: lowYm === peakYm ? null : round(chg(cur, low), 4),
      volRecent: round(vRecent, 1),
      volChg: round(volChg, 4),
      volVsAvg: round(chg(vRecent, vLong), 4),
      jeonseRatio: round(tMed && jMed ? jMed / tMed : null, 4),
      phase: phaseOf(priceChg3, volChg),
    };
  }

  const ppy = (r) => r.price / (r.area / PYEONG);
  const jppy = (r) => r.deposit / (r.area / PYEONG);

  function regionSummary(yms, trades, rents) {
    const series = monthly(yms, trades, rents, ppy, jppy);
    return { series, indicators: indicators(series) };
  }

  function mainArea(rows) {
    const g = groupBy(rows, (r) => areaKey(r.area));
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  }

  function apartmentList(trades) {
    const cutoff = (() => {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const out = [];
    for (const [key, rows] of groupBy(trades, aptKey)) {
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const area = mainArea(rows);
      const same = rows.filter((r) => areaKey(r.area) === area);
      const peakRow = same.reduce((a, b) => (b.price > a.price ? b : a));
      const recent = median(same.slice(-3).map((r) => r.price));
      const last = rows[rows.length - 1];
      out.push({
        key,
        apt: last.apt,
        dong: last.dong,
        built: last.built,
        count: rows.length,
        count12m: rows.filter((r) => r.date >= cutoff).length,
        mainArea: Number(area),
        recentPrice: recent,
        peakPrice: peakRow.price,
        peakDate: peakRow.date,
        fromPeak: round(recent / peakRow.price - 1, 4),
        ppy: round(median(same.slice(-5).map(ppy))),
        lastDate: last.date,
        lastPrice: last.price,
        lastArea: last.area,
      });
    }
    return out.sort((a, b) => b.count12m - a.count12m || b.count - a.count);
  }

  function apartmentDetail(yms, trades, rents) {
    const byArea = groupBy(trades, (r) => areaKey(r.area));
    const rentByArea = groupBy(rents, (r) => areaKey(r.area));
    const areas = [...byArea.entries()]
      .map(([area, rows]) => {
        const rr = rentByArea.get(area) || [];
        const series = monthly(yms, rows, rr, (r) => r.price, (r) => r.deposit, 6);
        return {
          area,
          count: rows.length,
          series,
          indicators: indicators(series),
          maxPrice: Math.max(...rows.map((r) => r.price)),
        };
      })
      .sort((a, b) => b.count - a.count);
    return { areas };
  }

  const api = { regionSummary, apartmentList, apartmentDetail, aptKey, areaKey, PHASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
