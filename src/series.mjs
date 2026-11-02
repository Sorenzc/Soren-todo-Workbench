// 每月例行系列：规则模板 + 把每一期落成 task 表里的普通行
import { bad, conflict, localDate, notFound, nowIso, uid } from './util.mjs';
import { logEvent } from './db.mjs';
import { validateUserPath } from './paths.mjs';
import { addMonths, monthOf, nextMonth, occurrenceOn } from './recur.mjs';

const MAX_HORIZON = 60;

export function normRecurrence(raw) {
  if (!raw) return null;
  const rule = String(raw.rule || 'monthly');
  if (rule !== 'monthly') throw bad('目前只支持每月例行', 'BAD_RULE');
  const day = Number(raw.dayOfMonth ?? raw.day_of_month);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('每月例行要选 1–31 号中的一天', 'BAD_DAY');
  // 起始月份不写就按「从现在开始」算；写成过去的月份也纠正到今天所在月，
  // 免得一次铺出几百条早就过期的期。
  const rawStart = String(raw.startMonth ?? raw.start_month ?? '').slice(0, 7);
  if (rawStart && !/^\d{4}-\d{2}$/.test(rawStart)) throw bad('例行起始月份不合法', 'BAD_MONTH');
  // 起始月份不写就从「第一次发生」所在月开始：今天已经过了本月那一天，
  // 首期就该落在下个月，否则会铺出一条起手就逾期的任务。
  const today = localDate();
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

/**
 * 建系列并把未来 horizonMonths 期一次性铺出来。
 * 调用方负责外层事务（tx 不能嵌套）。
 */
export function createSeries(db, input, recurrence) {
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

/**
 * 从水位之后补到 targetMonth，幂等：靠 ux_task_series_occur 唯一索引兜底。
 * 返回新建出来的 task id 列表。
 */
export function fillSeries(db, series, targetMonth, opts = {}) {
  const out = [];
  if (!series || series.status !== 'active') return out;
  const from = nextMonth(series.watermark_month);
  if (from > targetMonth) return out;
  // 只有「这个月和下个月」的期是真待办；更远的先挂成 scheduled，
  // 免得 36 条一模一样的任务把列表挤满。到期前由 refillAllSeries 抬成 open。
  const promoteUntil = addMonths(monthOf(localDate()), 1);

  const ins = db.prepare(
    `INSERT INTO task (id, series_id, occur_month, title, notes_md, category_id, status, priority,
        due_on, due_time, estimate_min, created_at, updated_at, last_touched_at, rev, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)
     ON CONFLICT(series_id, occur_month) DO NOTHING`
  );
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
    const r = ins.run(
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
    if (!r.changes) continue; // 这一期已有行（软删也算），保留用户对它的改动
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
  return db
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
}

export function seriesOccurrences(db, id) {
  return db
    .prepare(
      `SELECT id, due_on, status, occur_month, deleted_at, completed_at, archived_path
       FROM task WHERE series_id = ? ORDER BY occur_month ASC`
    )
    .all(id);
}

/** scope='future' 只取消今天之后的；'all' 连逾期的也一起取消。已完成的永远不动。 */
export function cancelSeries(db, id, scope = 'future', today = localDate()) {
  const s = getSeries(db, id);
  const now = nowIso();
  db.prepare("UPDATE task_series SET status = 'cancelled', updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, id);
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
  getSeries(db, id);
  const now = nowIso();
  const promoteUntil = addMonths(monthOf(localDate()), 1);
  db.prepare("UPDATE task_series SET status = 'active', updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, id);
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
  // 1) 把「还早的期」收回排期区（老库里的历史行也一并归位，避免 36 条刷屏）
  const shelved = db
    .prepare(
      `UPDATE task SET status = 'scheduled', updated_at = ?
       WHERE series_id IS NOT NULL AND status IN ('open','doing')
         AND deleted_at IS NULL AND occur_month > ?`
    )
    .run(now, promoteUntil).changes;
  // 2) 到月份的期重新变成待办
  const promoted = db
    .prepare(
      `UPDATE task SET status = 'open', updated_at = ?
       WHERE series_id IS NOT NULL AND status = 'scheduled'
         AND deleted_at IS NULL AND occur_month <= ?`
    )
    .run(now, promoteUntil).changes;
  return { shelved, promoted, promoteUntil };
}

export function refillAllSeries(db, today = localDate()) {
  const thisMonth = monthOf(today);
  let created = 0;
  let touched = 0;

  promoteSeriesOccurrences(db, today);

  for (const s of db.prepare("SELECT * FROM task_series WHERE status = 'active'").all()) {
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
