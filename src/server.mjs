// HTTP 服务：本地单用户工作台的唯一入口
// 安全基线：只监听 127.0.0.1；校验 Host；写操作要求 JSON + 自定义 Token 头；
//          打开文件夹只接受 id（路径只从库里读）；spawn 数组参数、shell:false。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { APP_ROOT, autoBackupIfNeeded, DEFAULTS, backup, getSettings, openDb, setSetting, tx } from './db.mjs';
import { ApiError, bad, camelize, localDate, nowIso } from './util.mjs';
import { buildFocus, decorate } from './focus.mjs';
import { assertOpenable, explorerArgs } from './paths.mjs';
import { captureConsole, initLog, logPath } from './log.mjs';
import * as T from './tasks.mjs';
import * as S from './series.mjs';
import * as A from './archive.mjs';
import * as M from './memos.mjs';
import * as MT from './maintenance.mjs';
import * as U from './update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 版本号只有一个来源：package.json（安装包、/api/health、页面角标都读它）
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const publicDir = path.resolve(here, '..', 'public');

/* ------------------------------ 配置 ------------------------------ */
const cfg = {
  ...DEFAULTS,
  dbPath: process.env.WB_DB || DEFAULTS.dbPath,
  archiveRoot: process.env.WB_ARCHIVE || DEFAULTS.archiveRoot,
  backupRoot: process.env.WB_BACKUP || DEFAULTS.backupRoot,
  port: Number(process.env.WB_PORT || DEFAULTS.port),
};

const dataDir = path.dirname(cfg.dbPath);
fs.mkdirSync(dataDir, { recursive: true });
initLog(dataDir);
captureConsole();
const tokenFile = path.join(dataDir, 'token.txt');
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), 'utf8');
}
let TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, TOKEN, 'utf8');
}

// 打包后的启动器靠这个文件找进程、停服务；顺手在退出时清掉
const pidFile = path.join(dataDir, 'server.pid');
fs.writeFileSync(pidFile, String(process.pid), 'utf8');
const dropPid = () => {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {
    /* 文件已被删掉就算了 */
  }
};
process.on('exit', dropPid);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { dropPid(); process.exit(0); });

const db = openDb(cfg);
const settings = getSettings(db);
if (settings.archiveRoot && typeof settings.archiveRoot === 'string' && !process.env.WB_ARCHIVE) {
  cfg.archiveRoot = settings.archiveRoot;
}
fs.mkdirSync(cfg.archiveRoot, { recursive: true });

/**
 * 例行系列的滚动跑道：启动时补一次，之后每 6 小时最多补一次。
 * 跑道是「未来 horizon 期」，补的时候只往后加，不动已有行（用户的改动都还在）。
 */
function refillSeriesThrottled() {
  try {
    // 排期/唤醒每次启动都做：跨月后「排期中的期」必须准时变成待办
    const promo = tx(db, () => S.promoteSeriesOccurrences(db, localDate()));
    if (promo.promoted || promo.shelved) {
      console.log(`[series] 排期整理：${promo.shelved} 期收回、${promo.promoted} 期转为待办`);
    }
    const last = getSettings(db).seriesRefillAt;
    if (last && Date.now() - Date.parse(last) < 6 * 3600 * 1000) return;
    const out = tx(db, () => {
      const r = S.refillAllSeries(db, localDate());
      setSetting(db, 'seriesRefillAt', nowIso());
      return r;
    });
    if (out.created) console.log(`[series] 补齐了 ${out.created} 期待办（${out.touched} 个系列）`);
  } catch (err) {
    console.error('[series] 滚动补齐失败：', err && err.message);
  }
}
refillSeriesThrottled();

// 每天第一次启动自动留一份备份（保留 7 份）。失败只记日志，不影响启动。
try {
  const auto = autoBackupIfNeeded(db, cfg);
  if (auto) console.log(`[backup] 自动备份：${path.basename(auto)}`);
} catch (err) {
  console.error('[backup] 自动备份失败：', err && err.message);
}

// 旧版本用 PowerShell 控制台回传路径，中文被解码成乱码（含 U+FFFD，已无法还原）。
// 新版本已改为写临时文件，这里把历史脏数据标成「需重新关联」，避免界面上显示一堆问号。
try {
  const fixed = T.repairGarbledLinks(db);
  if (fixed) console.log(`[links] 修正了 ${fixed} 条乱码关联（已标记为需重新选择）`);
} catch (err) {
  console.error('[links] 乱码关联清理失败：', err && err.message);
}

/* ---------------------------- 小工具 ---------------------------- */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, JSON_HEADERS);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new ApiError(413, 'TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function decorateMany(rows) {
  const today = localDate();
  // 列表里的「N 天后 / 本周」口径要和聚焦保持一致，否则同一张待办在两处落在不同分区
  const s = getSettings(db);
  return rows.map((r) =>
    decorate(r, today, { leadDays: Number(s.leadDays ?? 3), weekDays: Number(s.weekDays ?? 7) })
  );
}

function decorateOne(row) {
  const s = getSettings(db);
  return decorate(row, localDate(), { leadDays: Number(s.leadDays ?? 3), weekDays: Number(s.weekDays ?? 7) });
}

/* --------------------------- 静态资源 --------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // 收款码/截图可能是 jpg；少了这条会 403，图破了但页面结构断言还全绿
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: { code: 'BAD_PATH', message: '路径编码错误' } });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\u0000')) {
    return sendJson(res, 400, { error: { code: 'BAD_PATH', message: '非法路径' } });
  }
  const abs = path.resolve(publicDir, '.' + rel);
  if (!abs.startsWith(publicDir + path.sep)) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext];
  if (!type) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '不支持的资源类型' } });
  }
  let buf = fs.readFileSync(abs);
  if (ext === '.html') {
    // 只替换值占位符。注意 index.html 里 window.__WB_TOKEN__ 的属性名也含 "_WB"，
    // 若用 replace('__WB_TOKEN__') 会先撞上属性名，把真正的值留在页面上。
    buf = Buffer.from(buf.toString('utf8').replaceAll('@@WB_TOKEN@@', TOKEN), 'utf8');
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': ext === '.html' ? 'no-store' : 'max-age=60' });
  res.end(buf);
}

/* ----------------------------- 业务 ----------------------------- */

function bootstrap() {
  const cats = T.listCategories(db);
  // 计数只看一级任务：子待办不算进「待办 / 逾期 / 今天」的总数
  const counts = {
    open: db
      .prepare(
        "SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL"
      )
      .get()?.n,
    done: db
      .prepare("SELECT count(*) AS n FROM task WHERE status='done' AND deleted_at IS NULL AND parent_id IS NULL")
      .get()?.n,
    overdue: db
      .prepare(
        "SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL AND due_on IS NOT NULL AND due_on < ?"
      )
      .get(localDate())?.n,
    today: db
      .prepare(
        "SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL AND parent_id IS NULL AND due_on = ?"
      )
      .get(localDate())?.n,
    memos: M.countMemos(db),
  };
  return {
    today: localDate(),
    now: nowIso(),
    version: VERSION,
    categories: cats,
    tags: T.listTags(db),
    counts: {
      open: Number(counts.open ?? 0),
      done: Number(counts.done ?? 0),
      overdue: Number(counts.overdue ?? 0),
      today: Number(counts.today ?? 0),
      memos: Number(counts.memos ?? 0),
    },
    settings: getSettings(db),
    archiveRoot: cfg.archiveRoot,
    backupRoot: cfg.backupRoot,
    dbPathHint: cfg.dbPath,
  };
}

function focusPayload() {
  const s = getSettings(db);
  const rows = T.listTasks(db, { status: 'open', limit: 1000 });
  const focus = buildFocus(rows, localDate(), {
    staleDays: Number(s.staleDays ?? 14),
    leadDays: Number(s.leadDays ?? 3),
    weekDays: Number(s.weekDays ?? 7),
  });
  return { ...focus, generated_at: nowIso() };
}

function completeFlow(id, doneNote = '') {
  return tx(db, () => {
    if (doneNote) T.patchTask(db, id, { doneNote });
    // 每日/每周周期：不把活行标完成，而是留一条 done 历史行、让活行滚到下一期。
    // 归档仍然照旧写到那一天的文件里，月索引、「已完成」视图完全不用改。
    const before = T.getTask(db, id);
    const series = before.series_id ? S.getSeries(db, before.series_id) : null;
    if (series && series.rule !== 'monthly') {
      const rolled = S.rollSeriesOccurrence(db, before);
      let archive = { ok: false, skipped: true, reason: 'rolling' };
      try {
        const { rel } = A.writeTaskArchive(db, rolled.ghost, cfg.archiveRoot);
        T.setArchivedPath(db, rolled.ghost.id, rel, null);
        archive = { ok: true, path: rel };
      } catch (err) {
        T.setArchivedPath(db, rolled.ghost.id, null, String(err && err.message));
        archive = { ok: false, error: String(err && err.message) };
      }
      return {
        task: T.getTask(db, id),
        repeated: { next: rolled.next, doneCount: rolled.doneCount, rule: series.rule },
        archive,
        ghost: { id: rolled.ghost.id, due_on: rolled.ghost.due_on, archived_path: archive.ok ? archive.path : null },
      };
    }
    const task = T.completeTask(db, id);
    if (task.status !== 'done') return { task, archive: { ok: false, skipped: true } };
    // 子待办不单独归档：它的完成状态会随父任务的 md checklist 落盘
    if (task.parent_id) return { task, archive: { ok: false, skipped: true, reason: 'child' } };
    try {
      const { rel } = A.writeTaskArchive(db, task, cfg.archiveRoot);
      T.setArchivedPath(db, id, rel, null);
      return { task: T.getTask(db, id), archive: { ok: true, path: rel } };
    } catch (err) {
      T.setArchivedPath(db, id, null, String(err && err.message));
      return { task: T.getTask(db, id), archive: { ok: false, error: String(err && err.message) } };
    }
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // ---------- 读 ----------
  if (method === 'GET' && pathname === '/api/health') {
    // instance 让启动器能确认「这个端口上跑的是不是同一套数据」，而不是随便一个 200
    return sendJson(res, 200, {
      ok: true,
      app: 'todo-workbench',
      instance: crypto.createHash('sha1').update(cfg.dbPath).digest('hex').slice(0, 12),
      version: VERSION,
      db: cfg.dbPath,
      log: logPath(),
      pid: process.pid,
      port: cfg.port,
      now: nowIso(),
    });
  }
  if (method === 'GET' && pathname === '/api/bootstrap') return sendJson(res, 200, bootstrap());
  if (method === 'GET' && pathname === '/api/focus') return sendJson(res, 200, focusPayload());

  // 到期提醒：抢占式返回，谁先抢到 remind_fired 谁负责弹通知，页面与托盘同时轮询也不会重复
  if (method === 'GET' && pathname === '/api/reminders') {
    const reminders = tx(db, () => T.claimDueReminders(db));
    return sendJson(res, 200, {
      reminders: reminders.map((r) => ({
        id: r.id,
        title: r.title,
        priority: r.priority,
        due_on: r.due_on,
        due_time: r.due_time,
        remind_at: r.remind_at,
        late_min: r.late_min,
        category_name: r.category_name || '未分类',
      })),
      now: nowIso(),
    });
  }

  if (method === 'GET' && pathname === '/api/tasks') {
    const { searchParams } = url;
    const doneOn = searchParams.get('doneOn') || undefined;
    if (doneOn && !T.isRealDate(doneOn)) throw new ApiError(400, 'INVALID_DATE', 'doneOn 需要 YYYY-MM-DD');
    const rows = T.listTasks(db, {
      // 只给 doneOn 不给 status 时，显然是要「那天完成的」，别返回空数组
      status: searchParams.get('status') || (doneOn ? 'done' : 'open'),
      categoryId: searchParams.get('category') || undefined,
      tag: searchParams.get('tag') || undefined,
      q: searchParams.get('q') || undefined,
      due: searchParams.get('due') || undefined,
      doneOn,
      parentId: searchParams.get('parent') || undefined,
      limit: Number(searchParams.get('limit') || 300),
    });
    return sendJson(res, 200, { tasks: decorateMany(rows), today: localDate() });
  }

  if (method === 'GET' && pathname === '/api/calendar') {
    const from = String(url.searchParams.get('from') || '');
    const to = String(url.searchParams.get('to') || '');
    const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDay(from) || !isDay(to)) throw new ApiError(400, 'BAD_RANGE', 'from/to 需要 YYYY-MM-DD');
    if (to < from) throw new ApiError(400, 'BAD_RANGE', 'to 不能早于 from');
    const span = Math.round((Date.parse(to + 'T00:00:00') - Date.parse(from + 'T00:00:00')) / 86400000);
    if (span > 62) throw new ApiError(400, 'BAD_RANGE', '日期区间最长 62 天');
    const counts = T.calendarCounts(db, from, to);
    // 格子里的条目：和 counts 同一口径，只多给「哪几条」，前端按需画 chip
    const items = T.calendarItems(db, from, to);
    // 每日/每周周期：把还没落成行的未来期虚拟补出来（纯读，不写库）
    const virtuals = S.virtualOccurrences(db, from, to);
    for (const v of virtuals) {
      (items[v.due_on] || (items[v.due_on] = [])).push(v);
    }
    for (const day of Object.keys(items)) {
      items[day].sort((a, b) => String(a.due_time || '99:99').localeCompare(String(b.due_time || '99:99')));
    }
    return sendJson(res, 200, { from, to, today: localDate(), ...counts, items });
  }

  if (method === 'POST' && pathname === '/api/tasks') {
    const body = await readBody(req);
    const created = T.createTask(db, body); // createTask 内部对例行系列自己开事务
    return sendJson(res, 201, created);
  }

  // 组内拖拽排序：整组顺序一次写回，避免逐条 PATCH 反复撞乐观锁。
  // 必须排在 /api/tasks/:id 之前，否则会被当成 id='reorder' 的任务。
  if (method === 'POST' && pathname === '/api/tasks/reorder') {
    const body = await readBody(req);
    const n = tx(db, () => T.reorderTasks(db, body.ids));
    return sendJson(res, 200, { ok: true, updated: n });
  }

  // 逾期「全推到明天 / 本周日」：一次改一批，单条失败不中断
  if (method === 'POST' && pathname === '/api/tasks/bulk-reschedule') {
    const body = await readBody(req);
    const out = tx(db, () => T.bulkReschedule(db, body.ids, body.dueOn ?? body.due_on));
    return sendJson(res, 200, out);
  }

  // 批量改分类 / 优先级 / 加标签（多选操作条用）
  if (method === 'POST' && pathname === '/api/tasks/bulk-patch') {
    const body = await readBody(req);
    const out = tx(db, () => T.bulkPatch(db, body.ids, body.patch ?? {}));
    return sendJson(res, 200, out);
  }

  // 批量完成：逐条走 completeFlow，失败的跳过、继续下一条（单条失败不中断）
  if (method === 'POST' && pathname === '/api/tasks/bulk-complete') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
    if (!ids.length) throw bad('没有要完成的待办', 'BAD_IDS');
    if (ids.length > 200) throw bad('一次最多完成 200 条', 'BAD_IDS');
    let done = 0;
    const failed = [];
    for (const id of ids) {
      try {
        const out = completeFlow(id, '');
        if (out.task && out.task.status === 'done') done += 1;
        else failed.push({ id, reason: '没变成已完成' });
      } catch (err) {
        failed.push({ id, reason: String((err && err.message) || err) });
      }
    }
    return sendJson(res, 200, { completed: done, failed, total: ids.length });
  }

  // ---------- 每月例行系列 ----------
  if (method === 'GET' && pathname === '/api/series') {
    return sendJson(res, 200, { series: S.listSeries(db), today: localDate() });
  }
  if (seg[0] === 'api' && seg[1] === 'series' && seg[2]) {
    const id = seg[2];
    const sub = seg[3];
    if (!sub && method === 'GET') {
      const series = S.getSeries(db, id);
      return sendJson(res, 200, {
        series: { ...series, rule_label: S.ruleLabel(series) },
        tasks: S.seriesOccurrences(db, id),
      });
    }
    if (!sub && method === 'PATCH') {
      const body = await readBody(req);
      const series = S.getSeries(db, id);
      S.conflictIfStale(series, body.rev);
      const patch = camelize(body.patch ?? body);
      const fields = [];
      const values = [];
      for (const [key, col] of [
        ['title', 'title'],
        ['priority', 'priority'],
        ['categoryId', 'category_id'],
        ['dayOfMonth', 'day_of_month'],
        ['horizonMonths', 'horizon_months'],
      ]) {
        if (patch[key] === undefined) continue;
        fields.push(`${col} = ?`);
        values.push(patch[key]);
      }
      if (!fields.length) throw new ApiError(400, 'EMPTY_PATCH', '这次更新没有任何字段');
      db.prepare(`UPDATE task_series SET ${fields.join(', ')}, updated_at = ?, rev = rev + 1 WHERE id = ?`).run(
        ...values,
        nowIso(),
        id
      );
      return sendJson(res, 200, { series: S.getSeries(db, id) });
    }
    if (sub === 'cancel' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const out = S.cancelSeries(db, id, body.scope === 'all' ? 'all' : 'future');
      return sendJson(res, 200, out);
    }
    if (sub === 'resume' && method === 'POST') {
      return sendJson(res, 200, S.resumeSeries(db, id));
    }
    // 跳过这一期：只在每天 / 每周的滚动系列上有意义
    if (sub === 'skip' && method === 'POST') {
      return sendJson(res, 200, tx(db, () => S.skipOccurrence(db, id)));
    }
    // 彻底删掉一个例行系列（连带它生成的每一期）。界面只在「删系列」时用。
    if (!sub && method === 'DELETE') {
      const series = S.getSeries(db, id);
      const removed = tx(db, () => {
        const n = Number(db.prepare('SELECT count(*) AS n FROM task WHERE series_id = ?').get(id)?.n ?? 0);
        S.deleteSeriesRow(db, id);
        return n;
      });
      return sendJson(res, 200, { deleted: removed, series });
    }
  }

  if (method === 'GET' && pathname === '/api/categories') return sendJson(res, 200, { categories: T.listCategories(db) });
  if (method === 'GET' && pathname === '/api/tags') return sendJson(res, 200, { tags: T.listTags(db) });
  if (method === 'GET' && pathname === '/api/stats') return sendJson(res, 200, T.stats(db));

  // 速记：和待办完全独立的一套接口
  if (method === 'GET' && pathname === '/api/memos') {
    const q = url.searchParams.get('q') || '';
    const limit = url.searchParams.get('limit') || 200;
    return sendJson(res, 200, { memos: M.listMemos(db, { q, limit }), count: M.countMemos(db) });
  }
  if (method === 'POST' && pathname === '/api/memos') {
    const body = await readBody(req);
    return sendJson(res, 201, { memo: tx(db, () => M.createMemo(db, body)) });
  }

  if (method === 'GET' && pathname === '/api/archive/tree') return sendJson(res, 200, A.archiveTree(db));
  // 归档全文搜索：直接在 archive/ 的 markdown 里找，不建索引
  if (method === 'GET' && pathname === '/api/archive/search') {
    const q = url.searchParams.get('q') || '';
    const limit = url.searchParams.get('limit') || 40;
    return sendJson(res, 200, A.searchArchive(cfg.archiveRoot, q, { limit }));
  }
  // 维护体检：只读，不改任何东西
  if (method === 'GET' && pathname === '/api/maintenance') {
    return sendJson(res, 200, MT.inspect(db, cfg));
  }
  if (method === 'POST' && pathname === '/api/maintenance/clean-orphans') {
    const body = await readBody(req);
    const rels = Array.isArray(body.rels) && body.rels.length ? body.rels : MT.orphanArchiveFiles(db, cfg.archiveRoot).map((f) => f.rel);
    if (!rels.length) return sendJson(res, 200, { ok: true, removed: 0, failed: [] });
    const result = MT.cleanArchiveOrphans(cfg.archiveRoot, rels);
    return sendJson(res, 200, { ok: true, ...result });
  }
  // ---- 检查更新（只走 api.github.com，不走 github.com 网页直链）----
  if (method === 'GET' && pathname === '/api/update') {
    const force = url.searchParams.get('force') === '1';
    const info = await U.checkUpdate(db, { current: VERSION, force });
    return sendJson(res, 200, info);
  }
  if (method === 'POST' && pathname === '/api/update/download') {
    const body = await readBody(req);
    const started = await U.startDownload(db, VERSION, dataDir, body.asset);
    return sendJson(res, 200, { ok: true, download: started });
  }
  if (method === 'GET' && pathname === '/api/update/download') {
    return sendJson(res, 200, { ok: true, download: U.downloadState() });
  }
  if (method === 'POST' && pathname === '/api/update/reveal') {
    const st = U.downloadState();
    if (!st.file || !fs.existsSync(st.file)) throw new ApiError(404, 'NO_UPDATE_FILE', '还没有下载好的更新包');
    spawn('explorer.exe', ['/select,' + st.file], { shell: false, stdio: 'ignore', detached: true }).unref();
    return sendJson(res, 200, { ok: true, file: st.file });
  }
  if (method === 'GET' && pathname === '/api/archive/month') {
    const ym = url.searchParams.get('ym') || localDate().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new ApiError(400, 'BAD_YM', '月份格式应为 YYYY-MM');
    return sendJson(res, 200, { ym, tasks: A.monthTasks(db, ym) });
  }
  if (method === 'GET' && pathname === '/api/briefing.md') {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(briefingMarkdown());
  }
  // 导出：参数与 GET /api/tasks 完全同构，页面筛什么就导什么
  if (method === 'GET' && pathname === '/api/export.md') {
    const { searchParams } = url;
    const md = T.exportMarkdown(db, {
      status: searchParams.get('status') || 'open',
      categoryId: searchParams.get('category') || undefined,
      tag: searchParams.get('tag') || undefined,
      q: searchParams.get('q') || undefined,
      due: searchParams.get('due') || undefined,
    });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="todo-${localDate()}.md"`,
    });
    return res.end(md);
  }
  if (method === 'GET' && pathname === '/api/settings') return sendJson(res, 200, { settings: getSettings(db), archiveRoot: cfg.archiveRoot });

  if (method === 'POST' && pathname === '/api/categories') {
    const body = await readBody(req);
    return sendJson(res, 201, { category: T.createCategory(db, body) });
  }

  // ---------- /api/tasks/:id... ----------
  if (seg[0] === 'api' && seg[1] === 'tasks' && seg[2]) {
    const id = seg[2];
    const sub = seg[3];
    if (!sub) {
      if (method === 'GET') {
        const data = T.getTaskWithRelations(db, id);
        // 子待办跟着父任务一起返回：详情面板一次拿全，不用再发一轮请求
        const children = data.task.parent_id
          ? []
          : T.listTasks(db, { status: 'all', parentId: id, limit: 200 }).map(decorateOne);
        return sendJson(res, 200, { ...data, children });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const rev = body.rev;
        const patch = body.patch ?? body;
        const task = tx(db, () => T.patchTask(db, id, patch, rev));
        return sendJson(res, 200, { task });
      }
      if (method === 'DELETE') {
        T.softDelete(db, id);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (sub === 'complete' && method === 'POST') {
      const body = await readBody(req);
      const doneNote = String(body.done_note ?? body.doneNote ?? '').trim();
      const out = completeFlow(id, doneNote);
      return sendJson(res, 200, out);
    }
    if (sub === 'reopen' && method === 'POST') {
      // 重新打开：先删归档文件再改状态
      const before = db.prepare('SELECT archived_path FROM task WHERE id = ?').get(id);
      const task = tx(db, () => T.reopenTask(db, id).task);
      if (before && before.archived_path) {
        A.removeArchive(cfg.archiveRoot, before.archived_path);
        try {
          const ym = before.archived_path.split('/')[1]; // YYYY/YYYY-MM/date__slug.md
          A.writeMonthIndex(db, ym, cfg.archiveRoot);
        } catch {
          /* 索引重建失败不影响主流程 */
        }
      }
      return sendJson(res, 200, { task });
    }
    if (sub === 'restore' && method === 'POST') return sendJson(res, 200, { task: T.restoreTask(db, id) });
    // 提醒「稍后再说」：往后推 remind_at 并重新武装 remind_fired
    if (sub === 'snooze' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, tx(db, () => T.snoozeTask(db, id, body.minutes ?? body.min)));
    }
    if (sub === 'purge' && method === 'POST') {
      const row = tx(db, () => T.purgeTask(db, id));
      if (row.archived_path) {
        A.removeArchive(cfg.archiveRoot, row.archived_path);
        try {
          A.writeMonthIndex(db, row.archived_path.split('/')[1], cfg.archiveRoot);
        } catch {
          /* ignore */
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'links') {
      if (method === 'GET') return sendJson(res, 200, { links: T.listLinks(db, id) });
      if (method === 'POST') {
        const body = await readBody(req);
        const link = tx(db, () =>
          T.addLink(db, id, { path: body.path, kind: body.kind || 'folder', isPrimary: body.isPrimary !== false })
        );
        return sendJson(res, 201, { link });
      }
    }
    if (sub === 'open' && method === 'POST') {
      const body = await readBody(req);
      const link = body.linkId
        ? db.prepare('SELECT * FROM task_link WHERE id = ? AND task_id = ?').get(body.linkId, id)
        : T.primaryLink(db, id);
      if (!link) throw new ApiError(404, 'NO_LINK', '该待办尚未关联文件夹');
      return sendJson(res, 200, openLink(link));
    }
  }

  // ---------- /api/memos/:id ----------
  if (seg[0] === 'api' && seg[1] === 'memos' && seg[2]) {
    const id = seg[2];
    const sub = seg[3];
    if (!sub) {
      if (method === 'GET') return sendJson(res, 200, { memo: M.getMemo(db, id) });
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        return sendJson(res, 200, { memo: tx(db, () => M.patchMemo(db, id, body.patch ?? body, body.rev)) });
      }
      if (method === 'DELETE') return sendJson(res, 200, tx(db, () => M.softDeleteMemo(db, id)));
    }
    if (sub === 'restore' && method === 'POST') return sendJson(res, 200, { memo: tx(db, () => M.restoreMemo(db, id)) });
    if (sub === 'purge' && method === 'POST') return sendJson(res, 200, tx(db, () => M.purgeMemo(db, id)));
  }

  // ---------- /api/links/:id ----------
  if (seg[0] === 'api' && seg[1] === 'links' && seg[2]) {
    const linkId = seg[2];
    if (seg[3] === 'verify' && method === 'POST') return sendJson(res, 200, { link: T.verifyLink(db, linkId) });
    if (seg[3] === 'open' && method === 'POST') {
      const link = db.prepare('SELECT * FROM task_link WHERE id = ?').get(linkId);
      if (!link) throw new ApiError(404, 'NO_LINK', '关联不存在');
      return sendJson(res, 200, openLink(link));
    }
    if (method === 'DELETE') {
      T.removeLink(db, linkId);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---------- /api/categories/:id ----------
  if (seg[0] === 'api' && seg[1] === 'categories' && seg[2] && !seg[3]) {
    if (method === 'PATCH') {
      const body = await readBody(req);
      return sendJson(res, 200, { category: T.updateCategory(db, seg[2], body) });
    }
    if (method === 'DELETE') return sendJson(res, 200, T.deleteCategory(db, seg[2]));
  }

  // ---------- 其它动作 ----------
  if (method === 'POST' && pathname === '/api/archive/rerender') {
    return sendJson(res, 200, A.rebuildAll(db, cfg.archiveRoot));
  }
  if (method === 'POST' && pathname === '/api/backup') {
    const file = backup(db, cfg);
    return sendJson(res, 200, { ok: true, file });
  }
  if (method === 'POST' && pathname === '/api/open-directory') {
    const body = await readBody(req);
    const target = body.target === 'backup' ? cfg.backupRoot : body.target === 'data' ? dataDir : cfg.archiveRoot;
    spawn('explorer.exe', [target], { shell: false, stdio: 'ignore', detached: true }).unref();
    return sendJson(res, 200, { ok: true, opened: target });
  }
  // 在资源管理器里定位某一篇归档（搜索结果的跳转）
  if (method === 'POST' && pathname === '/api/archive/open') {
    const body = await readBody(req);
    const rel = String(body.rel || '');
    const abs = path.resolve(cfg.archiveRoot, rel.split('/').join(path.sep));
    const root = path.resolve(cfg.archiveRoot);
    if (!rel || !abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
      throw new ApiError(400, 'BAD_ARCHIVE_PATH', '这篇归档不在归档目录里');
    }
    spawn('explorer.exe', ['/select,' + abs], { shell: false, stdio: 'ignore', detached: true }).unref();
    return sendJson(res, 200, { ok: true, opened: abs });
  }
  if (method === 'POST' && pathname === '/api/pick-folder') {
    return sendJson(res, 200, pickPath('folder'));
  }
  if (method === 'POST' && pathname === '/api/pick-file') {
    return sendJson(res, 200, pickPath('file'));
  }
  if (method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    for (const [k, v] of Object.entries(body.settings || body || {})) setSetting(db, k, v);
    return sendJson(res, 200, { settings: getSettings(db) });
  }

  throw new ApiError(404, 'NO_ROUTE', `未知接口 ${method} ${pathname}`);
}

function openLink(link) {
  let real;
  try {
    real = assertOpenable(link.path, link.kind);
  } catch (err) {
    T.markLinkMissing(db, link.id);
    throw err;
  }
  const child = spawn('explorer.exe', explorerArgs(real, link.kind), {
    shell: false,
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
  });
  child.unref();
  T.markLinkOpened(db, link.id);
  return { ok: true, opened: real, kind: link.kind };
}

// 选择文件夹/文件。中文路径不能走控制台：Windows PowerShell 的 stdout 用系统 ANSI 代码页，
// Node 按 UTF-8 解码会得到「文件夹」这种乱码（甚至一串 U+FFFD，事后无法还原）。
// 所以让 PowerShell 直接把路径以 UTF-8 写进临时文件，再由 Node 读回来。
function pickPath(kind) {
  const tmp = path.join(os.tmpdir(), `wb-pick-${process.pid}-${Date.now()}.txt`);
  const write = '[IO.File]::WriteAllText($env:WB_PICK_TMP, ';
  const enc = ', (New-Object System.Text.UTF8Encoding($false)))';
  const script =
    kind === 'file'
      ? [
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          "$d.Title = '选择要关联到此待办的文件'",
          "$d.Filter = '所有文件 (*.*)|*.*'",
          '$d.CheckFileExists = $true',
          `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${write}$d.FileName${enc} }`,
        ].join('; ')
      : [
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$d.Description = '选择要关联到此待办的文件夹'",
          '$d.ShowNewFolderButton = $true',
          `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${write}$d.SelectedPath${enc} }`,
        ].join('; ');
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      timeout: 300000,
      windowsHide: true,
      env: { ...process.env, WB_PICK_TMP: tmp },
    });
    const out = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8').trim() : '';
    return { path: out, ok: Boolean(out), kind };
  } catch (err) {
    return { path: '', ok: false, kind, error: String(err && err.message) };
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

function briefingMarkdown() {
  const f = focusPayload();
  const lines = [`# 今日开场简报 · ${f.today}`, ''];
  lines.push(`- 待办总数：${f.open_count}`, `- 逾期：${f.overdue_count}`, `- 今天到期：${f.today_count}`, '');
  const sec = (title, items) => {
    lines.push(`## ${title}（${items.length}）`, '');
    if (!items.length) lines.push('_无_', '');
    for (const t of items) lines.push(`- [ ] ${t.title} — ${t.why}`);
    lines.push('');
  };
  sec('必做', f.must);
  sec('本周', f.week);
  const done = T.listTasks(db, { status: 'done', limit: 20 }).filter(
    (t) => (t.completed_at || '').slice(0, 10) === f.today
  );
  sec('今日已完成', done.map((t) => ({ title: t.title, why: t.priority === 0 ? 'P0' : '' })));
  return lines.join('\n');
}

/* ---------------------------- 服务主体 ---------------------------- */
const allowedHosts = new Set();

function guard(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new ApiError(403, 'FORBIDDEN_HOST', 'Host 不被允许');
  }
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) {
      throw new ApiError(415, 'JSON_ONLY', '请求体必须是 application/json');
    }
  }
  const token = req.headers['x-wb-token'];
  if (token !== TOKEN) {
    throw new ApiError(401, 'BAD_TOKEN', '令牌无效，请刷新页面');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (!url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url.pathname);
    }
    // 健康检查不校验令牌（启动器用它判断端口上是不是同一个工作台），
    // 但必须和 handleApi 里的 /api/health 返回同一份字段，否则启动器认不出来。
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'todo-workbench',
        instance: crypto.createHash('sha1').update(cfg.dbPath).digest('hex').slice(0, 12),
        version: VERSION,
        db: cfg.dbPath,
        log: logPath(),
        pid: process.pid,
        port: cfg.port,
        now: nowIso(),
      });
    }
    guard(req);
    await handleApi(req, res, url);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    if (status >= 500) console.error('[api]', req.method, url.pathname, err);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: {
          code: err.code || 'INTERNAL',
          message: err.message || '服务器内部错误',
          details: err.details,
        },
      });
    }
  }
});

function listen(port, tries = 10) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err && err.code === 'EADDRINUSE' && tries > 1) {
      console.log(`端口 ${port} 被占用，改用 ${port + 1} …`);
      listen(port + 1, tries - 1);
      return;
    }
    console.error('启动失败：', err && err.message);
    process.exit(1);
  };
  const onListening = () => {
    server.removeListener('error', onError);
    const actual = server.address().port;
    cfg.port = actual;
    allowedHosts.add(`127.0.0.1:${actual}`);
    allowedHosts.add(`localhost:${actual}`);
    allowedHosts.add(`[::1]:${actual}`);
    const url = `http://127.0.0.1:${actual}/`;
    console.log('待办工作台已启动 →', url);
    console.log('数据库：', cfg.dbPath);
    console.log('归档目录：', cfg.archiveRoot);
    console.log('日志：', logPath() || '(未落盘)');
    if (process.env.WB_NO_OPEN !== '1') {
      try {
        spawn('rundll32', ['url.dll,FileProtocolHandler', url], { shell: false, stdio: 'ignore', detached: true }).unref();
      } catch {
        /* 打不开浏览器时用户手动访问即可 */
      }
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

listen(cfg.port);

process.on('SIGINT', () => {
  try {
    server.close();
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
