-- =====================================================================
-- 待办工作台 · 数据库结构 v1
-- 约定：STRICT 表、TEXT ISO-8601（带本地偏移）、布尔用 INTEGER 0/1、
--       主键 TEXT(UUID)、软删 deleted_at、乐观锁 rev。
-- =====================================================================

CREATE TABLE IF NOT EXISTS schema_migration (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  note       TEXT
) STRICT;

-- ---------------- 分类 ----------------
CREATE TABLE IF NOT EXISTS category (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES category(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 40),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

-- ---------------- 例行系列（每月某日） ----------------
-- 规则模板；每一期是 task 表里的一条普通任务（series_id + occur_month 指回来）。
CREATE TABLE IF NOT EXISTS task_series (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  notes_md        TEXT NOT NULL DEFAULT '',
  category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
  priority        INTEGER NOT NULL DEFAULT 2,
  due_time        TEXT,
  estimate_min    INTEGER,
  rule            TEXT NOT NULL DEFAULT 'monthly',
  day_of_month    INTEGER NOT NULL,              -- 用户意图 1..31，不因 2 月被改成 28
  start_month     TEXT NOT NULL,                 -- 'YYYY-MM'
  horizon_months  INTEGER NOT NULL DEFAULT 36,   -- 永远保持未来多少期
  watermark_month TEXT NOT NULL,                 -- 已生成到的最后一期
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  rev             INTEGER NOT NULL DEFAULT 1,
  CHECK (rule IN ('monthly')),
  CHECK (day_of_month BETWEEN 1 AND 31),
  CHECK (horizon_months BETWEEN 1 AND 120),
  CHECK (status IN ('active','cancelled')),
  CHECK (length(title) BETWEEN 1 AND 200),
  CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CHECK (watermark_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
) STRICT;

-- ---------------- 任务 ----------------
CREATE TABLE IF NOT EXISTS task (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  notes_md        TEXT NOT NULL DEFAULT '',
  category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  priority        INTEGER NOT NULL DEFAULT 2,   -- 0=P0 最高 … 3=P3 最低
  due_on          TEXT,                          -- 民用日期 YYYY-MM-DD
  due_time        TEXT,                          -- 'HH:MM'
  estimate_min    INTEGER,
  actual_min      INTEGER,
  series_id       TEXT REFERENCES task_series(id) ON DELETE SET NULL,
  occur_month     TEXT,                          -- 'YYYY-MM'，这一期属于哪个月（改期不动）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  dropped_at      TEXT,
  last_touched_at TEXT NOT NULL,
  rev             INTEGER NOT NULL DEFAULT 1,
  archived_path   TEXT,                          -- 相对 archiveRoot
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
  -- 一期必须有月份，非系列任务必须没有
  CHECK ((series_id IS NULL) = (occur_month IS NULL))
) STRICT;

-- ---------------- 标签 ----------------
CREATE TABLE IF NOT EXISTS tag (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS task_tag (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
) STRICT;

-- ---------------- 本地文件夹/文件关联 ----------------
CREATE TABLE IF NOT EXISTS task_link (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,                   -- folder | file
  path             TEXT NOT NULL,
  label            TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  exists_state     TEXT NOT NULL DEFAULT 'unknown', -- unknown|ok|missing|denied
  last_verified_at TEXT,
  missing_since    TEXT,
  open_count       INTEGER NOT NULL DEFAULT 0,
  last_opened_at   TEXT,
  created_at       TEXT NOT NULL,
  CHECK (kind IN ('folder','file')),
  CHECK (exists_state IN ('unknown','ok','missing','denied')),
  CHECK (is_primary IN (0,1)),
  CHECK (length(path) BETWEEN 1 AND 240),
  UNIQUE (task_id, path)
) STRICT;

-- ---------------- 事件流 ----------------
CREATE TABLE IF NOT EXISTS task_event (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  type    TEXT NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT
) STRICT;

-- ---------------- 键值配置 ----------------
CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- ---------------- 索引 ----------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_category_sibling
  ON category(ifnull(parent_id, ''), name);

CREATE INDEX IF NOT EXISTS ix_task_open_due ON task(due_on)
  WHERE deleted_at IS NULL AND status IN ('open','doing');

CREATE INDEX IF NOT EXISTS ix_task_done_at ON task(completed_at DESC)
  WHERE status = 'done';

CREATE INDEX IF NOT EXISTS ix_task_cat     ON task(category_id);
CREATE INDEX IF NOT EXISTS ix_task_updated ON task(updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_link_task    ON task_link(task_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_link_primary
  ON task_link(task_id) WHERE is_primary = 1;

CREATE INDEX IF NOT EXISTS ix_event_task   ON task_event(task_id, at);

-- ---------------- 视图 ----------------
CREATE VIEW IF NOT EXISTS v_task_open AS
SELECT
  t.id, t.title, t.notes_md, t.category_id, c.name AS category_name, c.color AS category_color,
  t.status, t.priority, t.due_on, t.due_time,
  t.created_at, t.last_touched_at, t.updated_at, t.rev,
  (SELECT count(*) FROM task_link l WHERE l.task_id = t.id) AS link_count,
  (SELECT l.id FROM task_link l WHERE l.task_id = t.id AND l.is_primary = 1) AS primary_link_id
FROM task t
LEFT JOIN category c ON c.id = t.category_id
WHERE t.deleted_at IS NULL AND t.status IN ('open','doing');
