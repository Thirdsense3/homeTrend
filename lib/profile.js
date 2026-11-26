// 내 재무 프로필 (로드맵 22번): 입력값 정리와 요약 계산
// 값은 브라우저(localStorage)에만 둔다. 이 모듈은 저장·전송을 하지 않는다.
// Node(테스트)와 브라우저 양쪽에서 쓴다 → analyze.js처럼 IIFE로 감쌈
(function (root) {
  const VERSION = 1;
  const MAN_MAX = 10000000; // 만원 단위 상한 (1,000억)
  const LOANS_MAX = 10;
  const LOAN_KINDS = { mortgage: '주택담보대출', jeonse: '전세자금대출', credit: '신용대출', other: '기타' };
  // 스트레스 DSR 반영 비율이 유형마다 다르다 (lib/loan.js RULES.stressRatio)
  const RATE_TYPES = { variable: '변동', mixed: '혼합형 (5년 고정 뒤 변동)', periodic: '주기형 (5년마다 금리 조정)', fixed: '만기까지 고정' };
  const TERMS = [10, 15, 20, 30, 40, 50];

  // 숫자 입력 → 0 이상 정수(만원). 비었거나 잘못된 값은 null(입력 안 함)
  const man = (v) => {
    if (v === '' || v == null) return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), MAN_MAX) : null;
  };
  const int = (v, lo, hi) => { const n = man(v); return n == null ? null : Math.min(Math.max(n, lo), hi); };
  const rate = (v) => { // 연 금리 % (0~30, 소수 둘째 자리)
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 30 ? Math.round(n * 100) / 100 : null;
  };
  const bool = (v) => v === true;
  const pick = (v, table) => (Object.hasOwn(table, v) ? v : null);

  function loan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const l = { kind: pick(raw.kind, LOAN_KINDS) || 'other', balance: man(raw.balance), rate: rate(raw.rate), monthly: man(raw.monthly) };
    return l.balance == null && l.monthly == null && l.rate == null ? null : l;
  }

  // 저장된 값이나 입력 폼 값 → 알려진 필드만 남긴 프로필. 모르는 필드는 버린다
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      v: VERSION,
      cash: man(r.cash), // 바로 쓸 수 있는 현금(예금·주식 등)
      deposit: man(r.deposit), // 돌려받아 쓸 수 있는 지금 전세 보증금
      income: man(r.income), // 본인 연소득(세전)
      spouseIncome: man(r.spouseIncome),
      joint: bool(r.joint), // 대출 심사에 배우자 소득 합산
      loans: (Array.isArray(r.loans) ? r.loans : []).map(loan).filter(Boolean).slice(0, LOANS_MAX),
      homes: int(r.homes, 0, 9), // 세대가 가진 주택 수
      firstTime: bool(r.firstTime), // 생애최초 (세대원 모두 주택을 가진 적 없음)
      live: r.live !== false, // 실거주 목적 (기본값 예)
      married: bool(r.married),
      kids: int(r.kids, 0, 9),
      newborn: bool(r.newborn), // 최근 2년 안 출산
      term: TERMS.includes(Number(r.term)) ? Number(r.term) : 30,
      rateType: pick(r.rateType, RATE_TYPES) || 'mixed',
      updated: typeof r.updated === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.updated) ? r.updated : null,
    };
  }

  const isEmpty = (p) => [p.cash, p.deposit, p.income, p.spouseIncome, p.homes, p.kids].every((v) => v == null) && !p.loans.length;

  // 입력값에서 바로 나오는 숫자와 확인할 점. 대출 한도·필요 현금은 23번에서 계산한다
  function summary(raw) {
    const p = normalize(raw);
    const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
    const funds = p.cash == null && p.deposit == null ? null : sum([p.cash, p.deposit]);
    const income = p.income == null && !(p.joint && p.spouseIncome != null) ? null : sum([p.income, p.joint ? p.spouseIncome : 0]);
    const debt = sum(p.loans.map((l) => l.balance));
    const debtYear = sum(p.loans.map((l) => l.monthly)) * 12;
    const notes = [];
    if (p.homes == null) notes.push({ level: 'need', text: '주택 수를 넣어 주세요. 대출 규칙이 주택 수에 따라 달라요.' });
    if (p.homes > 0 && p.firstTime) notes.push({ level: 'warn', text: '생애최초는 세대원 모두 주택을 가진 적이 없어야 해요. 주택 수와 생애최초 표시가 서로 맞지 않아요.' });
    if (p.homes > 0 || !p.live) notes.push({ level: 'scope', text: '대출 계산(로드맵 23번)은 처음에 무주택 실거주 매수만 지원해요. 이 조건은 입력은 저장되지만 계산은 나중에 지원해요.' });
    if (income == null) notes.push({ level: 'need', text: '연소득을 넣어야 DSR(소득 대비 대출 상환) 한도를 계산할 수 있어요.' });
    if (p.loans.some((l) => l.balance != null && l.monthly == null)) notes.push({ level: 'need', text: '월 상환액이 비어 있는 대출은 소득 대비 상환 비율에서 빠져요.' });
    if (!p.joint && p.spouseIncome != null) notes.push({ level: 'info', text: '배우자 소득은 넣었지만 합산하지 않았어요. 합산하면 DSR 한도는 늘지만 배우자 대출도 함께 넣어야 해요.' });
    return {
      profile: p,
      empty: isEmpty(p),
      funds, // 쓸 수 있는 자금 합계 (만원)
      income, // 대출 심사에 쓸 연소득 (만원)
      debt, // 기존 대출 잔액 합계
      debtYear, // 기존 대출 연 상환액 (월 상환액 × 12)
      debtRatio: income ? debtYear / income : null, // 소득 대비 기존 상환 비율 (규제 DSR과 산정 방식이 다를 수 있음)
      supported: p.homes === 0 && p.live,
      notes,
    };
  }

  const api = { VERSION, LOAN_KINDS, RATE_TYPES, TERMS, LOANS_MAX, normalize, summary, isEmpty };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Profile = api;
})(typeof window !== 'undefined' ? window : globalThis);
