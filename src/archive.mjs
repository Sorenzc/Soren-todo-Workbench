// 归档：已完成的待办 → 真实存在的 Markdown 目录树（按 年/月/日 归集）
import fs from 'node:fs';
import path from 'node:path';
import { monthOf, slugify, shortId } from './util.mjs';
import { PRIORITY_SHORT } from './util.mjs';
import { listLinks, taskTags } from './tasks.mjs';

function relFor(task) {
  const completed = task.completed_at || '';
  const ym = monthOf(completed) || completed.slice(0, 7);
  const year = ym.slice(0, 4);
  const day = completed.slice(0, 10);
  const slug = slugify(task.title, 48);
  return path.posix.join(year, ym, `${day}__${slug}__${shortId(task.id)}.md`);
}

export function archiveTree(db) {
  const rows = db
    .prepare(
      `SELECT substr(completed_at,1,4) AS year, substr(completed_at,1,7) AS ym,
              count(*) AS n, max(completed_at) AS last_at
       FROM task
       WHERE status = 'done' AND deleted_at IS NULL AND completed_at IS NOT NULL AND parent_id IS NULL
       GROUP BY year, ym
       ORDER BY ym DESC`
    )
    .all();
  const years = new Map();
  for (const r of rows) {
    if (!years.has(r.year)) years.set(r.year, { year: r.year, total: 0, months: [] });
    const y = years.get(r.year);
    y.months.push({ ym: r.ym, label: `${Number(r.ym.slice(5, 7))} 月`, count: Number(r.n), last_at: r.last_at });
    y.total += Number(r.n);
  }
  return {
    years: [...years.values()].sort((a, b) => b.year.localeCompare(a.year)),
    total: rows.reduce((s, r) => s + Number(r.n), 0),
  };
}

export function monthTasks(db, ym) {
  return db
    .prepare(
      `SELECT t.*, c.name AS category_name, c.color AS category_color,
              (SELECT count(*) FROM task_link l WHERE l.task_id = t.id) AS link_count,
              (SELECT l.id FROM task_link l WHERE l.task_id = t.id AND l.is_primary = 1) AS primary_link_id,
              (SELECT l.exists_state FROM task_link l WHERE l.task_id = t.id AND l.is_primary = 1) AS primary_link_state
       FROM task t LEFT JOIN category c ON c.id = t.category_id
       WHERE t.status = 'done' AND t.deleted_at IS NULL AND t.parent_id IS NULL
         AND substr(t.completed_at,1,7) = ?
       ORDER BY t.completed_at DESC`
    )
    .all(ym);
}

function humanTime(iso) {
  if (!iso) return '';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function renderTaskMarkdown(db, task) {
  const links = listLinks(db, task.id);
  const tags = taskTags(db, task.id);
  // 子待办不单独建归档文件，作为父任务的 checklist 落到同一个 md 里
  const children = db
    .prepare(
      `SELECT title, status FROM task
        WHERE parent_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`
    )
    .all(task.id);
  const lines = [];
  lines.push(`# ${task.title}`, '');
  lines.push('| 项目 | 内容 |', '| --- | --- |');
  lines.push(`| 完成时间 | ${humanTime(task.completed_at)} |`);
  lines.push(`| 分类 | ${task.category_name || '未分类'} |`);
  lines.push(`| 优先级 | ${PRIORITY_SHORT[task.priority] ?? 'P2'} |`);
  if (tags.length) lines.push(`| 标签 | ${tags.map((t) => t.name).join('、')} |`);
  if (task.due_on) lines.push(`| 计划日期 | ${task.due_on} |`);
  if (task.remind_at) lines.push(`| 提醒 | ${task.remind_at.replace('T', ' ')} |`);
  if (children.length) {
    const doneCount = children.filter((c) => c.status === 'done').length;
    lines.push(`| 子项 | ${doneCount}/${children.length} 已完成 |`);
  }
  if (task.actual_min) lines.push(`| 实际耗时 | ${task.actual_min} 分钟 |`);
  if (task.estimate_min) lines.push(`| 预估耗时 | ${task.estimate_min} 分钟 |`);
  lines.push(`| 创建时间 | ${humanTime(task.created_at)} |`);
  lines.push(`| 任务 ID | ${task.id} |`);
  for (const l of links) {
    lines.push(`| 关联${l.kind === 'folder' ? '文件夹' : '文件'} | ${l.path} |`);
  }
  lines.push('');
  if (children.length) {
    lines.push('## 子项', '');
    for (const c of children) lines.push(`- [${c.status === 'done' ? 'x' : ' '}] ${c.title}`);
    lines.push('');
  }
  if (task.notes_md) {
    lines.push('## 笔记', '', task.notes_md, '');
  }
  if (task.done_note) {
    lines.push('## 完成说明', '', task.done_note, '');
  }
  lines.push('---', '', `> 由待办工作台自动归档 · ${task.completed_at}`, '');
  return lines.join('\n');
}

/** 写入某任务的归档文件，返回相对路径（失败抛错，由上层降级） */
export function writeTaskArchive(db, task, archiveRoot) {
  const rel = relFor(task);
  const abs = path.join(archiveRoot, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderTaskMarkdown(db, task), 'utf8');
  writeMonthIndex(db, monthOf(task.completed_at), archiveRoot);
  return { rel, abs };
}

export function removeArchive(archiveRoot, rel) {
  if (!rel) return false;
  const abs = path.join(archiveRoot, rel.split('/').join(path.sep));
  try {
    fs.rmSync(abs, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function writeMonthIndex(db, ym, archiveRoot) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return null; // 只认 YYYY-MM，防止拼错路径造出垃圾目录
  const rows = monthTasks(db, ym);
  const byCat = new Map();
  for (const r of rows) {
    const key = r.category_name || '未分类';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(r);
  }
  const lines = [`# ${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月 · 已完成 ${rows.length} 项`, ''];
  for (const [cat, items] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${cat}（${items.length}）`, '');
    for (const it of items) {
      const day = (it.completed_at || '').slice(5, 10);
      lines.push(`- [x] ${it.title} · ${day} · ${PRIORITY_SHORT[it.priority] ?? 'P2'}`);
    }
    lines.push('');
  }
  const dir = path.join(archiveRoot, ym.slice(0, 4), ym);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '_index.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** 全量重绘（迁移/换目录后用） */
export function rebuildAll(db, archiveRoot) {
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM task t LEFT JOIN category c ON c.id = t.category_id
       WHERE t.status='done' AND t.deleted_at IS NULL AND t.parent_id IS NULL`
    )
    .all();
  let ok = 0;
  const failed = [];
  const months = new Set();
  for (const t of rows) {
    try {
      const { rel } = writeTaskArchive(db, t, archiveRoot);
      db.prepare('UPDATE task SET archived_path = ?, archive_error = NULL WHERE id = ?').run(rel, t.id);
      months.add(monthOf(t.completed_at));
      ok += 1;
    } catch (err) {
      failed.push({ id: t.id, error: String(err && err.message) });
      db.prepare('UPDATE task SET archive_error = ? WHERE id = ?').run(String(err && err.message), t.id);
    }
  }
  for (const ym of months) {
    try {
      writeMonthIndex(db, ym, archiveRoot);
    } catch {
      /* ignore */
    }
  }
  return { total: rows.length, ok, failed };
}

// 归档全文搜索：归档是普通 Markdown，直接在文件里找，不建索引
// （半年后回头找「那次消防年检的回执」时，grep 一遍比什么都快）
function walkMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), abs });
      }
    }
  };
  walk(root);
  return out;
}

function snippetOf(text, index, len) {
  const from = Math.max(0, index - 34);
  const to = Math.min(text.length, index + len + 46);
  // 去掉 markdown 记号，别让片段里全是 ### 和 | --- |
  const line = text.slice(from, to).replace(/[#>*|]/g, ' ').replace(/\[[ xX]\]/g, ' ').replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + line + (to < text.length ? '…' : '');
}

export function searchArchive(archiveRoot, query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { q: '', total: 0, items: [], truncated: false };
  const needle = q.toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  const items = [];
  let total = 0;
  for (const file of walkMarkdown(archiveRoot)) {
    let text = '';
    let size = 0;
    try {
      const st = fs.statSync(file.abs);
      size = st.size;
      if (size > 512 * 1024) continue; // 单篇归档不可能这么大，跳过异常文件
      text = fs.readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    const titleLine = (/^#\s+(.+)$/m.exec(text) || [])[1] || path.basename(file.rel, '.md');
    const hitTitle = titleLine.toLowerCase().includes(needle);
    const bodyIndex = text.toLowerCase().indexOf(needle);
    if (!hitTitle && bodyIndex < 0) continue;
    total += 1;
    if (items.length >= limit) continue;
    const base = path.posix.basename(file.rel);
    items.push({
      rel: file.rel,
      title: titleLine.trim(),
      kind: base.toLowerCase() === '_index.md' ? 'index' : 'task',
      date: (base.match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || (file.rel.match(/\d{4}-\d{2}/) || [])[0] || '',
      snippet: hitTitle ? '' : snippetOf(text, bodyIndex, needle.length),
      size,
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  // 月度索引里也写着标题，会跟真正的归档重复；有任务归档命中时就不返回索引
  const tasksOnly = items.filter((it) => it.kind === 'task');
  const shown = tasksOnly.length ? tasksOnly : items;
  const matched = total;
  return { q, total: shown.length, matched, items: shown, truncated: matched > shown.length && shown.length >= limit };
}
