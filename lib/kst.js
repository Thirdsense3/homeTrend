// 한국 시간 기준 "지금". Actions 러너는 UTC라 월초 KST 새벽에도 전월로 계산되는 걸 막는다
// 반환값의 getUTC*() 가 KST 날짜·시각이다
const kstNow = (ms = Date.now()) => new Date(ms + 9 * 60 * 60 * 1000);

module.exports = { kstNow };
