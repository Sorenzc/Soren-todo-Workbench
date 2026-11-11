// 优先级 / 紧迫度 / 分区：纯函数，可单测
import { diffDays, dateOf, PRIORITY_SHORT } from './util.mjs';

export const WP = [1.0, 0.75, 0.45, 0.2]; // P0..P3 权重

/** 分区：决定"出现在哪"。leadDays = 多少天内算"必做"，weekDays = 多少天内算"本周" */
export function bucketOf(daysLeft, opts = {}) {
  const lead = Number.isFinite(opts.leadDays) ? opts.leadDays : 3;
  const week = Number.isFinite(opts.weekDays) ? opts.weekDays : 7;
  if (daysLeft === null || daysLeft === undefined) return 'nodate';
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'today';
  if (daysLeft <= lead) return 'soon';
  if (daysLeft <= week) return 'week';
  return 'later';
}

/** 紧迫度 U：分段线性，可为用户解释 */
export function urgencyOf(daysLeft, ageDays = 0) {
  if (daysLeft === null || daysLeft === undefined) {
    return 0.15 + Math.min(0.45, ageDays / 60);
  }
  if (daysLeft < 0) return 1.0 + Math.min(0.5, 0.02 * Math.abs(daysLeft));
  if (daysLeft === 0) return 1.0;
  if (daysLeft <= 3) return 0.85 - 0.07 * (daysLeft - 1);
  if (daysLeft <= 7) return 0.55 - 0.05 * (daysLeft - 4);
  return Math.max(0.05, 0.3 - 0.01 * (daysLeft - 7));
}

export function scoreOf({ priority, daysLeft, ageDays }, w = { wPriority: 0.55, wUrgency: 0.45 }) {
  const p = Number.isFinite(priority) ? priority : 2;
  const U = urgencyOf(daysLeft, ageDays);
  return Math.round(100 * (w.wPriority * WP[p] + w.wUrgency * U) * 10) / 10;
}

/** 一句话解释排序理由 */
export function whyOf({ priority, daysLeft, ageDays, dueOn }) {
  const p = PRIORITY_SHORT[priority] ?? 'P2';
  if (daysLeft === null || daysLeft === undefined) {
    if (ageDays >= 14) return `无日期 · ${p} · 未动 ${ageDays} 天`;
    return `无日期 · ${p}`;
  }
  // 行上已经有「逾期 N 天」的红标签了，这里补原定日期，别重复同一句话
  if (daysLeft < 0) return `原定 ${String(dueOn || '').slice(5)} 到期 · ${p}`;
  if (daysLeft === 0) return `今天到期 · ${p}`;
  if (daysLeft === 1) return `明天到期 · ${p}`;
  return `${daysLeft} 天后到期 · ${p}`;
}

/** 把开放任务行加工成带 daysLeft/bucket/score/why 的对象 */
export function decorate(row, today, opts = {}) {
  const due = row.due_on || null;
  const daysLeft = due ? diffDays(today, due) : null;
  const ageDays = row.last_touched_at ? diffDays(dateOf(row.last_touched_at), today) : 0;
  const priority = Number.isFinite(row.priority) ? row.priority : 2;
  const ctx = { priority, daysLeft, ageDays, dueOn: due };
  return {
    ...row,
    days_left: daysLeft,
    bucket: bucketOf(daysLeft, opts),
    age_days: ageDays,
    score: scoreOf(ctx),
    why: whyOf(ctx),
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function byScore(a, b) {
  return (
    b.score - a.score ||
    a.priority - b.priority ||
    cmp(a.created_at, b.created_at) ||
    cmp(a.id, b.id)
  );
}

/**
 * 聚焦分三段：必做 / 本周 / 待办池
 * 铁律：逾期与今天到期永不因分数被筛掉。
 */
export function buildFocus(rows, today, opts = {}) {
  const staleDays = opts.staleDays ?? 14;
  const items = rows.map((r) => decorate(r, today, opts)).sort(byScore);

  // 「等待他人」单独一段：不算逾期、不进必做，等对方有动静了再挪回待办
  const waiting = items.filter((t) => t.status === 'waiting');
  const active = items.filter((t) => t.status !== 'waiting');

  const must = active.filter(
    (t) =>
      t.bucket === 'overdue' ||
      t.bucket === 'today' ||
      t.bucket === 'soon' ||
      (t.bucket === 'nodate' && t.priority <= 1 && t.age_days >= staleDays)
  );
  const week = active.filter((t) => t.bucket === 'week').slice(0, 10);
  const pool = active.filter(
    (t) =>
      !must.includes(t) &&
      !week.includes(t) &&
      (t.bucket === 'nodate' || t.bucket === 'later')
  );

  return {
    today,
    must,
    week,
    waiting,
    pool_count: pool.length,
    overdue_count: active.filter((t) => t.bucket === 'overdue').length,
    today_count: active.filter((t) => t.bucket === 'today').length,
    soon_count: active.filter((t) => t.bucket === 'soon').length,
    waiting_count: waiting.length,
    open_count: active.length,
  };
}
