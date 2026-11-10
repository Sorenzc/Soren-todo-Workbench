// 停掉后台服务：优先用 data/server.pid，pid 失效时用 /api/health 报的 pid 兜底。
// 用法：node scripts/stop.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WB_PORT || 7861);
const PID_FILE = path.join(ROOT, 'data', 'server.pid');

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
};

async function healthPid() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return 0;
    const body = await res.json();
    return body && body.app === 'todo-workbench' ? Number(body.pid) || 0 : 0;
  } catch {
    return 0;
  }
}

const fromFile = (() => {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
})();

const targets = [];
if (fromFile && pidAlive(fromFile)) targets.push(fromFile);
const fromHealth = await healthPid();
if (fromHealth && !targets.includes(fromHealth) && pidAlive(fromHealth)) targets.push(fromHealth);

if (!targets.length) {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  console.log('Workbench is not running.');
  process.exit(0);
}

let failed = 0;
for (const pid of targets) {
  try {
    process.kill(pid);
  } catch {
    failed += 1;
    continue;
  }
  // 给它一点时间走完清理（会自动删 server.pid）
  for (let i = 0; i < 20 && pidAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      failed += 1;
    }
  }
}

try {
  if (!(await healthPid())) fs.rmSync(PID_FILE, { force: true });
} catch {
  /* 忽略 */
}

if (failed) {
  console.error(`Could not stop ${failed} process(es). Try Task Manager.`);
  process.exit(1);
}
console.log('Workbench stopped.');
