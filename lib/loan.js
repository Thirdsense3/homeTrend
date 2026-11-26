// 대출 가능액·필요 현금·월 부담 계산 (로드맵 23번)
// 금액 단위는 모두 만원. 규칙 값은 RULES에 기준일·출처와 함께 두고, 바뀌면 정책 자료(data/policies.json)와 함께 고친다.
// 결과는 참고값이다. 실제 한도·금리는 금융기관 심사(KB 시세·감정가, 소득 인정 방식 등)로 정해진다.
// Node(테스트)와 브라우저 양쪽에서 쓴다 → analyze.js처럼 IIFE로 감쌈
(function (root) {
  const RULES = {
    asOf: '2026-11-26', // 아래 값을 원문으로 마지막 확인한 날
    // 규제지역(조정대상지역·투기과열지구): 서울 전역 + 경기 12곳 (10·15 대책)
    regulated: {
      seoul: true,
      codes: ['41290', '41210', '41135', '41131', '41133', '41117', '41111', '41115', '41173', '41465', '41430', '41450'],
      policy: '2025-10-market-stabilization',
    },
    // 아파트 토지거래허가구역: 규제지역과 같은 범위, 2026-12-31까지 (연장·해제는 이슈 #44·#45에서 확인)
    landPermit: { sameAsRegulated: true, until: '2026-12-31', residenceYears: 2, policy: '2025-10-market-stabilization' },
    // 주택 구입 목적 주담대 LTV (무주택자). 생애최초는 수도권·규제지역 70% + 6개월 안 전입 (6·27 대책)
    ltv: { regulated: 0.4, capital: 0.7, firstTime: 0.7, policies: ['2025-10-market-stabilization', '2025-06-mortgage-cap'] },
    moveInMonths: 6,
    // 수도권·규제지역 주담대 최대 한도: [시가 상한, 대출 한도] (6·27 6억, 10·15 구간 차등)
    caps: [[150000, 60000], [250000, 40000], [Infinity, 20000]],
    maxTermYears: 30, // 수도권·규제지역 주담대 만기 (6·27)
    // DSR: 은행권 40%. 스트레스 금리: 수도권·규제지역 주담대 3.0%p (10·15), 금리 유형별 반영 비율 (3단계, 30년 만기·5년 주기 기준)
    dsr: 0.4,
    stress: 3.0,
    stressRatio: { variable: 1, mixed: 0.8, periodic: 0.4, fixed: 0 },
    // 생애최초 취득세 감면: 취득가액 12억 이하, 200만 원 한도, 2028-12-31 취득분까지 (지방세특례제한법 제36조의3)
    firstTimeRelief: { maxPrice: 120000, cap: 200, until: '2028-12-31' },
    // 중개보수 상한 요율 (주택 매매, 서울·경기 조례): [가격 상한, 요율, 한도액]
    brokerage: [[5000, 0.006, 25], [20000, 0.005, 80], [90000, 0.004, null], [120000, 0.005, null], [150000, 0.006, null], [Infinity, 0.007, null]],
    otherCostRate: 0.002, // 등기·법무·채권 할인·인지세 어림값 (직접 바꿀 수 있음)
    sources: {
      '10·15 대책': 'https://www.korea.kr/news/policyNewsView.do?newsId=148950973',
      '6·27 대책': 'https://www.fsc.go.kr/edu/news/84845',
      '3단계 스트레스 DSR': 'https://www.fsc.go.kr/no010101/84617',
      '생애최초 취득세 감면': 'https://www.law.go.kr/법령/지방세특례제한법',
      '중개보수 요율': 'https://land.seoul.go.kr/land/broker/brokerageCommission.do',
    },
  };

  const isRegulated = (code) => String(code).startsWith('11') || RULES.regulated.codes.includes(String(code));
  const isLandPermit = (code, date = new Date().toISOString().slice(0, 10)) => isRegulated(code) && date <= RULES.landPermit.until;

  // 원리금균등 월 납입액 (원금 P 만원, 연 금리 %, 기간 년)
  function monthlyPayment(P, ratePct, years) {
    const n = years * 12, r = ratePct / 100 / 12;
    if (!(P > 0)) return 0;
    return r ? (P * r) / (1 - (1 + r) ** -n) : P / n;
  }
  // 월 납입액이 pmt일 때 빌릴 수 있는 원금 (monthlyPayment의 역)
  function principalFor(pmt, ratePct, years) {
    const n = years * 12, r = ratePct / 100 / 12;
    if (!(pmt > 0)) return 0;
    return r ? (pmt * (1 - (1 + r) ** -n)) / r : pmt * n;
  }

  // 취득세 (무주택자 1주택 유상취득). 6억~9억 구간은 (가격(억) × 2/3 − 3)%를 소수 둘째 자리에서 반올림
  function acquisitionTax(price, { over85 = false, firstTime = false } = {}) {
    const eok = price / 10000;
    const rate = eok <= 6 ? 1 : eok > 9 ? 3 : Math.round(((eok * 2) / 3 - 3) * 100) / 100;
    const tax = (price * rate) / 100;
    const edu = tax * 0.1; // 지방교육세: 취득세의 10% (1~3% 세율 구간)
    const rural = over85 ? price * 0.002 : 0; // 농어촌특별세: 전용 85㎡ 초과만
    const fr = RULES.firstTimeRelief;
    const relief = firstTime && price <= fr.maxPrice ? Math.min(fr.cap, tax) : 0;
    return { rate, tax, edu, rural, relief, total: tax - relief + edu + rural };
  }

  function brokerageFee(price) {
    const [, rate, max] = RULES.brokerage.find(([lim]) => price < lim);
    const fee = price * rate;
    return { rate, fee: max == null ? fee : Math.min(fee, max) };
  }

  const capFor = (price) => RULES.caps.find(([lim]) => price <= lim)[1];

  // 한 가격에 대한 계산. p: Profile.normalize 결과, s: Profile.summary 결과
  // opts: { price, code, rate(실제 금리 %), over85, other(기타 비용, 없으면 어림값) }
  function evaluate(s, opts) {
    const p = s.profile;
    const price = Math.max(0, Number(opts.price) || 0);
    const regulated = isRegulated(opts.code);
    const term = Math.min(p.term || 30, RULES.maxTermYears);
    const ltvRate = p.firstTime ? RULES.ltv.firstTime : regulated ? RULES.ltv.regulated : RULES.ltv.capital;
    const stressAdd = RULES.stress * (RULES.stressRatio[p.rateType] ?? 1);
    const rate = Number(opts.rate);
    const limits = { ltv: price * ltvRate, cap: capFor(price), dsr: null };
    let dsrRoom = null;
    if (s.income) {
      dsrRoom = Math.max(0, s.income * RULES.dsr - s.debtYear);
      limits.dsr = principalFor(dsrRoom / 12, rate + stressAdd, term);
    }
    const cands = Object.entries(limits).filter(([, v]) => v != null);
    const [binding, raw] = cands.reduce((a, b) => (b[1] < a[1] ? b : a));
    const loan = Math.floor(Math.min(raw, price));
    const tax = acquisitionTax(price, { over85: opts.over85, firstTime: p.firstTime });
    const broker = brokerageFee(price);
    const other = opts.other != null && opts.other !== '' ? Math.max(0, Number(opts.other) || 0) : Math.round(price * RULES.otherCostRate);
    const costs = tax.total + broker.fee + other;
    const need = price - loan + costs;
    const pay = monthlyPayment(loan, rate, term);
    const interest = (loan * rate) / 100 / 12;
    return {
      price, regulated, landPermit: isLandPermit(opts.code), term, ltvRate, stressAdd, dsrRoom,
      limits, binding, loan, tax, broker, other, costs, need,
      funds: s.funds, left: s.funds == null ? null : s.funds - need,
      pay, interest, principal: pay - interest,
      payRatio: s.income ? ((pay * 12) + s.debtYear) / s.income : null,
      incomeMissing: !s.income,
    };
  }

  // 내 자금으로 살 수 있는 최대 가격 (100만 원 단위). 필요 현금은 가격에 대해 줄지 않으므로 이분 탐색
  function maxPrice(s, opts, hi = 1000000) {
    if (s.funds == null) return null;
    const ok = (price) => evaluate(s, { ...opts, price }).need <= s.funds;
    if (!ok(100)) return 0;
    let lo = 100, top = hi;
    if (ok(top)) return top;
    while (top - lo > 100) {
      const mid = Math.round((lo + top) / 200) * 100;
      if (mid === lo || mid === top) break;
      if (ok(mid)) lo = mid; else top = mid;
    }
    return lo;
  }

  const api = { RULES, isRegulated, isLandPermit, monthlyPayment, principalFor, acquisitionTax, brokerageFee, capFor, evaluate, maxPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Loan = api;
})(typeof window !== 'undefined' ? window : globalThis);
