const TIME_SENSITIVE_PATTERN = /(?:几点|什么时间|日期|几号|星期几|周几|今天(?:是)?(?:几号|星期几)|现在(?:是|到)?(?:几点|什么时间|早上|上午|中午|下午|傍晚|晚上|深夜|凌晨)|此刻(?:是)?(?:几点|什么时间)|明天|昨天|周[一二三四五六日末])/;
const TIME_CLAIM_PATTERN = /(?:今天|今晚|今早|明天|昨天|现在(?:是|已经|到了)|此刻|早上|上午|中午|下午|傍晚|晚上|深夜|凌晨|星期[一二三四五六日天]|周[一二三四五六日末]|\d{1,2}\s*[:：]\s*\d{2})/;

function getLiveTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const hour = Number(values.hour);
  return {
    checkedAt: now.toISOString(),
    timezone: "Asia/Shanghai",
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour,
    minute: Number(values.minute),
    period: timePeriod(hour),
    display: `${values.year}年${values.month}月${values.day}日 ${values.weekday} ${values.hour}:${values.minute}`
  };
}

function needsLiveTime(text) {
  return TIME_SENSITIVE_PATTERN.test(String(text || ""));
}

function containsTimeClaim(text) {
  return TIME_CLAIM_PATTERN.test(String(text || ""));
}

function timePeriod(hour) {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早上";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

module.exports = { getLiveTime, needsLiveTime, containsTimeClaim };
