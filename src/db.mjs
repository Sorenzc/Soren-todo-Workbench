// 数据库层：打开、PRAGMA、结构初始化、种子数据、事务、备份
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { nowIso, uid } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');

export const DEFAULTS = {
  dbPath: path.join(APP_ROOT, 'data', 'workbench.db'),
  archiveRoot: path.join(APP_ROOT, 'archive'),
  backupRoot: path.join(APP_ROOT, 'data', 'backups'),
  port: 7861,
};

const SEED_CATEGORIES = [
  ['cat-inbox', '收件箱', '#6B7280', 0],
  ['cat-property', '物业运营', '#2563EB', 10],
  ['cat-contract', '合同与法务', '#7C3AED', 20],
  ['cat-policy', '制度与流程', '#0E9F6E', 30],
  ['cat-meeting', '会议与汇报', '#D97706', 40],
  ['cat-admin', '行政事务', '#0891B2', 50],
  ['cat-personal', '个人事项', '#DB2777', 60],
];

export function ensureDirs(cfg) {
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  fs.mkdirSync(cfg.archiveRoot, { recursive: true });
  fs.mkdirSync(cfg.backupRoot, { recursive: true });
}

export function openDb(cfg) {
  ensureDirs(cfg);
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  const version = db.prepare('PRAGMA user_version').get();
  let current = Number(version && (version.user_version ?? Object.values(version)[0]) || 0);
  if (current < 1) {
    db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      1,
      nowIso(),
      'init'
    );
    current = 1;
  }
  // v2：每月例行（task_series + task.series_id/occur_month）
  // 注意：schema.sql 在 ALTER 之前执行，所以任何引用这两列的索引都不能写进 schema.sql，
  // 只能在这里建，否则老库启动时 CREATE INDEX 会直接报 no such column。
  if (current < 2) {
    ensureColumn(db, 'task', 'series_id', 'TEXT REFERENCES task_series(id) ON DELETE SET NULL');
    ensureColumn(db, 'task', 'occur_month', 'TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_task_series_occur ON task(series_id, occur_month)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_task_series_due ON task(series_id, due_on)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_series_status ON task_series(status, watermark_month)');
    db.exec('PRAGMA user_version = 2');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      2,
      nowIso(),
      'monthly series'
    );
  }
  // v3：例行「排期期」用 status='scheduled'，task 的 CHECK 要放行这个状态。
  // SQLite 改不了 CHECK，只能按官方 12 步重建表；只有老库需要重建。
  if (current < 3) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'").get();
    if (ddl && !/scheduled/.test(ddl.sql || '')) rebuildTaskForScheduledStatus(db, cfg);
    db.exec('PRAGMA user_version = 3');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      3,
      nowIso(),
      'allow scheduled occurrences'
    );
  }
  // v4：子待办 + 提醒（parent_id / remind_at / remind_fired）。
  // 同上：引用新列的索引只能建在迁移里，schema.sql 先执行会报 no such column。
  if (current < 4) {
    ensureColumn(db, 'task', 'parent_id', 'TEXT');
    ensureColumn(db, 'task', 'remind_at', 'TEXT');
    ensureColumn(db, 'task', 'remind_fired', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS ix_task_parent ON task(parent_id) WHERE parent_id IS NOT NULL');
    db.exec(
      'CREATE INDEX IF NOT EXISTS ix_task_remind ON task(remind_at) WHERE remind_at IS NOT NULL AND remind_fired = 0'
    );
    db.exec('PRAGMA user_version = 4');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      4,
      nowIso(),
      'subtasks and reminders'
    );
  }
  // v5：置顶 + 手动排序（pinned；sort_order 列早就有，v1 起默认 0）。
  if (current < 5) {
    ensureColumn(db, 'task', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('PRAGMA user_version = 5');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      5,
      nowIso(),
      'pinned tasks'
    );
  }
  // v6：每日/每周周期。滚动系列只维护一条活行，同一个月会有活行 + 多条历史行，
  // 所以 task 上的 ux_task_series_occur 唯一索引要降级成普通索引；
  // 同时 task_series 的 rule CHECK 要放开到 daily/weekly —— SQLite 改不了 CHECK，按 12 步重建。
  if (current < 6) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_series'").get();
    if (ddl && !/daily/.test(ddl.sql || '')) rebuildTaskSeriesForRolling(db, cfg);
    db.exec('DROP INDEX IF EXISTS ux_task_series_occur');
    db.exec('CREATE INDEX IF NOT EXISTS ix_task_series_occur ON task(series_id, occur_month)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_task_series_due ON task(series_id, due_on)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_series_status ON task_series(status, watermark_month)');
    db.exec('PRAGMA user_version = 6');
    db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at, note) VALUES (?,?,?)').run(
      6,
      nowIso(),
      'daily and weekly series'
    );
  }
  seed(db);
  return db;
}

const TASK_COLUMNS = [
  'id', 'title', 'notes_md', 'category_id', 'status', 'priority', 'due_on', 'due_time', 'estimate_min',
  'actual_min', 'series_id', 'occur_month', 'created_at', 'updated_at', 'started_at', 'completed_at',
  'dropped_at', 'last_touched_at', 'rev', 'archived_path', 'archive_error', 'done_note', 'sort_order', 'deleted_at',
];

/** 重建 task 表以放宽 status CHECK（保留全部列与索引，重建前先留一份拷贝） */
function rebuildTaskForScheduledStatus(db, cfg) {
  const cols = TASK_COLUMNS.join(', ');
  const safe = cfg.dbPath + '.pre-v3.bak';
  if (!fs.existsSync(safe)) fs.copyFileSync(cfg.dbPath, safe);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE task_new (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        notes_md        TEXT NOT NULL DEFAULT '',
        category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        priority        INTEGER NOT NULL DEFAULT 2,
        due_on          TEXT,
        due_time        TEXT,
        estimate_min    INTEGER,
        actual_min      INTEGER,
        series_id       TEXT REFERENCES task_series(id) ON DELETE SET NULL,
        occur_month     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        started_at      TEXT,
        completed_at    TEXT,
        dropped_at      TEXT,
        last_touched_at TEXT NOT NULL,
        rev             INTEGER NOT NULL DEFAULT 1,
        archived_path   TEXT,
        archive_error   TEXT,
        done_note       TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        deleted_at      TEXT,
        CHECK (length(title) BETWEEN 1 AND 200),
        CHECK (status IN ('open','doing','done','dropped','scheduled')),
        CHECK (priority BETWEEN 0 AND 3),
        CHECK ((status = 'done') = (completed_at IS NOT NULL)),
        CHECK (due_on IS NULL OR date(due_on) = due_on),
        CHECK (due_time IS NULL OR (due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND due_time < '24:00')),
        CHECK (estimate_min IS NULL OR estimate_min > 0),
        CHECK ((series_id IS NULL) = (occur_month IS NULL))
      ) STRICT`);
    db.exec(`INSERT INTO task_new (${cols}) SELECT ${cols} FROM task`);
    // v_task_open 引用了 task，DROP TABLE 前要先收起来，否则 RENAME 会校验失败
    const viewSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_task_open'").get();
    if (viewSql) db.exec('DROP VIEW v_task_open');
    db.exec('DROP TABLE task');
    db.exec('ALTER TABLE task_new RENAME TO task');
    for (const sql of [
      "CREATE INDEX IF NOT EXISTS ix_task_open_due ON task(due_on) WHERE deleted_at IS NULL AND status IN ('open','doing')",
      "CREATE INDEX IF NOT EXISTS ix_task_done_at ON task(completed_at DESC) WHERE status = 'done'",
      'CREATE INDEX IF NOT EXISTS ix_task_cat ON task(category_id)',
      'CREATE INDEX IF NOT EXISTS ix_task_updated ON task(updated_at DESC)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_task_series_occur ON task(series_id, occur_month)',
      "CREATE INDEX IF NOT EXISTS ix_task_series_due ON task(series_id, due_on)",
    ]) {
      db.exec(sql);
    }
    if (viewSql) db.exec(viewSql.sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const SERIES_COLUMNS = [
  'id', 'title', 'notes_md', 'category_id', 'priority', 'due_time', 'estimate_min', 'rule',
  'day_of_month', 'start_month', 'horizon_months', 'watermark_month', 'status', 'created_at', 'updated_at', 'rev',
];

/** 重建 task_series 以放开 rule CHECK（v6：daily/weekly 周期）。重建前先留一份拷贝。 */
function rebuildTaskSeriesForRolling(db, cfg) {
  const cols = SERIES_COLUMNS.join(', ');
  const safe = cfg.dbPath + '.pre-v6.bak';
  if (!fs.existsSync(safe)) fs.copyFileSync(cfg.dbPath, safe);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE task_series_new (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        notes_md        TEXT NOT NULL DEFAULT '',
        category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
        priority        INTEGER NOT NULL DEFAULT 2,
        due_time        TEXT,
        estimate_min    INTEGER,
        rule            TEXT NOT NULL DEFAULT 'monthly',
        interval_n      INTEGER NOT NULL DEFAULT 1,
        weekday         INTEGER,
        day_of_month    INTEGER NOT NULL,
        start_month     TEXT NOT NULL,
        horizon_months  INTEGER NOT NULL DEFAULT 36,
        watermark_month TEXT NOT NULL,
        next_on         TEXT,
        repeat_done_count INTEGER NOT NULL DEFAULT 0,
        last_done_at    TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        rev             INTEGER NOT NULL DEFAULT 1,
        CHECK (rule IN ('monthly','daily','weekly')),
        CHECK (interval_n BETWEEN 1 AND 60),
        CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
        CHECK (day_of_month BETWEEN 1 AND 31),
        CHECK (horizon_months BETWEEN 1 AND 120),
        CHECK (status IN ('active','cancelled')),
        CHECK (length(title) BETWEEN 1 AND 200),
        CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
        CHECK (watermark_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
      ) STRICT`);
    db.exec(`INSERT INTO task_series_new (${cols}) SELECT ${cols} FROM task_series`);
    db.exec('DROP TABLE task_series');
    db.exec('ALTER TABLE task_series_new RENAME TO task_series');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function hasColumn(db, table, name) {  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === name);
}

function ensureColumn(db, table, name, decl) {
  if (hasColumn(db, table, name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  return true;
}

function seed(db) {
  const now = nowIso();
  const exists = db.prepare('SELECT count(*) AS n FROM category').get();
  if (!exists || Number(exists.n) === 0) {
    const ins = db.prepare(
      'INSERT INTO category (id, parent_id, name, color, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    );
    for (const [id, name, color, order] of SEED_CATEGORIES) {
      ins.run(id, null, name, color, order, now, now);
    }
  }
  const defaults = [
    ['leadDays', 3],
    ['weekDays', 7],
    ['staleDays', 14],
    ['wPriority', 0.55],
    ['wUrgency', 0.45],
    ['theme', 'light'],
  ];
  const insSet = db.prepare('INSERT OR IGNORE INTO setting (key, value, updated_at) VALUES (?,?,?)');
  for (const [k, v] of defaults) insSet.run(k, JSON.stringify(v), now);
}

/** 事务包装（node:sqlite 没有内建 transaction 方法） */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO setting (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), nowIso());
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM setting').all();
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function backup(db, cfg, tag = 'manual') {
  ensureDirs(cfg);
  // YYYYMMDDHHMMSS，精确到秒；同一秒重复备份自动加序号，避免 VACUUM INTO 撞已有文件
  const stamp = nowIso().replace(/[-:T+]/g, '').slice(0, 14);
  let file = path.join(cfg.backupRoot, `todo-${stamp}-${tag}.db`);
  for (let i = 2; fs.existsSync(file); i++) {
    file = path.join(cfg.backupRoot, `todo-${stamp}-${tag}-${i}.db`);
  }
  const escaped = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  pruneBackups(cfg, 14);
  return file;
}

function pruneBackups(cfg, keep) {
  try {
    const files = fs
      .readdirSync(cfg.backupRoot)
      .filter((f) => f.startsWith('todo-') && f.endsWith('.db'))
      .map((f) => ({ f, t: fs.statSync(path.join(cfg.backupRoot, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const extra of files.slice(keep)) {
      fs.rmSync(path.join(cfg.backupRoot, extra.f), { force: true });
    }
  } catch {
    /* 备份清理失败不影响主流程 */
  }
}

export function logEvent(db, taskId, type, payload) {
  try {
    db.prepare('INSERT INTO task_event (task_id, type, at, payload) VALUES (?,?,?,?)').run(
      taskId,
      type,
      nowIso(),
      payload ? JSON.stringify(payload) : null
    );
  } catch {
    /* 事件流是辅助信息，不阻塞主流程 */
  }
}

export const newId = uid;
