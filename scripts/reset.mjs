// 清空数据：删掉所有待办、事件、关联、标签和归档文件，保留分类与设置。
// 用途：演示数据看够了，想从干净状态开始记自己的事；或出问题想重来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'workbench.db');
const archiveRoot = path.join(root, 'archive');

if (!fs.existsSync(dbPath)) {
  console.log('数据库还不存在，没什么可清的。');
  process.exit(0);
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

const before = db.prepare('SELECT count(*) AS n FROM task').get().n;
const seriesBefore = db.prepare('SELECT count(*) AS n FROM task_series').get().n;
// 速记是独立的库（v1.7 起），有的老库还没这张表
const hasMemo = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'memo'").get());
const memoBefore = hasMemo ? db.prepare('SELECT count(*) AS n FROM memo').get().n : 0;

const backupDir = path.join(root, 'data', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupFile = path.join(backupDir, `before-reset-${stamp}.db`);
db.prepare('VACUUM INTO ?').run(backupFile);

db.exec('BEGIN IMMEDIATE');
db.exec('DELETE FROM task_link');
db.exec('DELETE FROM task_tag');
db.exec('DELETE FROM task_event');
db.exec('DELETE FROM task');
db.exec('DELETE FROM task_series');
db.exec('DELETE FROM tag');
if (hasMemo) db.exec('DELETE FROM memo');
db.exec('COMMIT');

// 归档文件：只删 archive 目录下的 .md 和空目录
let removed = 0;
function sweep(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      sweep(p);
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* 目录非空 */ }
    } else if (name.endsWith('.md')) {
      fs.unlinkSync(p);
      removed++;
    }
  }
}
sweep(archiveRoot);

db.close();
console.log(`已清空 ${before} 条任务（含 ${seriesBefore} 个例行系列）${hasMemo ? `、${memoBefore} 条速记` : ''}、删除 ${removed} 个归档文件。`);
console.log(`清空前已备份数据库：${backupFile}`);
console.log('分类和设置保留。重新启动工作台即可从空白开始。');
