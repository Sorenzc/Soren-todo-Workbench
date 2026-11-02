#!/usr/bin/env node
/**
 * 界面尺寸审计：用量出来的数字验收，而不是靠眼睛。
 *   node scripts\ui-audit.mjs [--url http://127.0.0.1:7861]
 * 检查项：
 *   1. 所有可见文本的字号都是整数 px，且不小于 10px
 *   2. 顶栏在 900px 视口不溢出，每个按钮都在视口内且文字完整
 *   3. 日历翻页按钮 ≥28×28，左右间隙 4–10px 且左右对称（|差|≤2）
 *   4. 弹窗关闭按钮、主按钮的点击区 ≥28 / ≥32
 * 退出码：有 P0 失败时为 1。
 */
import path from 'node:path';
import fs from 'node:fs';
import { openBrowser } from './lib/cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = argOf('url', process.env.WB_URL || 'http://127.0.0.1:7861');
const PORT = Number(argOf('port', '9347'));

const problems = [];
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const bad = (s) => { problems.push(s); say('  ✗ ' + s); };
const good = (s) => say('  ✓ ' + s);

const profile = path.join(ROOT, 'data', 'edge-audit');
fs.mkdirSync(profile, { recursive: true });
const { cdp, close } = await openBrowser({ port: PORT, profile, width: 1440, height: 900 });

const evalJson = async (expr) => cdp.eval(expr);

async function goto(url, w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + url });
  await new Promise((r) => setTimeout(r, 1400));
}

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  /* ---------------- 1. 字号 ---------------- */
  await goto('/', 1440, 900);
  const fonts = await evalJson(`(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[hidden]')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const key = el.className + '|' + st.fontSize;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cls: String(el.className || el.tagName).slice(0, 28), size: parseFloat(st.fontSize), text: (el.textContent || '').trim().slice(0, 12) });
    }
    return out;
  })()`);
  const fractional = fonts.filter((f) => Math.abs(f.size - Math.round(f.size)) > 0.01);
  const tooSmall = fonts.filter((f) => f.size < 10);
  if (fractional.length) bad(`出现小数号字号 ${fractional.length} 处：` + fractional.slice(0, 4).map((f) => `${f.cls}=${f.size}px`).join(', '));
  else good(`字号全为整数（检查了 ${fonts.length} 类可见文本）`);
  if (tooSmall.length) bad('小于 10px 的文本：' + tooSmall.map((f) => `${f.cls}=${f.size}px`).join(', '));
  const sizes = [...new Set(fonts.map((f) => f.size))].sort((a, b) => a - b);
  say(`    字阶：${sizes.join(' / ')}px`);

  /* ---------------- 2. 顶栏 900px ---------------- */
  await goto('/', 900, 900);
  const bar = await evalJson(`(() => {
    const tb = document.querySelector('.titlebar');
    const items = [...tb.querySelectorAll('button, .search-trigger, .brand')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || el.className, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 6), wrap: el.scrollHeight > el.clientHeight + 2 };
    });
    return { vw: innerWidth, sw: document.documentElement.scrollWidth, items };
  })()`);
  if (bar.sw > bar.vw) bad(`900px 下页面横向溢出：scrollWidth ${bar.sw} > ${bar.vw}`);
  else good(`900px 无横向溢出（scrollWidth ${bar.sw}）`);
  const off = bar.items.filter((i) => i.left < 0 || i.right > bar.vw - 8);
  if (off.length) bad('顶栏控件贴边/出界：' + off.map((i) => `${i.id}(${i.left}..${i.right})`).join(', '));
  else good('顶栏控件都在视口内且右留白 ≥8px');
  const wrapped = bar.items.filter((i) => i.wrap);
  if (wrapped.length) bad('顶栏控件文字换行：' + wrapped.map((i) => i.id).join(', '));
  const search = bar.items.find((i) => String(i.id).includes('search'));
  if (search && search.w < 40) bad(`搜索框被压得过窄：${search.w}px`);
  say('    顶栏控件：' + bar.items.map((i) => `${i.text || i.id}:${i.w}`).join(' '));

  /* ---------------- 3. 日历翻页 ---------------- */
  await goto('/', 1440, 900);
  const calGeom = await evalJson(`(() => {
    const ink = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const one = (root, titleSel) => {
      const navs = root.querySelectorAll('.cal-nav');
      const prev = navs[0].getBoundingClientRect(), next = navs[1].getBoundingClientRect();
      const t = ink(root.querySelector(titleSel));
      return { w: Math.round(prev.width), h: Math.round(prev.height), gapL: +(t.left - prev.right).toFixed(1), gapR: +(next.left - t.right).toFixed(1) };
    };
    document.getElementById('btnCalendar').click();
    const pop = document.getElementById('calendar');
    const a = one(pop, '.cal-ym');
    document.getElementById('btnCalendar').click();
    document.getElementById('qaAdd').click();
    document.getElementById('tmDue').click();
    const tm = document.getElementById('tmCal');
    const b = one(tm, '.tm-cal-ym');
    const close = document.querySelector('#taskModal .tm-x').getBoundingClientRect();
    const ok = document.getElementById('tmOk').getBoundingClientRect();
    document.getElementById('tmCancel').click();
    return { popover: a, inline: b, close: [Math.round(close.width), Math.round(close.height)], ok: [Math.round(ok.width), Math.round(ok.height)] };
  })()`);
  for (const [name, g] of [['顶栏月历', calGeom.popover], ['新建弹窗月历', calGeom.inline]]) {
    if (g.w < 28 || g.h < 28) bad(`${name} 翻页按钮 ${g.w}×${g.h} 小于 28×28`);
    else good(`${name} 翻页按钮 ${g.w}×${g.h}`);
    const inRange = (v) => v >= 4 && v <= 10;
    if (!inRange(g.gapL) || !inRange(g.gapR)) bad(`${name} 标题与翻页按钮间隙越界：左 ${g.gapL}px 右 ${g.gapR}px（应为 4–10）`);
    else if (Math.abs(g.gapL - g.gapR) > 2) bad(`${name} 左右间隙不对称：${g.gapL} vs ${g.gapR}`);
    else good(`${name} 间隙 左 ${g.gapL}px / 右 ${g.gapR}px`);
  }
  if (calGeom.close[0] < 28) bad(`弹窗关闭按钮点击区 ${calGeom.close[0]}×${calGeom.close[1]} < 28`);
  else good(`弹窗关闭按钮 ${calGeom.close[0]}×${calGeom.close[1]}`);
  if (calGeom.ok[1] < 32) bad(`主按钮高度 ${calGeom.ok[1]} < 32`);
  else good(`主按钮 ${calGeom.ok[0]}×${calGeom.ok[1]}`);

  /* ---------------- 4. 收款码 ---------------- */
  await goto('/', 1440, 900);
  const qr = await evalJson(`(() => {
    document.getElementById('btnReward').click();
    const img = document.querySelector('#rewardModal img');
    return new Promise((res) => {
      const done = () => res({ nat: [img.naturalWidth, img.naturalHeight], box: [Math.round(img.width), Math.round(img.height)], fit: getComputedStyle(img).objectFit, tip: document.querySelector('#rewardModal .qr-tip')?.textContent || '' });
      if (img.complete && img.naturalWidth) done(); else img.addEventListener('load', done, { once: true });
    });
  })()`);
  if (!qr.nat[0]) bad('收款码图片没加载出来');
  else good(`收款码 ${qr.nat[0]}×${qr.nat[1]} → 显示 ${qr.box[0]}×${qr.box[1]}`);
  const ratio = qr.nat[0] / qr.nat[1];
  if (Math.abs(ratio - 1) > 0.02) bad(`收款码不是正方形（${ratio.toFixed(3)}），会被拉伸`);
  const modalPng = await evalJson(`(() => {
    const m = document.getElementById('rewardModal').getBoundingClientRect();
    const vh = innerHeight;
    return { h: Math.round(m.height), top: Math.round(m.top), vh };
  })()`);
  if (modalPng.top < 0 || modalPng.top + modalPng.h > modalPng.vh) bad(`1440×900 下收款码弹窗超出视口（${modalPng.h}px / 视口 ${modalPng.vh}）`);
  else good(`收款码弹窗完整可见（${modalPng.h}px）`);
  if (!qr.tip.includes('动力')) bad('收款码文案缺失');
} catch (err) {
  bad('审计异常：' + (err?.message || err));
} finally {
  await close();
}

console.log('');
if (problems.length) {
  console.log(`界面审计：${problems.length} 项不通过`);
  process.exitCode = 1;
} else {
  console.log('界面审计：全部通过');
}
