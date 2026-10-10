// 지역의 구성 보정 평당가(3개월 이동평균)를 3·6개월 앞서 예측한다.
// 학습·모델 선택·오차 범위 산정은 모두 예측 기준월까지 결과가 확정된 표본만 쓴다.
const an = require('./analyze');
const HORIZONS = [3, 6];
const MIN_HISTORY = 24;
const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const change = (log) => Math.expm1(log);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const nextMonth = (ym, n = 1) => {
  const date = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4)) - 1 + n, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
const validMonths = (yms) => yms.length > 0 && yms.every((ym, i) => /^\d{6}$/.test(ym) && Number(ym.slice(4)) >= 1 && Number(ym.slice(4)) <= 12 && (!i || nextMonth(yms[i - 1]) === ym));

function preparePanel(code, yms, trades, rents) {
  if (!validMonths(yms)) return { code, yms, snapshots: [] };
  const snapshots = [];
  // 마지막 신고 진행월은 제외. 각 과거 시점에서도 거래를 먼저 자른 뒤 보정 지수를 다시 계산한다.
  for (let origin = MIN_HISTORY - 1; origin < yms.length - 1; origin++) {
    const cutoff = yms[origin];
    const through = (r) => r.date.slice(0, 4) + r.date.slice(5, 7) <= cutoff;
    const { series, indicators: ind } = an.regionSummary(
      [...yms.slice(0, origin + 1), nextMonth(cutoff)], trades.filter(through), rents.filter(through));
    const done = series.slice(0, -1);
    if (!(ind.current > 0 && ind.volRecent >= 10) || done.slice(-24).filter((r) => r.count > 0).length < 20 ||
        [ind.chg3m, ind.chg12m, ind.volVsAvg, ind.jeonseRatio].some((v) => v == null || !Number.isFinite(v))) continue;
    const features = [Math.log1p(ind.chg3m), Math.log1p(ind.chg12m), clamp(ind.volVsAvg, -1, 3), ind.jeonseRatio];
    if (!features.every(Number.isFinite)) continue;
    snapshots.push({ code, origin, ym: cutoff, features, level: ind.current, levels: done.map((r) => r.ma) });
  }
  return { code, yms, snapshots };
}

function samplesFor(panels, horizon) {
  const samples = [];
  for (const p of panels) {
    const byOrigin = new Map(p.snapshots.map((s) => [s.origin, s]));
    for (const s of p.snapshots) {
      const future = byOrigin.get(s.origin + horizon);
      const base = future?.levels[s.origin];
      if (!(base > 0 && future.level > 0)) continue;
      samples.push({ ...s, target: Math.log(future.level / base), resolved: nextMonth(s.ym, horizon) });
    }
  }
  return samples;
}

// 작은 릿지 회귀. 표준화 통계도 매 시점의 학습 표본에서만 계산한다.
function fit(samples) {
  if (samples.length < 100) return null;
  const centers = [0, 1, 2, 3].map((j) => mean(samples.map((s) => s.features[j])));
  const scales = centers.map((c, j) => Math.sqrt(mean(samples.map((s) => (s.features[j] - c) ** 2))) || 1);
  const matrix = Array.from({ length: 5 }, () => Array(6).fill(0));
  for (const s of samples) {
    const x = [1, ...s.features.map((v, j) => (v - centers[j]) / scales[j])];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) matrix[i][j] += x[i] * x[j];
      matrix[i][5] += x[i] * s.target;
    }
  }
  // 절편은 벌점을 주지 않는다. 가중치는 미리 고정하며 검증 결과로 튜닝하지 않는다.
  for (let i = 1; i < 5; i++) matrix[i][i] += samples.length;
  for (let i = 0; i < 5; i++) {
    let pivot = i;
    for (let j = i + 1; j < 5; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    if (Math.abs(matrix[i][i]) < 1e-12) return null;
    const d = matrix[i][i];
    for (let j = i; j <= 5; j++) matrix[i][j] /= d;
    for (let k = 0; k < 5; k++) if (k !== i) {
      const factor = matrix[k][i];
      for (let j = i; j <= 5; j++) matrix[k][j] -= factor * matrix[i][j];
    }
  }
  return { centers, scales, weights: matrix.map((row) => row[5]), trainedThrough: samples.map((s) => s.resolved).sort().pop(), sampleCount: samples.length };
}

function predict(model, s, horizon, method) {
  if (method === 'trend') return clamp(s.features[0] * horizon / 3 * 0.5, -0.5, 0.5);
  const x = [1, ...s.features.map((v, j) => (v - model.centers[j]) / model.scales[j])];
  return clamp(x.reduce((sum, v, j) => sum + v * model.weights[j], 0), -0.5, 0.5);
}
function quantile(xs, q) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length + 1) * q) - 1)] : null;
}
function metrics(rows) {
  return { sampleCount: rows.length, originCount: new Set(rows.map((r) => r.ym)).size,
    mae: mean(rows.map((r) => Math.abs(change(r.predicted) - change(r.target)))),
    baselineMae: mean(rows.map((r) => Math.abs(change(r.target)))),
    trendMae: mean(rows.map((r) => Math.abs(change(r.trend) - change(r.target)))) };
}

function evaluate(samples, horizon, latestYm) {
  // 모델 선택 6개 기준월 → 결과가 전부 확인될 때까지 embargo → 최종 검증 6개 기준월.
  const testEnd = nextMonth(latestYm, -horizon);
  const testStart = nextMonth(testEnd, -5);
  const calibrationEnd = nextMonth(testStart, -horizon);
  const calibrationStart = nextMonth(calibrationEnd, -5);
  const folds = (start, end, method) => {
    const rows = [];
    for (let ym = start; ym <= end; ym = nextMonth(ym)) {
      const model = fit(samples.filter((s) => s.resolved <= ym));
      if (!model) continue;
      for (const s of samples.filter((s) => s.ym === ym)) rows.push({ ...s,
        predicted: predict(model, s, horizon, method), trend: predict(model, s, horizon, 'trend') });
    }
    return rows;
  };
  const ridge = folds(calibrationStart, calibrationEnd, 'ridge');
  const trend = folds(calibrationStart, calibrationEnd, 'trend');
  const method = metrics(ridge).mae <= metrics(trend).mae ? 'ridge' : 'trend';
  const calibration = method === 'ridge' ? ridge : trend;
  const width = quantile(calibration.map((r) => Math.abs(r.predicted - r.target)), 0.8);
  const test = folds(testStart, testEnd, method);
  const report = { ...metrics(test), method, calibrationCount: calibration.length, calibrationOrigins: new Set(calibration.map((r) => r.ym)).size,
    calibrationStart, calibrationEnd, testStart, testEnd, intervalWidthLog: width,
    intervalCoverage: width == null ? null : mean(test.map((r) => Math.abs(r.target - r.predicted) <= width ? 1 : 0)) };
  const approved = report.originCount >= 6 && report.sampleCount >= 200 && report.calibrationOrigins >= 6 &&
    report.calibrationCount >= 200 && report.mae < report.baselineMae * 0.95 && report.intervalCoverage >= 0.7;
  return { report, approved, method, test, width };
}

function buildForecasts(panels, { source = 'live', missing = [], builtAt = new Date().toISOString() } = {}) {
  const result = { version: 2, source, builtAt, horizons: HORIZONS, target: '구성 보정 평당가의 3개월 이동평균 변화율',
    regions: {}, validation: {}, limitations: [
      '과거 신고일·정정·취소 이력이 없어 당시 공개된 데이터만의 검증은 아님',
      '같은 지역·인접 기준월의 표본과 여러 지역은 서로 독립적이지 않음',
      '오차 참고 범위는 과거 절대 로그 오차의 80% 분위수이며 향후 포함 확률을 보장하지 않음',
      '공급·금리·교통·정비사업 및 향후 정책 변화 미반영'] };
  const usable = panels.filter((p) => !missing.some((m) => m.startsWith(`${p.code}/`)) && validMonths(p.yms));
  const latestYm = usable.map((p) => p.yms[p.yms.length - 2]).filter(Boolean).sort().pop();
  if (source !== 'live' || !latestYm) { result.status = source === 'live' ? 'insufficient_history' : 'demo'; return result; }
  result.asOf = latestYm;
  for (const horizon of HORIZONS) {
    const samples = samplesFor(usable, horizon);
    const evaluation = evaluate(samples, horizon, latestYm);
    result.validation[horizon] = { ...evaluation.report, status: evaluation.approved ? 'passed' : 'withheld' };
    const model = fit(samples.filter((s) => s.resolved <= latestYm));
    // 최종 검증에서 포함률을 확인한 모델 선택 기간의 폭을 그대로 표시한다.
    const width = evaluation.width;
    for (const p of panels) {
      const region = (result.regions[p.code] ||= {});
      const last = p.snapshots.find((s) => s.ym === latestYm);
      let reason = missing.some((m) => m.startsWith(`${p.code}/`)) ? 'missing_data' : !last ? 'insufficient_history' :
        !evaluation.approved ? 'validation_failed' : !model || width == null ? 'insufficient_training' : null;
      const ownTest = evaluation.test.filter((s) => s.code === p.code);
      const own = metrics(ownTest);
      if (!reason && (own.sampleCount < 6 || !(own.mae < own.baselineMae))) reason = 'regional_validation_failed';
      if (reason) { region[horizon] = { status: 'withheld', reason }; continue; }
      const predicted = predict(model, last, horizon, evaluation.method);
      region[horizon] = { status: 'available', asOf: latestYm, targetYm: nextMonth(latestYm, horizon), horizon,
        change: change(predicted), lower: change(predicted - width), upper: change(predicted + width),
        method: evaluation.method, regionalMae: own.mae, regionalSamples: own.sampleCount,
        validation: result.validation[horizon], intervalSamples: evaluation.report.calibrationCount,
        intervalStart: evaluation.report.calibrationStart, intervalEnd: evaluation.report.calibrationEnd };
    }
  }
  result.status = Object.values(result.regions).some((r) => Object.values(r).some((v) => v.status === 'available')) ? 'available' : 'withheld';
  return result;
}

module.exports = { HORIZONS, preparePanel, samplesFor, fit, predict, evaluate, buildForecasts, nextMonth };
