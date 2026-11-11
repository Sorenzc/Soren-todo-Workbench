// 维护：给「设置 → 维护」用的体检与清理
// 只做保守的事：stat 文件、比对库里的 archived_path、读 pidfile、列备份。
// 不自动删任何东西，清理必须由用户点了按钮并确认后才执行。
import fs from 'node:fs';
import path from 'node:path';

import { logPath } from './log.mjs';

const MB = 1024 * 1024;

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function roundMB(bytes) {
  if (bytes == null) return null;
  // 不到 1 MB 时用 KB 表示，否则归档只有几百 K 却显示成 0 MB，看着像坏了
  if (bytes > 0 && bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

// 递归列出 archive 下的 markdown（相对路径统一用 /，和 archived_path 一致）
export function listArchiveFiles(archiveRoot) {
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
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const rel = path.relative(archiveRoot, abs).split(path.sep).join('/');
      out.push({ rel, abs, size: sizeOf(abs) ?? 0 });
    }
  };
  if (archiveRoot) walk(archiveRoot);
  return out;
}

// 库里有记录、但文件没了
export function missingArchiveFiles(db, archiveRoot) {
  const rows = db
    .prepare("SELECT id, title, archived_path FROM task WHERE deleted_at IS NULL AND archived_path IS NOT NULL")
    .all();
  const missing = [];
  for (const r of rows) {
    const abs = path.join(archiveRoot, r.archived_path.split('/').join(path.sep));
    if (!fs.existsSync(abs)) missing.push({ id: r.id, title: r.title, rel: r.archived_path });
  }
  return missing;
}

// 文件在、但库里已经没有任务指向它（月度索引文件不算孤儿）
export function orphanArchiveFiles(db, archiveRoot) {
  const used = new Set(
    db
      .prepare("SELECT archived_path FROM task WHERE deleted_at IS NULL AND archived_path IS NOT NULL")
      .all()
      .map((r) => String(r.archived_path).toLowerCase())
  );
  return listArchiveFiles(archiveRoot).filter((f) => {
    const lower = f.rel.toLowerCase();
    if (lower.endsWith('/_index.md')) return false;
    return !used.has(lower);
  });
}

export function cleanArchiveOrphans(archiveRoot, rels) {
  let removed = 0;
  const failed = [];
  for (const rel of rels) {
    const abs = path.join(archiveRoot, String(rel).split('/').join(path.sep));
    // 只允许删 archiveRoot 里面、且不是索引的文件，避免任何路径逃逸
    const inside = path.resolve(abs).startsWith(path.resolve(archiveRoot) + path.sep);
    if (!inside || path.basename(abs).toLowerCase() === '_index.md') {
      failed.push(rel);
      continue;
    }
    try {
      fs.unlinkSync(abs);
      removed += 1;
    } catch {
      failed.push(rel);
    }
  }
  return { removed, failed };
}

export function listBackups(backupRoot) {
  let entries;
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.db'))
    .map((e) => {
      const abs = path.join(backupRoot, e.name);
      const st = (() => {
        try {
          return fs.statSync(abs);
        } catch {
          return null;
        }
      })();
      return { name: e.name, abs, size: st ? st.size : 0, at: st ? st.mtime.toISOString() : null };
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function readPid(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** 读 setting 表里的 JSON 值（自动备份时间等），读不到就返回 null */
function setting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export function inspect(db, cfg) {
  const dbSize = sizeOf(cfg.dbPath);
  const walSize = sizeOf(cfg.dbPath + '-wal');
  const orphans = orphanArchiveFiles(db, cfg.archiveRoot);
  const missing = missingArchiveFiles(db, cfg.archiveRoot);
  const files = listArchiveFiles(cfg.archiveRoot);

  const count = (sql, ...args) => {
    const row = db.prepare(sql).get(...args);
    return row ? Number(Object.values(row)[0]) : 0;
  };

  const missingLinks = count(
    "SELECT count(*) FROM task_link l JOIN task t ON t.id = l.task_id WHERE l.exists_state = 'missing' AND t.deleted_at IS NULL"
  );

  const pidFile = cfg.pidFile || path.join(path.dirname(cfg.dbPath), 'server.pid');
  const filePid = readPid(pidFile);
  const alive = pidAlive(filePid);

  let integrity = 'ok';
  try {
    const q = db.prepare('PRAGMA quick_check').get();
    integrity = q && Object.values(q)[0] === 'ok' ? 'ok' : String(Object.values(q || {})[0] || 'unknown');
  } catch (err) {
    integrity = err && err.message ? err.message : 'unknown';
  }

  const logFile = (() => {
    try {
      return logPath();
    } catch {
      return null;
    }
  })();

  return {
    today: new Date().toISOString().slice(0, 10),
    db: {
      path: cfg.dbPath,
      size: dbSize,
      size_mb: roundMB(dbSize),
      wal_size: walSize,
      wal_size_mb: roundMB(walSize),
      integrity,
    },
    archive: {
      root: cfg.archiveRoot,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      size_mb: roundMB(files.reduce((n, f) => n + f.size, 0)),
      orphans: orphans.map((f) => ({ rel: f.rel, size: f.size })),
      missing: missing.map((m) => ({ id: m.id, title: m.title, rel: m.rel })),
    },
    tasks: {
      open: count("SELECT count(*) FROM task WHERE deleted_at IS NULL AND status IN ('open','doing','waiting')"),
      done: count("SELECT count(*) FROM task WHERE deleted_at IS NULL AND status = 'done'"),
      dropped: count("SELECT count(*) FROM task WHERE deleted_at IS NULL AND status = 'dropped'"),
      scheduled: count("SELECT count(*) FROM task WHERE deleted_at IS NULL AND status = 'scheduled'"),
      deleted: count('SELECT count(*) FROM task WHERE deleted_at IS NOT NULL'),
      memos: count('SELECT count(*) FROM memo WHERE deleted_at IS NULL'),
    },
    links: { missing: missingLinks },
    backups: listBackups(cfg.backupRoot).map((b) => ({ name: b.name, size: b.size, size_mb: roundMB(b.size), at: b.at })),
    backup: {
      auto_day: setting(db, 'auto_backup_day'),
      auto_at: setting(db, 'auto_backup_at'),
      auto_file: setting(db, 'auto_backup_file'),
    },
    pid: { file: pidFile, pid: filePid, alive },
    log: { path: logFile, size: logFile ? sizeOf(logFile) : null },
    generated_at: new Date().toISOString(),
  };
}
