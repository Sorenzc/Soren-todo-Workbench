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
