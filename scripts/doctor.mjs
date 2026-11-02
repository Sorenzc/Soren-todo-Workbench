// 自检：Node 版本、SQLite 可用性、目录可写、数据库完整性。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (name, extra = '') => console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
const fail = (name, err) => { bad++; console.log(`  ✗ ${name}  ${err?.message || err}`); };

console.log('待办工作台 · 自检\n');

// 1. Node 版本
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) ok('Node.js 版本', process.version);
  else fail('Node.js 版本', new Error(`${process.version} 太低，需要 >= 22.5`));
}

// 2. node:sqlite
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a INTEGER) STRICT');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  const row = db.prepare('SELECT a FROM t').get();
  if (row?.a === 1) ok('node:sqlite 可用');
  else fail('node:sqlite 读写', new Error('返回值不正确'));
  db.close();
} catch (err) {
  fail('node:sqlite 可用（Node 24 自带的 SQLite）', err);
}

// 3. 目录可写
for (const rel of ['data', 'archive', 'data/backups']) {
  const abs = path.join(root, rel);
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, `.doctor-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok(`目录可写 ${rel}`);
  } catch (err) {
    fail(`目录可写 ${rel}`, err);
  }
}

// 4. 数据库完整性
try {
  const dbPath = path.join(root, 'data', 'workbench.db');
  if (!fs.existsSync(dbPath)) {
    ok('数据库尚未创建（首次启动会自动建）');
  } else if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    const q = db.prepare('PRAGMA quick_check').get();
    const n = db.prepare("SELECT count(*) AS n FROM task WHERE status IN ('open','doing') AND deleted_at IS NULL").get();
    const sch = db.prepare("SELECT count(*) AS n FROM task WHERE status = 'scheduled' AND deleted_at IS NULL").get();
    const done = db.prepare("SELECT count(*) AS n FROM task WHERE status = 'done' AND deleted_at IS NULL").get();
    if (q && Object.values(q)[0] === 'ok') {
      ok('数据库完整性', `待办 ${n.n} 条，已完成 ${done.n} 条${sch.n ? `，另有 ${sch.n} 期在例行排期里` : ''}`);
    } else fail('数据库完整性', new Error(JSON.stringify(q)));
    db.close();
  }
} catch (err) {
  fail('数据库检查', err);
}

// 5. 端口占用情况（默认 7861，被占用会自动换）
//    如果占着端口的就是工作台本身（/api/health 应答正常），那说明已经开着了，不算问题。
try {
  const net = await import('node:net');
  const occupied = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(7861, '127.0.0.1');
  });
  if (!occupied) {
    ok('7861 端口可用');
  } else {
    let ours = false;
    try {
      const r = await fetch('http://127.0.0.1:7861/api/health', { signal: AbortSignal.timeout(2000) });
      const j = await r.json().catch(() => null);
      ours = r.ok && j?.ok === true;
    } catch {
      /* 不是工作台，或没起 */
    }
    if (ours) console.log('  · 7861 已有工作台在运行（直接用浏览器打开即可）');
    else {
      bad++;
      console.log('  ! 7861 端口被其它程序占用，启动时会自动换端口');
    }
  }
} catch {
  /* 忽略：端口检测失败不影响使用 */
}

console.log(`\n自检${bad ? `发现 ${bad} 个问题` : '全部通过'}。`);
process.exit(bad ? 1 : 0);
