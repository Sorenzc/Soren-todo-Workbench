// 领域仓储：任务 / 分类 / 标签 / 关联 / 搜索
import { addDays, bad, camelize, clampStr, conflict, localDate, notFound, nowIso, pad2, PRIORITY_SHORT, uid } from './util.mjs';
import { logEvent, tx } from './db.mjs';
import { validateUserPath } from './paths.mjs';
import { createSeries, normRecurrence } from './series.mjs';

const ROW_SELECT = `
  SELECT t.*, c.name AS category_name, c.color AS category_color,
    (SELECT count(*) FROM task_link l WHERE l.task_id = t.id) AS link_count,
    (SELECT l.id FROM task_link l WHERE l.task_id = t.id AND l.is_primary = 1) AS primary_link_id,
    (SELECT l.exists_state FROM task_link l WHERE l.task_id = t.id AND l.is_primary = 1) AS primary_link_state,
    (SELECT group_concat(g.name, ' ') FROM task_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tag_names,
    (SELECT count(*) FROM task ch WHERE ch.parent_id = t.id AND ch.deleted_at IS NULL) AS child_count,
    (SELECT count(*) FROM task ch WHERE ch.parent_id = t.id AND ch.deleted_at IS NULL AND ch.status = 'done') AS child_done
  FROM task t LEFT JOIN category c ON c.id = t.category_id
`;

export function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function normDate(v, field = 'due_on') {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!isRealDate(s)) throw bad(`${field} 不是合法日期（YYYY-MM-DD）`, 'INVALID_DATE');
  return s;
}

function normTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw bad('时间格式应为 HH:MM', 'INVALID_TIME');
  return s;
}

/** 提醒时间统一成 'YYYY-MM-DDTHH:MM'（本地时间，字典序即时间序），与 datetime-local 同形 */
function normRemind(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(s);
  if (!m || !isRealDate(m[1])) throw bad('提醒时间格式应为 YYYY-MM-DDTHH:MM', 'INVALID_REMIND_AT');
  return `${m[1]}T${m[2]}:${m[3]}`;
}

/* ------------------------------- 分类 ------------------------------- */

export function listCategories(db) {
  return db
    .prepare(
      `SELECT c.*,
         (SELECT count(*) FROM task t WHERE t.category_id = c.id AND t.status IN ('open','doing') AND t.deleted_at IS NULL AND t.parent_id IS NULL) AS open_count,
         (SELECT count(*) FROM task t WHERE t.category_id = c.id AND t.status = 'done' AND t.deleted_at IS NULL AND t.parent_id IS NULL) AS done_count
       FROM category c
       ORDER BY c.sort_order, c.name`
    )
    .all();
}

export function createCategory(db, raw = {}) {
  const { name, color, parentId, sortOrder } = camelize(raw);
  const clean = clampStr(String(name ?? '').trim(), 40);
  if (!clean) throw bad('分类名不能为空');
  const dup = db
    .prepare("SELECT id FROM category WHERE name = ? AND ifnull(parent_id,'') = ifnull(?, '')")
    .get(clean, parentId ?? null);
  if (dup) throw conflict('同名分类已存在', { id: dup.id });
  const id = uid();
  const now = nowIso();
  db.prepare(
    'INSERT INTO category (id, parent_id, name, color, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, parentId ?? null, clean, color || '#6B7280', sortOrder ?? 100, now, now);
  return db.prepare('SELECT * FROM category WHERE id = ?').get(id);
}

export function updateCategory(db, id, rawPatch) {
  const patch = camelize(rawPatch);
  const row = db.prepare('SELECT * FROM category WHERE id = ?').get(id);
  if (!row) throw notFound('分类不存在');
  const name = patch.name !== undefined ? clampStr(String(patch.name).trim(), 40) : row.name;
  if (!name) throw bad('分类名不能为空');
  const color = patch.color !== undefined ? patch.color : row.color;
  const sortOrder = patch.sortOrder !== undefined ? Number(patch.sortOrder) : row.sort_order;
  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (patch.parentId === id) throw bad('分类不能以自己为父节点');
  }
  db.prepare('UPDATE category SET name = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
    name,
    color,
    Number.isFinite(sortOrder) ? sortOrder : row.sort_order,
    nowIso(),
    id
  );
  return db.prepare('SELECT * FROM category WHERE id = ?').get(id);
}

export function deleteCategory(db, id) {
  const row = db.prepare('SELECT * FROM category WHERE id = ?').get(id);
  if (!row) throw notFound('分类不存在');
  if (id === 'cat-inbox') throw bad('系统分类「收件箱」不可删除', 'SYSTEM_CATEGORY');
  const n = db.prepare('SELECT count(*) AS n FROM task WHERE category_id = ? AND deleted_at IS NULL').get(id);
  db.prepare("UPDATE task SET category_id = 'cat-inbox', updated_at = ?, rev = rev + 1 WHERE category_id = ?").run(
    nowIso(),
    id
  );
  db.prepare('DELETE FROM category WHERE id = ?').run(id);
  return { deleted: id, migratedTasks: Number(n?.n ?? 0) };
}

/* ------------------------------- 标签 ------------------------------- */

export function listTags(db) {
  return db
    .prepare(
      `SELECT g.*, (SELECT count(*) FROM task_tag tt JOIN task t ON t.id = tt.task_id
                    WHERE tt.tag_id = g.id AND t.deleted_at IS NULL) AS task_count
       FROM tag g ORDER BY g.name`
    )
    .all();
}

export function setTaskTags(db, taskId, names) {
  const list = (Array.isArray(names) ? names : String(names ?? '').split(/[,，\s]+/))
    .map((s) => String(s).trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 12);
  db.prepare('DELETE FROM task_tag WHERE task_id = ?').run(taskId);
  for (const name of list) {
    let tag = db.prepare('SELECT id FROM tag WHERE name = ?').get(name);
    if (!tag) {
      const id = uid();
      db.prepare('INSERT INTO tag (id, name, created_at) VALUES (?,?,?)').run(id, name.slice(0, 20), nowIso());
      tag = { id };
    }
    db.prepare('INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?,?)').run(taskId, tag.id);
  }
}

export function taskTags(db, taskId) {
  return db
    .prepare('SELECT g.id, g.name FROM task_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.task_id = ? ORDER BY g.name')
    .all(taskId);
}

/* ------------------------------- 任务 ------------------------------- */

export function listTasks(db, opts = {}) {
  const { status = 'open', categoryId, tag, q, due, doneOn, parentId, limit = 300 } = opts;
  const where = ['t.deleted_at IS NULL'];
  const params = [];

  if (status === 'done') {
    where.push("t.status = 'done'");
  } else if (status === 'all') {
    where.push("t.status <> 'dropped'");
  } else if (status === 'dropped') {
    where.push("t.status = 'dropped'");
  } else {
    where.push("t.status IN ('open','doing')");
  }

  // 子待办只在父任务详情里出现：默认列表排除，否则子条会混进「全部待办」，
  // 逾期数与统计也会虚高。parentId=null 表示只要子项，parentId='xxx' 表示取某父的子项。
  if (parentId === undefined) {
    where.push('t.parent_id IS NULL');
  } else if (parentId === null) {
    where.push('t.parent_id IS NOT NULL');
  } else {
    where.push('t.parent_id = ?');
    params.push(parentId);
  }

  if (categoryId) {
    where.push('t.category_id = ?');
    params.push(categoryId);
  }
  if (tag) {
    where.push(
      'EXISTS (SELECT 1 FROM task_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)'
    );
    params.push(tag);
  }
  if (q) {
    where.push('(t.title LIKE ? OR t.notes_md LIKE ?)');
    const kw = `%${String(q).replace(/[%_]/g, '')}%`;
    params.push(kw, kw);
  }

  const today = localDate();
  if (due === 'overdue') {
    where.push('t.due_on IS NOT NULL AND t.due_on < ?');
    params.push(today);
  } else if (due === 'today') {
    where.push('t.due_on = ?');
    params.push(today);
  } else if (due === 'soon') {
    where.push('t.due_on > ? AND t.due_on <= ?');
    params.push(today, addDays(today, 3));
  } else if (due === 'week') {
    where.push('t.due_on >= ? AND t.due_on <= ?');
    params.push(today, addDays(today, 7));
  } else if (due === 'nodate') {
    where.push('t.due_on IS NULL');
  } else if (typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    where.push('t.due_on = ?');
    params.push(due);
  }

  // 「某一天完成」：completed_at 是带本地偏移的 ISO 串（2026-10-19T11:40:00+08:00），
  // 它的前 10 位就是本地日历日。这里用区间谓词而不是 substr/date()：
  // 区间能走 ix_task_done_at 索引，而 date() 会先归一到 UTC，08:00 前完成的任务会被算到前一天。
  if (doneOn) {
    where.push('t.completed_at >= ? AND t.completed_at < ?');
    params.push(doneOn, addDays(doneOn, 1));
  }

  const order =
    status === 'done'
      ? 't.completed_at DESC'
      // 置顶最前；手动排序（sort_order > 0 表示拖过）优先于默认的「优先级 → 到期」口径
      : 't.pinned DESC, t.sort_order DESC, t.priority ASC, t.due_on IS NULL, t.due_on ASC, t.created_at ASC, t.id ASC';

  const sql = `${ROW_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
  return db.prepare(sql).all(...params, Math.min(Number(limit) || 300, 1000));
}

/* --------------------------- 日历（区间聚合） --------------------------- */
// 只给「哪几天有几件事」这份计数，日历格子用；不放任务正文，避免和列表接口抢职责。
export function calendarCounts(db, from, to) {
  const rows = db
    .prepare(
      `SELECT t.due_on AS d, count(*) AS n
         FROM task t
        WHERE t.deleted_at IS NULL AND t.status IN ('open','doing') AND t.parent_id IS NULL
          AND t.due_on IS NOT NULL AND t.due_on >= ? AND t.due_on <= ?
        GROUP BY t.due_on`
    )
    .all(from, to);
  const days = {};
  for (const r of rows) days[r.d] = Number(r.n);

  const overdue = db
    .prepare(
      `SELECT count(*) AS n FROM task t
        WHERE t.deleted_at IS NULL AND t.status IN ('open','doing') AND t.parent_id IS NULL
          AND t.due_on IS NOT NULL AND t.due_on < ?`
    )
    .get(from).n;
  const openTotal = db
    .prepare(
      `SELECT count(*) AS n FROM task t WHERE t.deleted_at IS NULL AND t.status IN ('open','doing') AND t.parent_id IS NULL`
    )
    .get().n;

  // 每一天完成了多少件：和「某天完成」列表同一谓词（区间 + 前 10 位日期），保证格子和列表同源
  const doneDays = {};
  const doneRows = db
    .prepare(
      `SELECT substr(t.completed_at, 1, 10) AS d, count(*) AS n
         FROM task t
        WHERE t.deleted_at IS NULL AND t.status = 'done'
          AND t.completed_at >= ? AND t.completed_at < ?
        GROUP BY d`
    )
    .all(from, addDays(to, 1));
  for (const r of doneRows) doneDays[r.d] = Number(r.n);

  return { days, done_days: doneDays, overdue: Number(overdue), open_total: Number(openTotal) };
}

/**
 * 日历格子里的条目：和 calendarCounts 同一口径（未完成、未删、一级任务），
 * 只是把「几条」换成「哪几条」。只给格子画 chip 够用的字段，不塞笔记正文。
 */
export function calendarItems(db, from, to) {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.due_on, t.due_time, t.series_id,
              c.name AS category_name, c.color AS category_color,
              (SELECT count(*) FROM task ch WHERE ch.parent_id = t.id AND ch.deleted_at IS NULL) AS child_count,
              (SELECT count(*) FROM task ch WHERE ch.parent_id = t.id AND ch.deleted_at IS NULL AND ch.status = 'done') AS child_done
         FROM task t LEFT JOIN category c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND t.status IN ('open','doing') AND t.parent_id IS NULL
          AND t.due_on IS NOT NULL AND t.due_on >= ? AND t.due_on <= ?
        ORDER BY t.due_on ASC, t.due_time IS NULL, t.due_time ASC, t.priority ASC, t.created_at ASC`
    )
    .all(from, to);
  const items = {};
  for (const r of rows) (items[r.due_on] || (items[r.due_on] = [])).push(r);
  return items;
}

export function getTask(db, id) {
  const row = db.prepare(`${ROW_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
  if (!row) throw notFound('任务不存在');
  return row;
}

export function getTaskWithRelations(db, id) {
  const task = getTask(db, id);
  return {
    task,
    tags: taskTags(db, id),
    links: listLinks(db, id),
    events: db
      .prepare('SELECT id, type, at, payload FROM task_event WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT 30')
      .all(id),
  };
}

export function createTask(db, raw = {}) {
  const input = camelize(raw);
  const title = clampStr(String(input.title ?? '').trim(), 200);
  if (!title) throw bad('标题不能为空');
  let categoryId = input.categoryId || 'cat-inbox';
  const cat = db.prepare('SELECT id FROM category WHERE id = ?').get(categoryId);
  if (!cat) categoryId = 'cat-inbox';

  let priority = Number(input.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) priority = 2;

  const normalized = {
    title,
    notesMd: String(input.notesMd ?? ''),
    categoryId,
    priority,
    dueTime: normTime(input.dueTime),
    estimateMin: input.estimateMin ? Math.max(1, Number(input.estimateMin)) : null,
    tags: input.tags || null,
    folder: input.folder || null,
    remindAt: normRemind(input.remindAt),
  };

  // 子待办：只允许一层（父自己必须是一级任务），且不能与每月例行同时出现
  let parentId = null;
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    const parent = db.prepare('SELECT id, parent_id, deleted_at FROM task WHERE id = ?').get(String(input.parentId));
    if (!parent || parent.deleted_at) throw bad('父任务不存在', 'INVALID_PARENT');
    if (parent.parent_id) throw bad('子待办下不能再挂子待办', 'NEST_TOO_DEEP');
    if (input.recurrence) throw bad('子待办不支持每月例行', 'INVALID_PARENT');
    parentId = parent.id;
  }

  // 每月例行：先建系列、铺未来若干期，再把第一期当作这次创建的返回值
  if (input.recurrence) {
    const rec = normRecurrence(input.recurrence);
    const owner = tx(db, () => createSeries(db, normalized, rec));
    const task = getTask(db, owner.firstTaskId);
    return {
      task,
      links: owner.firstTaskId ? listLinks(db, owner.firstTaskId) : [],
      linkError: owner.linkError || null,
      series: owner.series,
      seriesOccurrences: owner.occurrences,
    };
  }

  const id = uid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO task (id, title, notes_md, category_id, status, priority, due_on, due_time,
       estimate_min, created_at, updated_at, last_touched_at, rev, sort_order, parent_id, remind_at)
     VALUES (?,?,?,?,'open',?,?,?,?,?,?,?,1,0,?,?)`
  ).run(
    id,
    title,
    normalized.notesMd,
    categoryId,
    priority,
    normDate(input.dueOn),
    normalized.dueTime,
    normalized.estimateMin,
    now,
    now,
    now,
    parentId,
    normalized.remindAt
  );
  if (input.tags) setTaskTags(db, id, input.tags);
  let linkError = null;
  if (input.folder) {
    try {
      addLink(db, id, { path: input.folder, kind: 'folder', isPrimary: true });
    } catch (err) {
      /* 关联失败不影响创建，但要把原因带回前端，别让用户以为已经关联上了 */
      linkError = err?.message || '文件夹关联失败';
    }
  }
  logEvent(db, id, 'created', { title });
  const task = getTask(db, id);
  return { task, links: listLinks(db, id), linkError };
}

export function patchTask(db, id, rawPatch = {}, rev) {
  const patch = camelize(rawPatch);
  const row = db.prepare('SELECT * FROM task WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw notFound('任务不存在');
  if (rev !== undefined && rev !== null && Number(rev) !== row.rev) {
    throw conflict('内容已变化，请刷新后重试', { current: row });
  }

  const sets = [];
  const params = [];
  const push = (col, val) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.title !== undefined) {
    const t = clampStr(String(patch.title).trim(), 200);
    if (!t) throw bad('标题不能为空');
    push('title', t);
  }
  if (patch.notesMd !== undefined) push('notes_md', String(patch.notesMd ?? '').slice(0, 20000));
  if (patch.categoryId !== undefined) {
    const cat = db.prepare('SELECT id FROM category WHERE id = ?').get(patch.categoryId);
    push('category_id', cat ? cat.id : 'cat-inbox');
  }
  if (patch.priority !== undefined) {
    const p = Number(patch.priority);
    if (!Number.isInteger(p) || p < 0 || p > 3) throw bad('优先级必须是 0-3');
    push('priority', p);
  }
  if (patch.dueOn !== undefined) push('due_on', normDate(patch.dueOn));
  if (patch.dueTime !== undefined) push('due_time', normTime(patch.dueTime));
  if (patch.actualMin !== undefined) push('actual_min', patch.actualMin === null ? null : Number(patch.actualMin));
  if (patch.estimateMin !== undefined)
    push('estimate_min', patch.estimateMin === null ? null : Math.max(1, Number(patch.estimateMin)));
  if (patch.doneNote !== undefined) push('done_note', clampStr(String(patch.doneNote ?? ''), 2000));
  if (patch.sortOrder !== undefined) push('sort_order', Number(patch.sortOrder) || 0);
  if (patch.pinned !== undefined) push('pinned', patch.pinned ? 1 : 0);
  if (patch.remindAt !== undefined) {
    const next = normRemind(patch.remindAt);
    push('remind_at', next);
    // 改了提醒时间就重新武装：否则 remind_fired 还停在 1，新时间永远不会响
    if (next !== row.remind_at) push('remind_fired', 0);
  }

  if (sets.length) {
    const now = nowIso();
    sets.push('updated_at = ?', 'last_touched_at = ?', 'rev = rev + 1');
    params.push(now, now);
    db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    logEvent(db, id, 'updated', { fields: Object.keys(patch) });
  }
  if (patch.tags !== undefined) {
    setTaskTags(db, id, patch.tags);
    logEvent(db, id, 'updated', { fields: ['tags'] });
  }
  return getTask(db, id);
}

export function completeTask(db, id) {
  const row = db.prepare('SELECT * FROM task WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw notFound('任务不存在');
  if (row.status === 'done') return getTask(db, id);
  const now = nowIso();
  db.prepare(
    "UPDATE task SET status = 'done', completed_at = ?, updated_at = ?, last_touched_at = ?, rev = rev + 1 WHERE id = ?"
  ).run(now, now, now, id);
  logEvent(db, id, 'completed', { from: row.status });

  // 子待办单向级联：勾父带子（未完成的子项一并完成）；子项完成不回写父，
  // 父行的进度靠 child_done/child_count 显示。
  if (!row.parent_id) {
    const kids = db
      .prepare(
        "SELECT id FROM task WHERE parent_id = ? AND deleted_at IS NULL AND status IN ('open','doing')"
      )
      .all(id);
    for (const kid of kids) {
      db.prepare(
        "UPDATE task SET status = 'done', completed_at = ?, updated_at = ?, last_touched_at = ?, rev = rev + 1 WHERE id = ?"
      ).run(now, now, now, kid.id);
      logEvent(db, kid.id, 'completed', { cascade: 'parent' });
    }
  }
  return getTask(db, id);
}

export function reopenTask(db, id) {
  const row = db.prepare('SELECT * FROM task WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw notFound('任务不存在');
  // 例行系列被「取消未来」标成 dropped 的期，也能单独恢复成待办
  if (row.status === 'open' || row.status === 'doing') return { task: getTask(db, id), previousArchive: null };
  const now = nowIso();
  // 每日/每周的历史行恢复后就是一条普通待办：留着 series_id 会变成该系列的第二条活行，
  // 和正在滚的那条抢「下一期」。撤销完成也不回滚滚动进度，所以直接断开关系。
  let detach = false;
  if (row.series_id) {
    const s = db.prepare('SELECT rule FROM task_series WHERE id = ?').get(row.series_id);
    detach = Boolean(s && s.rule !== 'monthly');
  }
  const extra = detach ? ', series_id = NULL, occur_month = NULL' : '';
  db.prepare(
    `UPDATE task SET status = 'open', completed_at = NULL, dropped_at = NULL, archived_path = NULL, archive_error = NULL${extra}, updated_at = ?, last_touched_at = ?, rev = rev + 1 WHERE id = ?`
  ).run(now, now, id);
  logEvent(db, id, 'reopened', { from: row.status, detached: detach });
  return { task: getTask(db, id), previousArchive: row.archived_path };
}

/* ------------------------------- 提醒 ------------------------------- */

function localMinute(ms) {
  const d = new Date(ms);
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseLocalMinute(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

/**
 * 抢占到期提醒：只有把 remind_fired 从 0 改成 1 的那一次调用才有资格发通知，
 * 页面内轮询和托盘轮询同时打进来也不会重复提醒。
 * 迟到超过 graceMin 的只标记、不补发——隔了一晚上的闹钟没有意义。
 */
export function claimDueReminders(db, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const graceMin = Number.isFinite(opts.graceMin) ? opts.graceMin : 15;
  const nowMin = localMinute(nowMs);
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.due_on, t.due_time, t.remind_at, c.name AS category_name
         FROM task t LEFT JOIN category c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND t.remind_at IS NOT NULL AND t.remind_fired = 0
          AND t.remind_at <= ? AND t.status IN ('open','doing')
        ORDER BY t.remind_at ASC
        LIMIT 50`
    )
    .all(nowMin);
  if (!rows.length) return [];
  const claim = db.prepare('UPDATE task SET remind_fired = 1, updated_at = ? WHERE id = ? AND remind_fired = 0');
  const updatedAt = nowIso(new Date(nowMs));
  const claimed = [];
  for (const row of rows) {
    const atMs = parseLocalMinute(row.remind_at);
    // 先抢占再判断迟到：抢不到说明别的通道已经发过，直接跳过
    const r = claim.run(updatedAt, row.id);
    if ((r.changes ?? 0) !== 1) continue;
    const lateMin = Number.isFinite(atMs) ? Math.floor((nowMs - atMs) / 60000) : 0;
    if (lateMin > graceMin) continue;
    claimed.push({ ...row, late_min: Math.max(0, lateMin) });
  }
  return claimed;
}

export function setArchivedPath(db, id, relPath, error = null) {
  db.prepare('UPDATE task SET archived_path = ?, archive_error = ? WHERE id = ?').run(relPath, error, id);
  logEvent(db, id, relPath ? 'archived' : 'archive_failed', { path: relPath, error });
}

export function softDelete(db, id) {
  const row = db.prepare('SELECT * FROM task WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw notFound('任务不存在');
  const stamp = nowIso();
  db.prepare('UPDATE task SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(stamp, stamp, id);
  logEvent(db, id, 'deleted', { title: row.title });
  // 删父连带软删子项（同一个时间戳，恢复时按它配对找回），否则子项会变成看不见的孤儿
  if (!row.parent_id) {
    db.prepare(
      'UPDATE task SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE parent_id = ? AND deleted_at IS NULL'
    ).run(stamp, stamp, id);
  }
  return row;
}

export function restoreTask(db, id) {
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id);
  if (!row) throw notFound('任务不存在');
  const stamp = nowIso();
  db.prepare('UPDATE task SET deleted_at = NULL, updated_at = ?, rev = rev + 1 WHERE id = ?').run(stamp, id);
  // 恢复父任务时，把跟着一起删下去的子项按同一时间戳找回；先前单独删掉的子项不跟着复活
  if (!row.parent_id && row.deleted_at) {
    db.prepare(
      'UPDATE task SET deleted_at = NULL, updated_at = ?, rev = rev + 1 WHERE parent_id = ? AND deleted_at = ?'
    ).run(stamp, id, row.deleted_at);
  }
  logEvent(db, id, 'restored', {});
  return getTask(db, id);
}

export function purgeTask(db, id) {
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id);
  if (!row) throw notFound('任务不存在');
  db.prepare('DELETE FROM task WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM task WHERE id = ?').run(id);
  pruneEmptyTags(db);
  return row;
}

/** 标签只跟着任务存在：任务被删光后，没有引用的标签一并清掉，免得标签栏越积越多 */
export function pruneEmptyTags(db) {
  const r = db.prepare('DELETE FROM tag WHERE id NOT IN (SELECT tag_id FROM task_tag)').run();
  return r.changes ?? 0;
}

/**
 * 旧版本经 PowerShell 控制台取路径，中文被解码坏成乱码（含 U+FFFD，原始字节已丢，无法还原）。
 * 这类关联留在库里只会显示一串问号、点了也打不开，统一标成 missing 并提示重新选择。
 */
export function repairGarbledLinks(db) {
  const bad = db
    .prepare(
      "SELECT id FROM task_link WHERE instr(path, char(65533)) > 0 OR instr(label, char(65533)) > 0"
    )
    .all();
  if (!bad.length) return 0;
  const upd = db.prepare("UPDATE task_link SET exists_state = 'missing', label = ? WHERE id = ?");
  for (const row of bad) upd.run('路径乱码，请重新关联', row.id);
  return bad.length;
}

/* ------------------------------- 关联 ------------------------------- */

export function listLinks(db, taskId) {
  return db
    .prepare('SELECT * FROM task_link WHERE task_id = ? ORDER BY is_primary DESC, created_at ASC')
    .all(taskId);
}

export function addLink(db, taskId, raw = {}) {
  const { path: rawPath, kind = 'folder', isPrimary = true, label } = camelize(raw);
  const task = db.prepare('SELECT id FROM task WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!task) throw notFound('任务不存在');
  const v = validateUserPath(rawPath, kind);
  const dup = db.prepare('SELECT id FROM task_link WHERE task_id = ? AND path = ?').get(taskId, v.path);
  if (dup) throw conflict('该路径已关联', { id: dup.id });

  const now = nowIso();
  const id = uid();
  if (isPrimary) db.prepare('UPDATE task_link SET is_primary = 0 WHERE task_id = ?').run(taskId);
  db.prepare(
    `INSERT INTO task_link (id, task_id, kind, path, label, is_primary, exists_state, last_verified_at,
        missing_since, open_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?)`
  ).run(
    id,
    taskId,
    kind,
    v.path,
    label || v.label,
    isPrimary ? 1 : 0,
    v.existsState,
    now,
    v.existsState === 'missing' ? now : null,
    now
  );
  logEvent(db, taskId, 'linked', { path: v.path, kind });
  return db.prepare('SELECT * FROM task_link WHERE id = ?').get(id);
}

export function removeLink(db, linkId) {
  const row = db.prepare('SELECT * FROM task_link WHERE id = ?').get(linkId);
  if (!row) throw notFound('关联不存在');
  db.prepare('DELETE FROM task_link WHERE id = ?').run(linkId);
  const rest = db.prepare('SELECT id FROM task_link WHERE task_id = ? ORDER BY created_at LIMIT 1').get(row.task_id);
  if (rest) db.prepare('UPDATE task_link SET is_primary = 1 WHERE id = ?').run(rest.id);
  logEvent(db, row.task_id, 'unlinked', { path: row.path });
  return row;
}

export function verifyLink(db, linkId) {
  const row = db.prepare('SELECT * FROM task_link WHERE id = ?').get(linkId);
  if (!row) throw notFound('关联不存在');
  let state = 'unknown';
  try {
    const v = validateUserPath(row.path, row.kind);
    state = v.existsState;
  } catch {
    state = 'missing';
  }
  const now = nowIso();
  db.prepare(
    'UPDATE task_link SET exists_state = ?, last_verified_at = ?, missing_since = CASE WHEN ? = \'missing\' THEN coalesce(missing_since, ?) ELSE NULL END WHERE id = ?'
  ).run(state, now, state, now, linkId);
  return db.prepare('SELECT * FROM task_link WHERE id = ?').get(linkId);
}

export function markLinkOpened(db, linkId) {
  db.prepare(
    "UPDATE task_link SET open_count = open_count + 1, last_opened_at = ?, exists_state = 'ok', missing_since = NULL WHERE id = ?"
  ).run(nowIso(), linkId);
}

export function markLinkMissing(db, linkId) {
  const now = nowIso();
  db.prepare(
    "UPDATE task_link SET exists_state = 'missing', last_verified_at = ?, missing_since = coalesce(missing_since, ?) WHERE id = ?"
  ).run(now, now, linkId);
  return db.prepare('SELECT * FROM task_link WHERE id = ?').get(linkId);
}

export function primaryLink(db, taskId) {
  return db
    .prepare('SELECT * FROM task_link WHERE task_id = ? AND is_primary = 1')
    .get(taskId) || db.prepare('SELECT * FROM task_link WHERE task_id = ? LIMIT 1').get(taskId);
}

/* --------------------------- 手动排序 / 导出 --------------------------- */

/**
 * 组内拖拽排序：ids 是拖完之后的最终顺序，sort_order 按倒序写入，
 * 因为列表 ORDER BY 用的是 sort_order DESC（0 = 没排过，靠默认口径）。
 * 只允许排一级任务；子待办的顺序在父任务里另说，不进这个接口。
 */
export function reorderTasks(db, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('ids 需要是非空数组', 'BAD_ORDER');
  if (ids.length > 500) throw bad('一次最多重排 500 条', 'BAD_ORDER');
  const seen = new Set();
  for (const id of ids) {
    const s = String(id || '');
    if (!s || seen.has(s)) throw bad('ids 里有空值或重复项', 'BAD_ORDER');
    seen.add(s);
  }
  const list = [...seen];
  const found = db
    .prepare(
      `SELECT id FROM task WHERE deleted_at IS NULL AND parent_id IS NULL AND id IN (${list.map(() => '?').join(',')})`
    )
    .all(...list);
  if (found.length !== list.length) throw bad('有任务不存在或已被删除', 'BAD_ORDER');
  const now = nowIso();
  const stmt = db.prepare('UPDATE task SET sort_order = ?, updated_at = ?, last_touched_at = ? WHERE id = ?');
  list.forEach((id, i) => stmt.run(list.length - i, now, now, id));
  return list.length;
}

/**
 * 导出当前筛选：和列表同一个 listTasks，参数原样转发，
 * 所以页面上看到什么，导出的 Markdown 就是什么。
 */
export function exportMarkdown(db, opts = {}) {
  const rows = listTasks(db, { ...opts, limit: Math.min(Number(opts.limit) || 1000, 1000) });
  const today = localDate();
  const lines = [`# 待办清单 · ${today}`, '', `按当前筛选导出，共 ${rows.length} 条未完成。`, ''];
  const groups = new Map();
  for (const r of rows) {
    const key = r.category_name || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [cat, items] of groups) {
    lines.push(`## ${cat}（${items.length}）`, '');
    for (const t of items) {
      const bits = [`- [ ] ${t.title}`, `· ${PRIORITY_SHORT[t.priority] ?? 'P2'}`];
      if (t.pinned) bits.push('· 📌 置顶');
      if (t.due_on) bits.push(`· 到期 ${t.due_on}${t.due_time ? ' ' + t.due_time : ''}`);
      if (t.remind_at) bits.push(`· 提醒 ${String(t.remind_at).replace('T', ' ')}`);
      if (t.tag_names) bits.push(`· #${String(t.tag_names).split(' ').join(' #')}`);
      if (t.child_count) bits.push(`· 子项 ${t.child_done || 0}/${t.child_count}`);
      lines.push(bits.join(' '));
    }
    lines.push('');
  }
  if (!rows.length) lines.push('（当前筛选下没有未完成待办）', '');
  lines.push('---', `> 由待办工作台导出 · ${nowIso()}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------- 统计 ------------------------------- */

export function stats(db) {
  const today = localDate();
  // 统计口径一律只看一级任务：子待办跟着父任务完成，算进来会让「今天完成 N 件」虚高
  const openCount = db
    .prepare("SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL")
    .get();
  const overdue = db
    .prepare(
      "SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL AND due_on IS NOT NULL AND due_on < ?"
    )
    .get(today);
  const dueToday = db
    .prepare(
      "SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL AND due_on = ?"
    )
    .get(today);
  const doneTotal = db
    .prepare("SELECT count(*) AS n FROM task WHERE status = 'done' AND deleted_at IS NULL AND parent_id IS NULL")
    .get();
  const doneThisMonth = db
    .prepare(
      "SELECT count(*) AS n FROM task WHERE status = 'done' AND deleted_at IS NULL AND parent_id IS NULL AND substr(completed_at,1,7) = ?"
    )
    .get(today.slice(0, 7));
  const yesterday = db
    .prepare(
      "SELECT count(*) AS n FROM task WHERE status = 'done' AND deleted_at IS NULL AND parent_id IS NULL AND substr(completed_at,1,10) = ?"
    )
    .get(addDays(today, -1));

  const months = db
    .prepare(
      `SELECT substr(completed_at,1,7) AS ym, count(*) AS done_count,
              round(avg(julianday(completed_at) - julianday(created_at)), 1) AS avg_cycle_days
       FROM task WHERE status='done' AND deleted_at IS NULL AND parent_id IS NULL AND completed_at IS NOT NULL
       GROUP BY ym ORDER BY ym DESC LIMIT 12`
    )
    .all()
    .reverse();

  // 分类分布：统计「还没完成」的任务，和页面上的标题一致
  const byCategory = db
    .prepare(
      `SELECT coalesce(c.name,'未分类') AS name, coalesce(c.color,'') AS color, count(*) AS n
       FROM task t LEFT JOIN category c ON c.id = t.category_id
       WHERE t.status IN ('open','doing') AND t.deleted_at IS NULL AND t.parent_id IS NULL
       GROUP BY c.id ORDER BY n DESC LIMIT 8`
    )
    .all();

  const byPriority = db
    .prepare(
      `SELECT priority, count(*) AS n FROM task
       WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL GROUP BY priority ORDER BY priority`
    )
    .all();

  const recentDone = db
    .prepare(
      `${ROW_SELECT} WHERE t.status='done' AND t.deleted_at IS NULL AND t.parent_id IS NULL ORDER BY t.completed_at DESC LIMIT 8`
    )
    .all();

  return {
    today,
    openCount: Number(openCount?.n ?? 0),
    overdue: Number(overdue?.n ?? 0),
    dueToday: Number(dueToday?.n ?? 0),
    doneTotal: Number(doneTotal?.n ?? 0),
    doneThisMonth: Number(doneThisMonth?.n ?? 0),
    doneYesterday: Number(yesterday?.n ?? 0),
    months,
    byCategory,
    byPriority,
    recentDone,
  };
}

// 批量改期：把一组待办一起挪到某天（逾期「全推到明天」用）
// 单条失败不中断，返回 ok/failed，前端统一汇报「已挪好 N 条 / M 条没挪成」
export function bulkReschedule(db, ids, dueOn) {
  if (!Array.isArray(ids) || ids.length === 0) throw bad('没有要改期的待办', 'BAD_IDS');
  if (ids.length > 200) throw bad('一次最多改 200 条', 'BAD_IDS');
  const due = normDate(dueOn);
  const seen = new Set();
  let updated = 0;
  const failed = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    try {
      const row = getTask(db, id);
      if (row.status === 'done' || row.status === 'dropped') {
        failed.push({ id, reason: row.status });
        continue;
      }
      patchTask(db, id, { dueOn: due });
      updated += 1;
    } catch (err) {
      failed.push({ id, reason: String((err && err.message) || err) });
    }
  }
  return { due, updated, failed, total: seen.size };
}

// 提醒「稍后再说」：把 remind_at 往后推，并把 remind_fired 重新武装
export function snoozeTask(db, id, minutes, nowMs = Date.now()) {
  const row = getTask(db, id);
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 1 || mins > 1440) throw bad('稍后的时长要在 1–1440 分钟之间', 'BAD_MINUTES');
  const next = localMinute(nowMs + Math.round(mins) * 60_000);
  db.prepare('UPDATE task SET remind_at = ?, remind_fired = 0, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    id
  );
  logEvent(db, id, 'updated', { snooze: mins, remind_at: next });
  return { task: getTask(db, id), remind_at: next };
}
