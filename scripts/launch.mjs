// 后台启动器：把服务 detached 地拉起来，命令行窗口可以立刻关掉，服务继续跑。
// 用法：node scripts/launch.mjs   （start.cmd 双击走的就是这里）
// 约定：只在 127.0.0.1 上跑；已经在跑就直接开页面，不再起第二个。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WB_PORT || 7861);
const URL = `http://127.0.0.1:${PORT}/`;
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const LOG = process.env.WB_LOG || path.join(ROOT, 'data', 'server.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 探一下端口上是不是本工作台；不是（或没起）都算「没起」。 */
async function probe() {
  try {
    const res = await fetch(`${URL}api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.app === 'todo-workbench' ? body : null;
  } catch {
    return null;
  }
}

function openBrowser() {
  // 走 cmd 的 start，交给默认浏览器；detach 掉，不跟着启动器退出
  const child = spawn('cmd.exe', ['/c', 'start', '', URL], {
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

function tailLog(fromByte, maxLines = 12) {
  try {
    const size = fs.statSync(LOG).size;
    const start = Math.max(fromByte, size - 4096);
    const buf = fs.readFileSync(LOG);
    const text = buf.subarray(start).toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

const running = await probe();
if (running) {
  // pidfile 可能落后（上一轮被强杀时没走 exit 清理），这里顺手对齐一次
  try {
    const pidFile = path.join(ROOT, 'data', 'server.pid');
    const live = String(running.pid || '');
    if (live) {
      let onDisk = '';
      try {
        onDisk = fs.readFileSync(pidFile, 'utf8').trim();
      } catch {
        onDisk = '';
      }
      if (onDisk !== live) fs.writeFileSync(pidFile, live, 'utf8');
    }
  } catch {
    /* 写不进去也不影响打开页面 */
  }
  console.log(`Workbench is already running at ${URL}`);
  console.log(`  pid ${running.pid || '?'}  ·  log ${LOG}`);
  openBrowser();
  process.exit(0);
}

const logStart = (() => {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
})();

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env },
});
child.unref();

// 最多等 10 秒（冷启动要开库、可能还要迁移），每 250ms 探一次
let up = null;
for (let i = 0; i < 40 && !up; i += 1) {
  await sleep(250);
  up = await probe();
}

if (up) {
  console.log(`Workbench started in background at ${URL}`);
  console.log(`  pid ${up.pid || child.pid}  ·  log ${LOG}`);
  console.log('You can close this window.');
  process.exit(0);
}

console.error('Workbench did not come up. Last lines of the log:');
console.error('');
const tail = tailLog(logStart);
console.error(tail || `(cannot read ${LOG})`);
console.error('');
console.error('If the port is taken by another program, close it or set WB_PORT.');
process.exit(1);
