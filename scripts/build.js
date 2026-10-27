// 정적 사이트 빌드 (GitHub Pages용): dist/ 에 페이지 + 지역별 데이터 JSON 생성
// 사용: npm run build  (BUILD_MONTHS=60 기본, MOLIT_API_KEY 없으면 데모 데이터)
require('../lib/env');
const fs = require('fs');
const path = require('path');
const { getMonth, monthRange, currentYm, mode, pool } = require('../lib/data');
const an = require('../lib/analyze');
const { pack } = require('../lib/pack');
const forecast = require('../lib/forecast');
const { getMacro } = require('../lib/ecos');
const { getReb } = require('../lib/reb');
const ledger = require('../lib/ledger');
const ch = require('../lib/changes');
const { kstNow } = require('../lib/kst');
const policies = require('../lib/policies');
const regions = require('../data/regions.json');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MONTHS = Number(process.env.BUILD_MONTHS) || 60;
const OVERVIEW_MONTHS = 25;
// 이 비율 이상 실패하면 배포를 중단해 이전 사이트를 유지
const MAX_FAIL_RATIO = 0.05;

function write(rel, data) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return fs.statSync(file).size;
}

(async () => {
  const yms = monthRange(MONTHS);
  // 이번 달 매매도 받는다. 신고가 진행 중이라 지역 지표·예측·차트에는 넣지 않고(yms 밖),
  // 거래 이력·피드·관심단지에서 '이번 달 · 신고 진행 중'으로 따로 보여 준다. 월이 바뀌어도 이미 기록돼 있어 한꺼번에 몰리지 않는다.
  // 전세도 이번 달을 받아 지역 데이터 파일에만 넣는다 (전세 보기 단지 화면의 최근 전세). 거래 이력·지표·예측에는 넣지 않는다
  const partialYm = currentYm();
  const isPartial = (r) => r.date.slice(0, 4) + r.date.slice(5, 7) === partialYm;
  console.log(`빌드: ${mode() === 'live' ? '국토부 API' : '데모 데이터'}, ${yms[0]}~${yms[yms.length - 1]} (${MONTHS}개월), ${regions.length}개 지역`);
  fs.rmSync(DIST, { recursive: true, force: true });
  // 정책 자료는 사람이 고치는 파일이라 수집 전에 형식부터 검사한다 (틀리면 이전 배포 유지)
  const policyData = policies.validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'policies.json'), 'utf8')), regions);

  const failures = [];
  let total = 0, bytes = 0;
  // 한 달 실패로 지역 전체를 버리지 않도록 월 단위로 받는다 (API 호출은 molit.js에서 직렬화됨)
  // 수집 실패와 실제 거래 0건을 구분해야 이력 비교에서 실패한 달을 삭제로 보지 않는다 → 월별 { ym, ok, rows }
  const fetchAll = (kind, code, months = yms) => pool(months, 6, async (ym) => {
    total++;
    try {
      return { ym, ok: true, rows: await getMonth(kind, code, ym) };
    } catch (e) {
      failures.push({ code, kind, ym, error: e.message });
      return { ym, ok: false, rows: [] };
    }
  });

  // 거래 이력 비교 (lib/ledger.js). 빌드 순번이 있는 빌드(GitHub Actions)만 이력을 읽고 쓴다
  const seq = process.env.GITHUB_RUN_NUMBER
    ? { runNumber: Number(process.env.GITHUB_RUN_NUMBER), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1 }
    : null;
  const no = ledger.buildNo(seq);
  const today = kstNow().toISOString().slice(0, 10);
  const recent = no ? ledger.readState('recent') || [] : [];
  const items = [], regionStats = {};
  let continued = false; // 이전 이력이 있는 지역이 하나라도 있으면 비교한 빌드, 없으면 이력 시작

  // 주간 가격지수·매입자 거주지 (한국부동산원 R-ONE). 지역 급등 판정에도 쓰므로 지역보다 먼저 받는다.
  // 키가 없거나 실패해도 실거래 배포는 그대로 진행
  let reb = null;
  try {
    reb = await getReb(MONTHS);
    if (reb) console.log(`부동산원 지표 ${Object.keys(reb.regions).length}개 지역${reb.missing.length ? ` (실패: ${reb.missing.join(', ')})` : ''}`);
    else console.log('REB_API_KEY 없음 → 부동산원 지표 생략');
  } catch (e) {
    console.warn(`부동산원 지표 실패 (생략): ${e.message}`);
  }

  let done = 0;
  const search = {};
  const panels = [];
  await pool(regions, 2, async (r) => {
    const [tradeMonths, rentMonths] = [await fetchAll('trade', r.code, [...yms, partialYm]), await fetchAll('rent', r.code, [...yms, partialYm])];
    // all: 이번 달 포함 (이력·변화·지역 데이터 파일), trades: 완성된 달까지 (지표·예측). 지표 쪽 실패 판정도 완성된 달만 본다
    const all = tradeMonths.flatMap((m) => m.rows), trades = all.filter((t) => !isPartial(t));
    const allRents = rentMonths.flatMap((m) => m.rows), rents = allRents.filter((t) => !isPartial(t));
    const failed = failures.some((f) => f.code === r.code && f.ym !== partialYm);
    // 이전 이력과 비교해 거래마다 처음 확인한 빌드 번호(firstSeen)를 붙인다. 성공한 달만 비교한다
    const prev = no ? ledger.read(r.code) : null;
    const obs = no ? ledger.observe(prev, tradeMonths, no) : null;
    bytes += write(`data/region/${r.code}.json`, pack(yms, all, allRents));
    search[r.code] = an.searchEntries(trades);
    // 지표(고점·장기 평균 거래량)는 받은 기간 전체로 계산하고, 스파크라인·궤적용 시계열만 잘라 보낸다
    const { series, indicators } = an.regionSummary(yms, trades, rents);
    indicators.candidate = failed ? null : an.candidateScore(indicators, series);
    if (mode() === 'live' && !failed) panels.push(forecast.preparePanel(r.code, yms, trades, rents));
    write(`data/overview/${r.code}.json`, { code: r.code, series: series.slice(-OVERVIEW_MONTHS).map(({ ym, ma, count, jeonseMa }) => ({ ym, ma, count, jeonseMa })), indicators });
    if (obs) {
      // 신고가·급등·국면처럼 여러 달을 보는 변화는 이 지역 매매 수집이 모두 성공했을 때만 확정한다
      // (거래 변화는 이번 달까지, 국면은 완성된 달로 계산하므로 완성된 달만)
      const complete = tradeMonths.every((m) => m.ok);
      const tradeItems = ch.tradeChanges({ code: r.code, trades: all, added: obs.added, removed: obs.removed, no, today, complete, recent });
      items.push(...tradeItems);
      const reg = ch.regionChanges({ code: r.code, prev, ind: indicators, weekly: reb?.regions?.[r.code]?.weekly, complete: !failed && tradeMonths.slice(0, -1).every((m) => m.ok), no, today, recent });
      items.push(...reg.items);
      const added = tradeItems.filter((x) => x.type === 'new' && !x.bulk).length; // 일괄 거래 제외
      const lastAdded = added ? { d: today, n: added + (prev?.lastAdded?.d === today ? prev.lastAdded.n : 0) } : prev?.lastAdded || null;
      ledger.write(r.code, { ...obs.ledger, ...reg.state, lastAdded });
      regionStats[r.code] = {
        // 이번 달이 처음 들어오는 건 매달 1일의 정상 흐름이라 '한꺼번에 반영' 안내에서 뺀다
        added, removed: obs.removed.length, failed: !complete, opened: obs.opened.filter((ym) => ym !== partialYm),
        lastAdded, lastTrade: all.reduce((m, t) => (t.date > m ? t.date : m), ''),
      };
      if (prev) continued = true;
    }
    console.log(`[${++done}/${regions.length}] ${r.name}: 매매 ${trades.length.toLocaleString()} (이번 달 ${(all.length - trades.length).toLocaleString()}) · 전월세 ${rents.length.toLocaleString()} (이번 달 ${(allRents.length - rents.length).toLocaleString()})${obs ? ` · 새로 확인 ${obs.added.length} · 삭제 ${obs.removed.length}` : ''}`);
  });

  // 변화 파일: 오늘(KST) 확인된 변화(첫 화면 피드), 최근 30일 변화(삭제된 거래·급등·국면). 다음 빌드가 이어 쓰도록 이력에도 둔다
  let builds = null;
  if (no) {
    const pol = ch.policyChanges(ledger.readState('policies'), policyData.items, no, today);
    items.push(...pol.items);
    ledger.writeState('policies', pol.known);
    const status = continued ? 'ok' : 'bootstrap';
    const feed = ch.mergeFeed(ledger.readState('feed'), { today, no, items, regions: regionStats });
    // lastAdded·lastTrade는 이번 빌드 기준 값으로 덮는다
    for (const [code, s] of Object.entries(regionStats)) Object.assign(feed.regions[code], { lastAdded: s.lastAdded, lastTrade: s.lastTrade });
    const recentNext = ch.updateRecent(recent, items, today);
    builds = ch.pruneBuilds({ ...ledger.readState('builds'), [no]: today }, today);
    ledger.writeState('feed', feed);
    ledger.writeState('recent', recentNext);
    ledger.writeState('builds', builds);
    write('data/changes.json', { v: 1, status, no, ...feed });
    write('data/changes-30d.json', { v: 1, no, items: recentNext });
    const count = (t) => items.filter((x) => x.type === t).length;
    console.log(status === 'ok'
      ? `변화: 새로 확인 ${count('new')} · 삭제 ${count('del')} · 급등 ${count('surge')} · 지역 급등 ${count('regionSurge')} · 국면 ${count('phase')} · 정책 ${count('policy')}`
      : '거래 이력 시작: 지금 있는 거래는 새 거래로 표시하지 않습니다');
  }

  write('data/policies.json', policyData);
  // 전체 단지 검색 목록 (상단 검색창)
  write('data/search.json', { v: 1, regions: search });
  // 수집 누락은 완성된 달만 (이번 달 실패는 지표·예측에 영향이 없다). 이번 달 실패는 meta.partial.missing으로 따로 알린다
  const missing = failures.filter((f) => f.ym !== partialYm).map(({ code, kind, ym }) => `${code}/${kind}/${ym}`);
  write('data/forecasts.json', forecast.buildForecasts(panels, { source: mode(), missing }));

  const partialCodes = (kind) => [...new Set(failures.filter((f) => f.ym === partialYm && f.kind === kind).map((f) => f.code))];
  const partialMissing = { missing: partialCodes('trade'), rentMissing: partialCodes('rent') };
  write('data/meta.json', {
    mode: 'static',
    source: mode(),
    builtAt: new Date().toISOString(),
    // 빌드 순번 (GitHub Actions 실행 번호, 재시도 번호). 배포 확정 단계가 이 값을 그대로 쓴다 (lib/history.js)
    build: seq,
    // 거래별 firstSeen과 비교하는 빌드 번호 (lib/ledger.js)와 빌드 번호 → 날짜(KST) 표. 이력이 없는 빌드는 null
    buildNo: no || null,
    builds,
    // 방문 측정 API (infra/, 저장소 변수 API_URL). 없으면 사이트가 아무것도 보내지 않는다
    api: /^https:\/\/[^\s"']+$/.test(process.env.API_URL || '') ? process.env.API_URL.replace(/\/+$/, '') : null,
    months: MONTHS,
    yms,
    regions: regions.map(({ demoBase, ...r }) => r),
    missing,
    // 이번 달(신고 진행 중) 매매·전세. 지역 데이터 파일에 들어 있지만 지표·차트에는 쓰지 않는다.
    // missing: 이번 달 매매를 못 받은 지역, rentMissing: 이번 달 전월세를 못 받은 지역
    partial: { ym: partialYm, ...partialMissing },
  });

  // 금리·주택가격 전망 심리 (한국은행 ECOS). 키가 없거나 실패해도 실거래 배포는 그대로 진행
  try {
    const macro = await getMacro(yms[0], yms[yms.length - 1]);
    if (macro) {
      write('data/macro.json', { builtAt: new Date().toISOString(), ...macro });
      console.log(`한국은행 지표 ${macro.series.length}개${macro.missing.length ? ` (실패: ${macro.missing.join(', ')})` : ''}`);
    } else console.log('ECOS_API_KEY 없음 → 금리·심리 지표 생략');
  } catch (e) {
    console.warn(`한국은행 지표 실패 (생략): ${e.message}`);
  }

  if (reb) write('data/reb.json', { builtAt: new Date().toISOString(), ...reb });

  // 페이지: public/ 복사 + 분석 모듈 + 정적 모드 표시
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    fs.copyFileSync(path.join(ROOT, 'public', f), path.join(DIST, f));
  }
  fs.copyFileSync(path.join(ROOT, 'lib', 'complexes.js'), path.join(DIST, 'complexes.js'));
  fs.copyFileSync(path.join(ROOT, 'lib', 'analyze.js'), path.join(DIST, 'analyze.js'));
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('<script src="analyze.js"></script>', '<script>window.HT_STATIC = true;</script>\n  <script src="analyze.js"></script>');
  write('index.html', html);
  write('.nojekyll', '');

  console.log(`데이터 ${(bytes / 1024 / 1024).toFixed(1)}MB, 실패 ${failures.length}/${total}건`);
  failures.slice(0, 20).forEach((f) => console.warn(`  [실패] ${f.code} ${f.kind} ${f.ym}: ${f.error}`));
  if (failures.length > total * MAX_FAIL_RATIO) {
    console.error(`실패가 ${(MAX_FAIL_RATIO * 100).toFixed(0)}%를 넘어 빌드를 중단합니다 (이전 배포 유지).`);
    process.exit(1);
  }
})();
