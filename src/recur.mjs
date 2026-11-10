/**
 * 每月例行的日期计算。
 *
 * 关键点：一律用「年月日」整数算，绝不走 Date —— `new Date(2026, 1, 31)` 会溢出成 3 月 3 日，
 * 那样 31 号的例行任务会在 2 月悄悄漂到 3 月，然后就再也回不来了。
 */

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** month 取 1..12 */
export function daysInMonth(year, month) {
  return month === 2 && isLeap(year) ? 29 : DIM[month - 1];
}

/** 'YYYY-MM' + 号数 → 'YYYY-MM-DD'，超出当月天数就钳到月末 */
export function occurrenceOn(ym, day) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const d = Math.min(Math.max(1, Number(day) || 1), daysInMonth(y, m));
  return `${ym}-${String(d).padStart(2, '0')}`;
}

export function monthOf(dateStr) {
  return String(dateStr).slice(0, 7);
}

export function addMonths(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + Number(n);
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}`;
}

export function nextMonth(ym) {
  return addMonths(ym, 1);
}

/** 下一次「每月 day 号」的日期：今天及以后最近的一次 */
export function nextOccurrenceFrom(ymd, day) {
  const thisMonth = occurrenceOn(monthOf(ymd), day);
  if (thisMonth >= ymd) return thisMonth;
  return occurrenceOn(addMonths(monthOf(ymd), 1), day);
}

export function monthDiff(fromYm, toYm) {
  return (Number(toYm.slice(0, 4)) - Number(fromYm.slice(0, 4))) * 12 + (Number(toYm.slice(5, 7)) - Number(fromYm.slice(5, 7)));
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 'YYYY-MM-DD' → 0=周一 … 6=周日（用 UTC 整数算，时区/夏令时不会把日期挪一天） */
export function weekdayOf(ymd) {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return (new Date(t).getUTCDay() + 6) % 7;
}

export function weekdayName(w) {
  const i = Math.max(0, Math.min(6, Number(w) || 0));
  return WEEKDAY_NAMES[i];
}

export function addDaysStr(ymd, n) {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) + Number(n) * 86400000;
  const dt = new Date(t);
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 滚动系列的下一期：weekly 一次跳 N 周，daily 跳 N 天 */
export function stepRolling(ymd, rule, interval) {
  const n = Math.max(1, Number(interval) || 1);
  return addDaysStr(ymd, rule === 'weekly' ? 7 * n : n);
}

/** 从 ymd 起找第一个星期几匹配的日期（weekly 用：用户选了「每周三」但起始日不是周三） */
export function alignWeekday(ymd, weekday) {
  const want = Math.max(0, Math.min(6, Number(weekday) || 0));
  let d = ymd;
  for (let i = 0; i < 7 && weekdayOf(d) !== want; i += 1) d = addDaysStr(d, 1);
  return d;
}
