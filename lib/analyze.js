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

  // 같은 단지·같은 날 직거래가 이만큼 몰리면 임대주택 통매각 같은 일괄 거래로 본다 → 시세·거래량 계산에서 뺀다.
  // 전세도 같은 날 이만큼 몰리면 공공임대 일괄 계약 같은 것으로 보고 지역 전세 시세에서 뺀다.
  // 입력은 브라우저가 캐시해 여러 화면에서 같이 쓰므로 고치지 않고, bulk 표시를 붙인 사본을 돌려준다
  const BULK_MIN = 10;
  function markBulk(rows, candidate = (r) => r.kind === '직거래') {
    const n = new Map();
    const k = (r) => `${aptKey(r)}|${r.date}`;
    for (const r of rows) if (candidate(r)) n.set(k(r), (n.get(k(r)) || 0) + 1);
    return rows.map((r) => ({ ...r, bulk: candidate(r) && n.get(k(r)) >= BULK_MIN }));
  }
  const marketOnly = (trades) => markBulk(trades).filter((r) => !r.bulk);
  // 한국 시간 기준 오늘 (YYYY-MM-DD). lib/kst.js와 같은 계산 — 이 파일은 브라우저에서도 돌아 require를 못 쓴다
  const kstToday = (ms = Date.now()) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

  // 단지 구성 보정: log(값) = 단지·평형 효과 + 월 효과 를 교대로 풀어 월 효과만 남긴다
  // 비싼 단지 거래가 몰린 달에 평당가가 튀는 것(구성 효과)을 없앤다. 거래 없는 달은 null
  // 교대 풀이는 거래가 드문 지역(단지·월 연결이 약함)에서 느리게 수렴한다 → 월 효과 변화가 tol 아래가 될 때까지 반복
  function mixIndex(yms, rows, valueFn, maxIters = 200, tol = 1e-6) {
    const mi = new Map(yms.map((ym, i) => [ym, i]));
    const gi = new Map();
    const obs = [];
    for (const r of rows) {
      const t = mi.get(ymOf(r.date));
      const v = valueFn(r);
      if (t == null || !(v > 0)) continue;
      const g = `${aptKey(r)}|${areaKey(r.area)}`;
      if (!gi.has(g)) gi.set(g, gi.size);
      obs.push([gi.get(g), t, Math.log(v)]);
    }
    const c = new Float64Array(gi.size), cn = new Float64Array(gi.size);
    const m = new Float64Array(yms.length), mn = new Float64Array(yms.length);
    for (let k = 0; k < maxIters; k++) {
      c.fill(0); cn.fill(0);
      for (const [g, t, y] of obs) { c[g] += y - m[t]; cn[g]++; }
      for (let g = 0; g < c.length; g++) c[g] /= cn[g];
      const sum = new Float64Array(yms.length);
      mn.fill(0);
      for (const [g, t, y] of obs) { sum[t] += y - c[g]; mn[t]++; }
      let diff = 0;
      for (let t = 0; t < m.length; t++) {
        const v = mn[t] ? sum[t] / mn[t] : 0;
        diff = Math.max(diff, Math.abs(v - m[t]));
        m[t] = v;
      }
      if (diff < tol) break;
    }
    return Array.from(m, (x, t) => (mn[t] ? Math.exp(x) : null));
  }

  // series[key](원래 이동평균)를 보정 지수의 이동평균으로 바꾼다.
  // 수준은 최근 6개 완성월에서 원래 이동평균과 같아지도록 맞춘다 (현재 시세 수준은 그대로, 과거 흐름만 보정)
  function applyMix(series, key, idx, w) {
    const adj = rolling(idx, w);
    const end = Math.max(1, series.length - 1); // 마지막 달(신고 진행 중) 제외
    const pairs = series.slice(Math.max(0, end - 6), end).map((r, i) => [r[key], adj[Math.max(0, end - 6) + i]])
      .filter(([a, b]) => a != null && b != null);
    if (!pairs.length) return;
    const k = mean(pairs.map(([a]) => a)) / mean(pairs.map(([, b]) => b));
    series.forEach((r, i) => { r[key] = adj[i] == null ? null : round(adj[i] * k); });
  }

  // series: monthly() 결과. 마지막 달은 신고기한(30일) 때문에 덜 잡혀 가격·거래량 지표 모두 직전 달까지로 계산
  function indicators(series) {
    const L = series.length - 1;
    const E = Math.max(0, L - 1); // 마지막 완성월
    const ma = series.map((r) => r.ma);
    const at = (i) => (i >= 0 ? ma[i] : null);
    const chg = (a, b) => (a != null && b ? a / b - 1 : null);

    const done = series.slice(0, E + 1);
    const cur = at(E);
    let peak = null, peakYm = null, low = null, lowYm = null;
    done.forEach((r) => {
      if (r.ma == null) return;
      if (peak == null || r.ma > peak) { peak = r.ma; peakYm = r.ym; }
    });
    // 고점 이후 저점 (고점이 마지막이면 저점 없음)
    const peakIdx = done.findIndex((r) => r.ym === peakYm);
    done.slice(peakIdx).forEach((r) => {
      if (r.ma != null && (low == null || r.ma < low)) { low = r.ma; lowYm = r.ym; }
    });

    const counts = series.slice(0, L).map((r) => r.count); // 마지막 달 제외
    const C = counts.length;
    const vRecent = mean(counts.slice(Math.max(0, C - 3)));
    const vPrev = mean(counts.slice(Math.max(0, C - 6), Math.max(0, C - 3)));
    // 장기 기준은 중위값: 한두 번 거래가 몰린 달이 기준을 끌어올리지 않게
    const vLong = median(counts.slice(Math.max(0, C - 36)));

    const last6 = done.slice(-6);
    const tMed = median(last6.map((r) => r.median).filter((v) => v != null));
    const jMed = median(last6.map((r) => r.jeonse).filter((v) => v != null));

    const priceChg3 = chg(cur, at(E - 3));
    const volChg = chg(vRecent, vPrev);
    // 국면의 거래량은 장기 평균 대비로 본다. 직전 3개월 대비는 그 사이 거래가 한 번 몰리면 전부 '거래↓'로 쏠린다
    const volVsAvg = chg(vRecent, vLong);
    return {
      current: round(cur),
      currentYm: series[E]?.ym || null,
      chg3m: round(priceChg3, 4),
      chg12m: round(chg(cur, at(E - 12)), 4),
      peak: round(peak), peakYm,
      fromPeak: round(chg(cur, peak), 4),
      low: lowYm === peakYm ? null : round(low), lowYm: lowYm === peakYm ? null : lowYm,
      fromLow: lowYm === peakYm ? null : round(chg(cur, low), 4),
      volRecent: round(vRecent, 1),
      volLong: round(vLong, 1),
      volChg: round(volChg, 4),
      volVsAvg: round(volVsAvg, 4),
      jeonseRatio: round(tMed && jMed ? jMed / tMed : null, 4),
      phase: phaseOf(priceChg3, volVsAvg),
    };
  }

  // 거래 온도: 같은 단지·평형의 이전 거래와 비교해 신고가·상승·하락 거래를 월별로 센다.
  // 이전 거래가 없는 첫 거래는 비교 대상이 없어 세지 않는다
  function tradeHeat(trades) {
    const prev = new Map();
    const out = new Map();
    for (const r of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
      const k = `${aptKey(r)}|${areaKey(r.area)}`;
      const p = prev.get(k);
      if (!p) { prev.set(k, { max: r.price, last: r.price }); continue; }
      const ym = ymOf(r.date);
      if (!out.has(ym)) out.set(ym, { n: 0, high: 0, up: 0, down: 0 });
      const o = out.get(ym);
      o.n++;
      if (r.price > p.max) o.high++;
      if (r.price > p.last) o.up++;
      else if (r.price < p.last) o.down++;
      p.max = Math.max(p.max, r.price);
      p.last = r.price;
    }
    return out;
  }
  // 조회 시작 직후엔 비교할 이전 거래가 적어 신고가가 부풀려진다 → 처음 이만큼은 비워 둔다
  const HEAT_WARMUP = 12;
  const share = (a, n) => (n >= 10 ? round(a / n, 4) : null);

  const ppy = (r) => r.price / (r.area / PYEONG);
  const jppy = (r) => r.deposit / (r.area / PYEONG);

  function regionSummary(yms, trades, rents) {
    const marked = markBulk(trades);
    const mkt = marked.filter((r) => !r.bulk);
    const jeonse = markBulk(rents.filter(isJeonse), () => true).filter((r) => !r.bulk);
    const series = monthly(yms, mkt, jeonse, ppy, jppy);
    applyMix(series, 'ma', mixIndex(yms, mkt, ppy), 3);
    applyMix(series, 'jeonseMa', mixIndex(yms, jeonse, jppy), 3);
    const bulk = groupBy(marked.filter((r) => r.bulk), (r) => ymOf(r.date));
    const heat = tradeHeat(mkt);
    series.forEach((r, i) => {
      r.bulk = bulk.get(r.ym)?.length || 0;
      const h = i >= HEAT_WARMUP && heat.get(r.ym);
      r.newHigh = h ? share(h.high, h.n) : null;
      r.upShare = h ? share(h.up, h.n) : null;
      r.downShare = h ? share(h.down, h.n) : null;
    });
    // 최근 3개 완성월 합산
    const h3 = { n: 0, high: 0, up: 0, down: 0 };
    for (let i = Math.max(HEAT_WARMUP, series.length - 4); i < series.length - 1; i++) {
      const h = heat.get(series[i].ym);
      if (h) for (const k in h3) h3[k] += h[k];
    }
    // 국면 지도 궤적: 3·6개월 전 시점에서 본 위치
    const trail = [6, 3].map((back) => {
      const x = series.length - back > 1 ? indicators(series.slice(0, series.length - back)) : null;
      return x && x.chg3m != null && x.volVsAvg != null ? { ym: x.currentYm, chg3m: x.chg3m, volVsAvg: x.volVsAvg } : null;
    }).filter(Boolean);
    // 직거래 비율 (최근 3개 완성월): 가족 간 거래처럼 시세와 동떨어진 거래가 섞일 여지
    const recent = new Set(series.slice(-4, -1).map((r) => r.ym));
    const rec = mkt.filter((r) => recent.has(ymOf(r.date)));
    const directShare = rec.length ? round(rec.filter((r) => r.kind === '직거래').length / rec.length, 4) : null;
    return {
      series,
      indicators: {
        ...indicators(series), directShare, trail,
        newHighShare: share(h3.high, h3.n), upShare: share(h3.up, h3.n), downShare: share(h3.down, h3.n),
      },
    };
  }

  function mainArea(rows) {
    const g = groupBy(rows, (r) => areaKey(r.area));
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  }

  function apartmentList(trades) {
    const today = kstToday();
    const cutoff = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`; // 1년 전 (문자열 비교용)
    const marked = markBulk(trades);
    const bulk = groupBy(marked.filter((r) => r.bulk), aptKey);
    const out = [];
    for (const [key, rows] of groupBy(marked.filter((r) => !r.bulk), aptKey)) {
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
        bulk: bulk.get(key)?.length || 0,
      });
    }
    return out.sort((a, b) => b.count12m - a.count12m || b.count - a.count);
  }

  function apartmentDetail(yms, trades, rents) {
    trades = marketOnly(trades);
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

  // 단지 검색 목록: [[동, 단지명, 거래 수]], 거래 많은 순
  function searchEntries(trades) {
    const m = new Map();
    for (const r of trades) {
      const e = m.get(aptKey(r));
      if (e) e[2]++;
      else m.set(aptKey(r), [r.dong, r.apt, 1]);
    }
    return [...m.values()].sort((a, b) => b[2] - a[2]);
  }

  const api = { searchEntries, regionSummary, apartmentList, apartmentDetail, markBulk, aptKey, areaKey, PHASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
