// 服务端日志：不用 cmd 重定向（每次启动会被截断），直接由 node 自己写文件。
// 目标顺序：WB_LOG 指定路径 → 数据目录 server.log → 临时目录。
// 任何一步失败都静默降级：日志不能反过来拖垮启动。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let stream = null;
let target = '';
let patched = false;

const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

function pickTarget(dataDir) {
  const candidates = [
    process.env.WB_LOG,
    dataDir ? path.join(dataDir, 'server.log') : '',
    path.join(os.tmpdir(), 'TodoWorkbench', 'server.log'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a');
      const s = fs.createWriteStream('', { fd, flags: 'a' });
      return { file, s };
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function initLog(dataDir) {
  const picked = pickTarget(dataDir);
  if (!picked) return '';
  stream = picked.s;
  target = picked.file;
  const line = `\n===== ${stamp()} 启动 pid=${process.pid} node=${process.version} =====\n`;
  try {
    stream.write(line);
  } catch {
    /* 忽略 */
  }
  return target;
}

export function logPath() {
  return target;
}

// 把 console.* 和未捕获异常都落到文件；同时保留控制台输出（开发时还要看）
export function captureConsole() {
  if (patched || !stream) return;
  patched = true;
  const write = (chunk, enc, cb) => {
    try {
      if (chunk != null) stream.write(typeof chunk === 'string' ? chunk : String(chunk));
    } catch {
      /* 忽略 */
    }
    return true;
  };
  console.log = (...args) => {
    const text = args.map(String).join(' ');
    write(`${stamp()} ${text}\n`);
    origStdout(`${args.map(String).join(' ')}\n`);
  };
  console.info = console.log;
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    write(`${stamp()} [warn] ${text}\n`);
    origStderr(`${text}\n`);
  };
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    write(`${stamp()} [error] ${text}\n`);
    origStderr(`${text}\n`);
  };
  process.on('uncaughtException', (err) => {
    write(`${stamp()} [uncaught] ${err && err.stack ? err.stack : err}\n`);
    origStderr(`未捕获异常：${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    write(`${stamp()} [unhandled] ${err && err.stack ? err.stack : err}\n`);
  });
}
