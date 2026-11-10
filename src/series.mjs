// 例行系列：规则模板 + 把每一期落成 task 表里的普通行
// monthly：一次铺出未来 N 期跑道；daily/weekly：只维护一条活行，完成时滚动、留一条历史行。
import { bad, conflict, diffDays, localDate, notFound, nowIso, uid } from './util.mjs';
import { logEvent } from './db.mjs';
import { validateUserPath } from './paths.mjs';
import {
  addDaysStr,
  addMonths,
  alignWeekday,
  monthOf,
  nextMonth,
  occurrenceOn,
  stepRolling,
  weekdayOf,
} from './recur.mjs';

const MAX_HORIZON = 60;
const MAX_INTERVAL = 60;

export function normRecurrence(raw) {
  if (!raw) return null;
  const rule = String(raw.rule || 'monthly');
  if (!['monthly', 'daily', 'weekly'].includes(rule)) throw bad('重复只支持每月 / 每天 / 每周', 'BAD_RULE');
  const today = localDate();

  if (rule === 'monthly') {
    const day = Number(raw.dayOfMonth ?? raw.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('每月例行要选 1–31 号中的一天', 'BAD_DAY');
    // 起始月份不写就按「从现在开始」算；写成过去的月份也纠正到今天所在月，
    // 免得一次铺出几百条早就过期的期。
    const rawStart = String(raw.startMonth ?? raw.start_month ?? '').slice(0, 7);
    if (rawStart && !/^\d{4}-\d{2}$/.test(rawStart)) throw bad('例行起始月份不合法', 'BAD_MONTH');
    // 起始月份不写就从「第一次发生」所在月开始：今天已经过了本月那一天，
    // 首期就该落在下个月，否则会铺出一条起手就逾期的任务。
    const thisMonth = monthOf(today);
    const firstHere = occurrenceOn(thisMonth, day);
    const autoStart = firstHere >= today ? thisMonth : nextMonth(thisMonth);
    const startMonth = rawStart && rawStart > autoStart ? rawStart : autoStart;
    const horizon = Number(raw.horizonMonths ?? raw.horizon_months ?? 36);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
      throw bad(`例行范围要在 1–${MAX_HORIZON} 个月之间`, 'BAD_HORIZON');
    }
    return { rule, dayOfMonth: day, startMonth, horizonMonths: horizon };
  }

  // daily / weekly：不铺跑道，只从「起始日」开始滚一条活行。
  const rawStart = String(raw.startDate ?? raw.start_date ?? '').slice(0, 10);
  let startDate = /^\d{4}-\d{2}-\d{2}$/.test(rawStart) ? rawStart : today;
  if (startDate < today) startDate = today; // 过去的日子纠正到今天，免得一上来就是逾期
  const interval = Number(raw.intervalN ?? raw.interval_n ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
    throw bad(`间隔要在 1–${MAX_INTERVAL} 之间`, 'BAD_INTERVAL');
  }
  let weekday = null;
  if (rule === 'weekly') {
    weekday = raw.weekday === undefined || raw.weekday === null ? weekdayOf(startDate) : Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw bad('星期几不合法', 'BAD_WEEKDAY');
    // 选了「每周三」但起始日不是周三，就顺延到最近的那个周三
    startDate = alignWeekday(startDate, weekday);
  }
  return {
    rule,
    startDate,
    intervalN: interval,
    weekday,
    dayOfMonth: Number(startDate.slice(8, 10)),
    startMonth: monthOf(startDate),
  };
}

/** 系列规则的中文说明（列表、详情、归档都用它） */
export function ruleLabel(series) {
  if (!series) return '';
  const n = Number(series.interval_n) || 1;
  if (series.rule === 'weekly') {
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const w = names[Math.max(0, Math.min(6, Number(series.weekday) || 0))];
    return n === 1 ? `每周${w.slice(1)}` : `每 ${n} 周的${w}`;
  }
  if (series.rule === 'daily') return n === 1 ? '每天' : `每 ${n} 天`;
  return `每月 ${series.day_of_month} 号`;
}

/**
 * 建系列并把未来 horizonMonths 期一次性铺出来。
 * 调用方负责外层事务（tx 不能嵌套）。
 */
export function createSeries(db, input, recurrence) {
  if (recurrence.rule !== 'monthly') return createRollingSeries(db, input, recurrence);
  const now = nowIso();
  const id = uid();
  const startMonth = recurrence.startMonth;
  // 水位先退到起始月的前一个月，fillSeries 从 nextMonth(watermark) 开始铺
  const before = addMonths(startMonth, -1);
  db.prepare(
    `INSERT INTO task_series (id, title, notes_md, category_id, priority, due_time, estimate_min,
        rule, day_of_month, start_month, horizon_months, watermark_month, status, created_at, updated_at, rev)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,1)`
  ).run(
    id,
    input.title,
    input.notesMd || '',
    input.categoryId || 'cat-inbox',
    input.priority,
    input.dueTime || null,
    input.estimateMin || null,
    recurrence.rule,
    recurrence.dayOfMonth,
    startMonth,
    recurrence.horizonMonths,
    before,
    now,
    now
  );

  let folder = null;
  let linkError = null;
  if (input.folder) {
    try {
      folder = validateUserPath(input.folder, 'folder');
    } catch (err) {
      linkError = err?.message || '文件夹路径不可用';
    }
  }

  const target = addMonths(startMonth, recurrence.horizonMonths - 1);
  const created = fillSeries(db, getSeriesRow(db, id), target, {
    tags: input.tags || null,
    folder,
  });

  logEvent(db, firstTaskOrSeries(created, id), 'series_created', { series: id, count: created.length });
  return { series: getSeriesRow(db, id), occurrences: created.length, firstTaskId: created[0] || null };
}

function firstTaskOrSeries(created, seriesId) {
  return created[0] || seriesId;
}

function resolveFolder(input) {
  if (!input.folder) return { folder: null, linkError: null };
  try {
    return { folder: validateUserPath(input.folder, 'folder'), linkError: null };
  } catch (err) {
    return { folder: null, linkError: err?.message || '文件夹路径不可用' };
  }
}

function attachFolderAndTags(db, taskId, folder, tags, now) {
  if (folder) {
    db.prepare(
      `INSERT INTO task_link (id, task_id, kind, path, label, is_primary, exists_state, last_verified_at,
          missing_since, open_count, created_at)
       VALUES (?,?,'folder',?,?,1,?,?,?,0,?)`
    ).run(uid(), taskId, folder.path, folder.label, folder.existsState, folder.existsState === 'missing' ? now : null, now);
  }
  const insTag = db.prepare(
    'INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?, (SELECT id FROM tag WHERE name = ?))'
  );
  for (const tag of tags || []) insTag.run(taskId, String(tag).trim());
}

/**
 * 每日/每周周期：只建一条活行（task.series_id 指回来），不铺跑道。
 * 完成时由 rollSeriesOccurrence 复制出历史行、把活行滚到下一期。
 */
function createRollingSeries(db, input, rec) {
  const now = nowIso();
  const id = uid();
  db.prepare(
    `INSERT INTO task_series (id, title, notes_md, category_id, priority, due_time, estimate_min,
        rule, interval_n, weekday, day_of_month, start_month, horizon_months, watermark_month,
        next_on, repeat_done_count, last_done_at, status, created_at, updated_at, rev)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,0,NULL,'active',?,?,1)`
  ).run(
    id,
    input.title,
    input.notesMd || '',
    input.categoryId || 'cat-inbox',
    input.priority,
    input.dueTime || null,
    input.estimateMin || null,
    rec.rule,
    rec.intervalN,
    rec.weekday,
    rec.dayOfMonth,
    rec.startMonth,
    rec.startMonth,
    rec.startDate,
    now,
    now
  );

  const taskId = uid();
  db.prepare(
    `INSERT INTO task (id, series_id, occur_month, title, notes_md, category_id, status, priority,
        due_on, due_time, estimate_min, created_at, updated_at, last_touched_at, rev, sort_order)
     VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?,?,1,0)`
  ).run(
    taskId,
    id,
    rec.startMonth,
    input.title,
    input.notesMd || '',
    input.categoryId || 'cat-inbox',
    input.priority,
    rec.startDate,
    input.dueTime || null,
    input.estimateMin || null,
    now,
    now,
    now
  );

  const { folder, linkError } = resolveFolder(input);
  attachFolderAndTags(db, taskId, folder, input.tags, now);
  logEvent(db, taskId, 'series_created', { series: id, rule: rec.rule, at: rec.startDate });
  const series = getSeriesRow(db, id);
  return {
    series: series ? { ...series, rule_label: ruleLabel(series) } : null,
    occurrences: 1,
    firstTaskId: taskId,
    linkError,
  };
}

/**
 * 滚动到下一期：严格晚于今天；中途漏掉的期直接跳过，绝不堆一摞逾期副本。
 */
export function nextRollingDate(dueOn, rule, interval, today = localDate()) {
  let d = /^\d{4}-\d{2}-\d{2}$/.test(String(dueOn)) ? String(dueOn) : today;
  do {
    d = stepRolling(d, rule, interval);
  } while (d <= today);
  return d;
}

/**
 * 每日/每周周期完成一次：
 *  1) 当期照抄成一条 done 历史行（归档、已完成、统计全部照旧）；
 *  2) 活行滚到下一期继续 open；提醒时间跟着日期一起平移。
 * 调用方负责外层事务。
 */
export function rollSeriesOccurrence(db, task, now = nowIso(), today = localDate()) {
  const series = getSeriesRow(db, task.series_id);
  if (!series) throw notFound('例行系列不存在');
  if (series.rule === 'monthly') throw bad('每月例行不会滚动', 'BAD_RULE');

  const fromDate = task.due_on || today;
  const next = nextRollingDate(fromDate, series.rule, series.interval_n, today);

  const ghostId = uid();
  db.prepare(
    `INSERT INTO task (id, series_id, occur_month, title, notes_md, category_id, status, priority,
        due_on, due_time, estimate_min, actual_min, done_note, created_at, updated_at, last_touched_at,
        completed_at, rev, sort_order)
     VALUES (?,?,?,?,?,?,'done',?,?,?,?,?,?,?,?,?,?,1,0)`
  ).run(
    ghostId,
    series.id,
    monthOf(fromDate),
    task.title,
    task.notes_md || '',
    task.category_id,
    task.priority,
    fromDate,
    task.due_time || null,
    task.estimate_min || null,
    task.actual_min || null,
    task.done_note || '',
    task.created_at || now,
    now,
    now,
    now
  );
  db.prepare('INSERT OR IGNORE INTO task_tag (task_id, tag_id) SELECT ?, tag_id FROM task_tag WHERE task_id = ?').run(
    ghostId,
    task.id
  );
  const links = db.prepare('SELECT * FROM task_link WHERE task_id = ?').all(task.id);
  const insLink = db.prepare(
    `INSERT INTO task_link (id, task_id, kind, path, label, is_primary, exists_state, last_verified_at,
        missing_since, open_count, last_opened_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const l of links) {
    insLink.run(uid(), ghostId, l.kind, l.path, l.label, l.is_primary, l.exists_state, l.last_verified_at,
      l.missing_since, l.open_count, l.last_opened_at, l.created_at || now);
  }

  // 提醒时间跟着日期平移同样的天数，否则滚到下一期后提醒还停在上一期
  let nextRemind = null;
  let remindFired = 0;
  if (task.remind_at) {
    const delta = diffDays(fromDate, next);
    nextRemind = addDaysStr(String(task.remind_at).slice(0, 10), delta) + String(task.remind_at).slice(10);
  }

  db.prepare(
    `UPDATE task SET due_on = ?, occur_month = ?, remind_at = ?, remind_fired = ?,
        updated_at = ?, last_touched_at = ?, rev = rev + 1
      WHERE id = ?`
  ).run(next, monthOf(next), nextRemind, remindFired, now, now, task.id);
  db.prepare(
    `UPDATE task_series SET next_on = ?, repeat_done_count = repeat_done_count + 1, last_done_at = ?,
        updated_at = ?, rev = rev + 1
      WHERE id = ?`
  ).run(next, now, now, series.id);

  logEvent(db, ghostId, 'completed', { series: series.id, rolling: true, next });
  logEvent(db, task.id, 'repeated', { series: series.id, next, doneCount: series.repeat_done_count + 1 });

  return {
    ghost: db.prepare('SELECT * FROM task WHERE id = ?').get(ghostId),
    next,
    doneCount: series.repeat_done_count + 1,
    series: getSeriesRow(db, series.id),
  };
}

/**
 * 日历虚拟展开：把 [from,to] 里「还没落成行」的周期期补出来（纯读，不写库）。
 * 只补活行之后的日期 —— 活行本身就是真实条目。
 */
export function virtualOccurrences(db, from, to) {
  const out = [];
  const rows = db
    .prepare(
      `SELECT s.id AS series_id, s.title, s.priority, s.due_time, s.rule, s.interval_n, t.due_on,
              c.name AS category_name, c.color AS category_color
         FROM task_series s
         JOIN task t ON t.id = (
           SELECT id FROM task
            WHERE series_id = s.id AND deleted_at IS NULL AND status IN ('open','doing')
            ORDER BY due_on LIMIT 1
         )
         LEFT JOIN category c ON c.id = s.category_id
        WHERE s.status = 'active' AND s.rule <> 'monthly'`
    )
    .all();
  for (const s of rows) {
    if (!s.due_on) continue;
    let d = s.due_on;
    for (let i = 0; i < 400; i += 1) {
      d = stepRolling(d, s.rule, s.interval_n);
      if (d > to) break;
      if (d >= from) {
        out.push({
          id: `virt:${s.series_id}:${d}`,
          title: s.title,
          priority: s.priority,
          due_on: d,
          due_time: s.due_time,
          series_id: s.series_id,
          rule: s.rule,
          category_name: s.category_name,
          category_color: s.category_color,
          child_count: 0,
          child_done: 0,
          virtual: true,
        });
      }
    }
  }
  return out;
}

/**
 * 从水位之后补到 targetMonth，幂等：插入前先查这一期是否已经有行。
 * （v6 起 ux_task_series_occur 降级成普通索引 —— 每日/每周会在同一个月里留下多条行，
 *  所以幂等不能再靠唯一索引兜底，改成显式 SELECT。）
 * 返回新建出来的 task id 列表。
 */
export function fillSeries(db, series, targetMonth, opts = {}) {
  const out = [];
  if (!series || series.status !== 'active') return out;
  if (series.rule !== 'monthly') return out; // 滚动系列没有跑道
  const from = nextMonth(series.watermark_month);
  if (from > targetMonth) return out;
  // 只有「这个月和下个月」的期是真待办；更远的先挂成 scheduled，
  // 免得 36 条一模一样的任务把列表挤满。到期前由 refillAllSeries 抬成 open。
  const promoteUntil = addMonths(monthOf(localDate()), 1);

  const ins = db.prepare(
    `INSERT INTO task (id, series_id, occur_month, title, notes_md, category_id, status, priority,
        due_on, due_time, estimate_min, created_at, updated_at, last_touched_at, rev, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)`
  );
  const exists = db.prepare('SELECT 1 AS hit FROM task WHERE series_id = ? AND occur_month = ? LIMIT 1');
  const insLink = db.prepare(
    `INSERT INTO task_link (id, task_id, kind, path, label, is_primary, exists_state, last_verified_at,
        missing_since, open_count, created_at)
     VALUES (?,?,'folder',?,?,1,?,?,?,0,?)`
  );
  const insTag = db.prepare(
    'INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?, (SELECT id FROM tag WHERE name = ?))'
  );
  const now = nowIso();
  const folder = opts.folder || null;

  for (let ym = from; ym <= targetMonth; ym = nextMonth(ym)) {
    const due = occurrenceOn(ym, series.day_of_month);
    const id = uid();
    if (exists.get(series.id, ym)) continue; // 这一期已有行（软删也算），保留用户对它的改动
    ins.run(
      id,
      series.id,
      ym,
      series.title,
      series.notes_md,
      series.category_id,
      ym <= promoteUntil ? 'open' : 'scheduled',
      series.priority,
      due,
      series.due_time,
      series.estimate_min,
      now,
      now,
      now
    );
    out.push(id);
    if (folder) {
      insLink.run(uid(), id, folder.path, folder.label, folder.existsState, folder.existsState === 'missing' ? now : null, now);
    }
    for (const tag of opts.tags || []) insTag.run(id, String(tag).trim());
  }

  // 水位条件更新：只有还是旧值才前进，天然单调
  db.prepare('UPDATE task_series SET watermark_month = ?, updated_at = ? WHERE id = ? AND watermark_month = ?').run(
    targetMonth,
    now,
    series.id,
    series.watermark_month
  );
  return out;
}

function getSeriesRow(db, id) {
  return db.prepare('SELECT * FROM task_series WHERE id = ?').get(id);
}

export function getSeries(db, id) {
  const row = getSeriesRow(db, id);
  if (!row) throw notFound('例行系列不存在');
  return row;
}

export function listSeries(db) {
  const rows = db
    .prepare(
      `SELECT s.*,
         (SELECT count(*) FROM task t WHERE t.series_id = s.id AND t.deleted_at IS NULL) AS total_count,
         (SELECT count(*) FROM task t WHERE t.series_id = s.id AND t.deleted_at IS NULL AND t.status IN ('open','doing')) AS open_count,
         (SELECT count(*) FROM task t WHERE t.series_id = s.id AND t.deleted_at IS NULL AND t.status = 'scheduled') AS scheduled_count,
         (SELECT count(*) FROM task t WHERE t.series_id = s.id AND t.deleted_at IS NULL AND t.status = 'done') AS done_count,
         (SELECT min(t.due_on) FROM task t WHERE t.series_id = s.id AND t.deleted_at IS NULL AND t.status IN ('open','doing')) AS next_on
       FROM task_series s
       ORDER BY s.status ASC, s.created_at DESC`
    )
    .all();
  return rows.map((s) => ({ ...s, rule_label: ruleLabel(s) }));
}

export function seriesOccurrences(db, id) {
  return db
    .prepare(
      `SELECT id, due_on, status, occur_month, deleted_at, completed_at, archived_path
       FROM task WHERE series_id = ? ORDER BY due_on ASC, completed_at ASC`
    )
    .all(id);
}

/** scope='future' 只取消今天之后的；'all' 连逾期的也一起取消。已完成的永远不动。 */
export function cancelSeries(db, id, scope = 'future', today = localDate()) {
  const s = getSeries(db, id);
  const now = nowIso();
  db.prepare("UPDATE task_series SET status = 'cancelled', updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, id);
  // 滚动系列只有一条活行：取消就是把它作废，不用按日期挑
  if (s.rule !== 'monthly') {
    const r = db
      .prepare(
        `UPDATE task SET status = 'dropped', dropped_at = ?, updated_at = ?, last_touched_at = ?, rev = rev + 1
         WHERE series_id = ? AND deleted_at IS NULL AND status IN ('open','doing','scheduled')`
      )
      .run(now, now, now, id);
    return { cancelled: r.changes, series: getSeriesRow(db, id) };
  }
  const where = ["series_id = ?", 'deleted_at IS NULL', "status IN ('open','doing','scheduled')"];
  const params = [id];
  if (scope !== 'all') {
    where.push('due_on > ?');
    params.push(today);
  }
  const r = db
    .prepare(
      `UPDATE task SET status = 'dropped', dropped_at = ?, updated_at = ?, last_touched_at = ?, rev = rev + 1
       WHERE ${where.join(' AND ')}`
    )
    .run(now, now, now, ...params);
  return { cancelled: r.changes, series: getSeriesRow(db, id) };
}

export function resumeSeries(db, id) {
  const s = getSeries(db, id);
  const now = nowIso();
  db.prepare("UPDATE task_series SET status = 'active', updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, id);
  if (s.rule !== 'monthly') {
    const r = db
      .prepare(
        `UPDATE task SET status = 'open', dropped_at = NULL, updated_at = ?, last_touched_at = ?, rev = rev + 1
         WHERE series_id = ? AND status = 'dropped' AND deleted_at IS NULL`
      )
      .run(now, now, id);
    // 取消期间漏掉的期直接跳过：活行还停在过去就滚到今天之后，免得一恢复就是逾期的
    const row = db
      .prepare("SELECT * FROM task WHERE series_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY due_on LIMIT 1")
      .get(id);
    if (row && row.due_on && row.due_on < localDate()) {
      const next = nextRollingDate(row.due_on, s.rule, s.interval_n, localDate());
      db.prepare('UPDATE task SET due_on = ?, occur_month = ?, updated_at = ?, last_touched_at = ?, rev = rev + 1 WHERE id = ?').run(
        next, monthOf(next), now, now, row.id
      );
      db.prepare('UPDATE task_series SET next_on = ? WHERE id = ?').run(next, id);
    }
    return { resumed: r.changes, series: getSeriesRow(db, id) };
  }
  const promoteUntil = addMonths(monthOf(localDate()), 1);
  const r = db
    .prepare(
      `UPDATE task SET status = CASE WHEN occur_month > ? THEN 'scheduled' ELSE 'open' END,
         dropped_at = NULL, updated_at = ?, last_touched_at = ?, rev = rev + 1
       WHERE series_id = ? AND status = 'dropped' AND deleted_at IS NULL AND due_on >= ?`
    )
    .run(promoteUntil, now, now, id, localDate());
  return { resumed: r.changes, series: getSeriesRow(db, id) };
}

/**
 * 滚动补齐：让每个 active 系列保持「未来 horizon 期」的跑道。
 * 返回新建条数。调用方负责事务。
 */
/**
 * 排期/唤醒：把「还早的期」收回 scheduled，把「本月与下月的期」抬成 open。
 * 每次启动都要跑（很便宜），不受 6 小时补跑道的节流限制。
 */
export function promoteSeriesOccurrences(db, today = localDate()) {
  const promoteUntil = addMonths(monthOf(today), 1);
  const now = nowIso();
  const monthlyOnly = "AND series_id IN (SELECT id FROM task_series WHERE rule = 'monthly')";
  // 1) 把「还早的期」收回排期区（老库里的历史行也一并归位，避免 36 条刷屏）
  const shelved = db
    .prepare(
      `UPDATE task SET status = 'scheduled', updated_at = ?
        WHERE series_id IS NOT NULL AND status IN ('open','doing')
          AND deleted_at IS NULL AND occur_month > ? ${monthlyOnly}`
    )
    .run(now, promoteUntil).changes;
  // 2) 到月份的期重新变成待办
  const promoted = db
    .prepare(
      `UPDATE task SET status = 'open', updated_at = ?
        WHERE series_id IS NOT NULL AND status = 'scheduled'
          AND deleted_at IS NULL AND occur_month <= ? ${monthlyOnly}`
    )
    .run(now, promoteUntil).changes;
  return { shelved, promoted, promoteUntil };
}

export function refillAllSeries(db, today = localDate()) {
  const thisMonth = monthOf(today);
  let created = 0;
  let touched = 0;

  promoteSeriesOccurrences(db, today);

  for (const s of db.prepare("SELECT * FROM task_series WHERE status = 'active' AND rule = 'monthly'").all()) {
    const target = addMonths(thisMonth, s.horizon_months - 1);
    const made = fillSeries(db, s, target);
    if (made.length) {
      created += made.length;
      touched += 1;
    }
  }
  return { created, touched };
}

/** 整系列删掉（测试与「彻底不要了」用）：先删成员再删系列 */
export function deleteSeriesRow(db, id) {
  getSeries(db, id);
  db.prepare('DELETE FROM task WHERE series_id = ?').run(id);
  db.prepare('DELETE FROM task_series WHERE id = ?').run(id);
}

export function conflictIfStale(series, rev) {
  if (rev !== undefined && rev !== null && Number(rev) !== series.rev) {
    throw conflict('这个例行系列刚被改过，请刷新后重试', { current: series });
  }
}
