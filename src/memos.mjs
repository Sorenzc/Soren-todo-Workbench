// 速记（便签）：和待办是两个库，只做「记下来、找得到、能改成待办」三件事
import { bad, conflict, clampStr, nowIso, notFound, uid } from './util.mjs';

const MAX_BODY = 4000;
const MAX_LIMIT = 500;

const ROW = 'SELECT id, body, pinned, created_at, updated_at, rev, deleted_at FROM memo';

function normBody(v) {
  const body = String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) throw bad('速记内容不能为空', 'EMPTY_MEMO');
  if (body.length > MAX_BODY) throw bad(`速记最多 ${MAX_BODY} 个字`, 'MEMO_TOO_LONG');
  return body;
}

/** 列表：置顶的在前，其余按记下来的时间倒序；q 做正文包含匹配 */
export function listMemos(db, opts = {}) {
  const { q = '', limit = 200 } = opts;
  const where = ['deleted_at IS NULL'];
  const args = [];
  const kw = String(q || '').trim();
  if (kw) {
    where.push('body LIKE ?');
    args.push(`%${kw.replace(/[%_]/g, '')}%`);
  }
  const capped = Math.min(Math.max(Number(limit) || 200, 1), MAX_LIMIT);
  return db
    .prepare(`${ROW} WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ${capped}`)
    .all(...args);
}

export function getMemo(db, id) {
  const row = db.prepare(`${ROW} WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) throw notFound('这条速记不存在，可能已经删掉了');
  return row;
}

export function countMemos(db) {
  const row = db.prepare('SELECT count(*) AS n FROM memo WHERE deleted_at IS NULL').get();
  return Number(row?.n || 0);
}

export function createMemo(db, raw = {}) {
  const body = normBody(raw.body ?? raw.text);
  const now = nowIso();
  const id = uid();
  db.prepare(
    'INSERT INTO memo (id, body, pinned, created_at, updated_at, rev) VALUES (?,?,?,?,?,1)'
  ).run(id, body, raw.pinned ? 1 : 0, now, now);
  return getMemo(db, id);
}

export function patchMemo(db, id, rawPatch = {}, rev) {
  const row = db.prepare(`${ROW} WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) throw notFound('这条速记不存在，可能已经删掉了');
  if (rev !== undefined && rev !== null && Number(rev) !== Number(row.rev)) {
    throw conflict('这条速记刚在别处改过，刷新一下吧', { current: getMemo(db, id) });
  }
  const sets = [];
  const args = [];
  if (rawPatch.body !== undefined) {
    sets.push('body = ?');
    args.push(normBody(rawPatch.body));
  }
  if (rawPatch.pinned !== undefined) {
    sets.push('pinned = ?');
    args.push(rawPatch.pinned ? 1 : 0);
  }
  if (!sets.length) return getMemo(db, id);
  sets.push('updated_at = ?', 'rev = rev + 1');
  args.push(nowIso());
  db.prepare(`UPDATE memo SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getMemo(db, id);
}

export function softDeleteMemo(db, id) {
  const row = db.prepare(`${ROW} WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) throw notFound('这条速记不存在，可能已经删掉了');
  db.prepare('UPDATE memo SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  return { ok: true, id };
}

export function restoreMemo(db, id) {
  const row = db.prepare('SELECT id, deleted_at FROM memo WHERE id = ?').get(id);
  if (!row) throw notFound('这条速记不存在');
  db.prepare('UPDATE memo SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getMemo(db, id);
}

export function purgeMemo(db, id) {
  const row = db.prepare('SELECT id FROM memo WHERE id = ?').get(id);
  if (!row) throw notFound('这条速记不存在');
  db.prepare('DELETE FROM memo WHERE id = ?').run(id);
  return { ok: true, id };
}

/** 回收站：软删掉的速记 */
export function listDeletedMemos(db, limit = 200) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), MAX_LIMIT);
  return db
    .prepare(`${ROW} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ${cap}`)
    .all();
}

/** 速记转待办时用的默认标题：取第一行，太长就截断 */
export function memoAsTaskTitle(memo) {
  const first = String(memo?.body || '').split('\n')[0].trim();
  return clampStr(first, 200);
}
