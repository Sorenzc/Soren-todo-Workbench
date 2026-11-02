// 极简 DevTools 协议客户端：用系统自带的 Edge 无头模式驱动真实浏览器。
// 只依赖 Node 22+ 的全局 WebSocket / fetch，不引第三方包。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitJson(url, ms = 15000) {
  const end = Date.now() + ms;
  let lastErr;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`连不上 DevTools：${url}（${lastErr?.message || '超时'}）`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.code} ${msg.error.message}`)) : resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面脚本报错：${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }
}

/**
 * 启动无头 Edge 并连上第一个页面。
 * 返回 { cdp, errors, close }，errors 收集页面未捕获异常。
 */
export async function openBrowser({
  edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  port = 9333,
  width = 1440,
  height = 900,
  profile,
} = {}) {
  if (!fs.existsSync(edge)) throw new Error(`找不到 Edge：${edge}`);
  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--window-size=${width},${height}`,
    profile ? `--user-data-dir=${profile}` : '--user-data-dir=' + fs.mkdtempSync('wb-edge-'),
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const close = () => {
    try { child.kill(); } catch { /* ignore */ }
  };

  try {
    await waitJson(`http://127.0.0.1:${port}/json/version`);
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('浏览器没有给出可用的页面目标');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const errors = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
    });

    return { cdp, errors, close, port };
  } catch (err) {
    close();
    throw err;
  }
}
