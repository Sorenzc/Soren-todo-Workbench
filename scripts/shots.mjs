// 视觉自查：用 Edge 无头浏览器 + DevTools 协议给工作台拍照。
// 用法：
//   node scripts\shots.mjs                       默认拍几个关键场景，存到 data\shots\
//   node scripts\shots.mjs --scenario focus,dark --out data\shots
//   node scripts\shots.mjs --scenario detail --url http://127.0.0.1:7862
// 需要本机有 Microsoft Edge（Windows 自带），不需要 puppeteer 之类的依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const BASE = argOf('url', 'http://127.0.0.1:7861').replace(/\/$/, '');
const OUT = path.resolve(ROOT, argOf('out', path.join('data', 'shots')));
const EDGE = argOf('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const PORT = Number(argOf('port', '9333'));
const W = Number(argOf('width', '1440'));
const H = Number(argOf('height', '900'));

/* 页面里的点击动作放在浏览器里执行，所以这些函数只是「字符串」 */
function clickFirstRow() {
  const row = document.querySelector('.list .row') || document.querySelector('.row');
  if (!row) throw new Error('没有可点击的任务行');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openPalette() {
  // app.js 的快捷键监听挂在 document 上，派发到 window 收不到
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}
function openSettings() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}
function openCalendar() {
  const btn = document.getElementById('btnCalendar');
  if (!btn) throw new Error('顶栏没有日历按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function clickPaletteCommand() {
  const items = [...document.querySelectorAll('#paletteList .p-item')];
  const item = items.find((i) => /设置/.test(i.textContent || ''));
  if (!item) throw new Error('命令面板里没有「设置」项');
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function openNewTaskRecur() {
  const btn = document.getElementById('btnAddSeries');
  if (!btn) throw new Error('侧栏没有「新建每月例行」按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const t = document.getElementById('tmTitle');
  if (t) {
    t.value = '每月 28 号提交月度总结';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function pick28() {
  const b = [...document.querySelectorAll('#tmDayGrid .tm-day')].find((n) => n.textContent.trim() === '28');
  if (!b) throw new Error('号数面板里没有 28');
  b.click();
}

function openNewTask() {
  const btn = document.getElementById('qaAdd');
  if (!btn) throw new Error('快速添加栏没有「添加」按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openCatDrawer() {
  const btn = document.getElementById('tmCat');
  if (!btn) throw new Error('弹窗里没有分类按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openDatePicker() {
  const btn = document.getElementById('tmDue');
  if (!btn) throw new Error('弹窗里没有日期按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openContact() {
  const btn = document.getElementById('btnContact');
  if (!btn) throw new Error('顶栏没有联系作者按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openReward() {
  const btn = document.getElementById('btnReward');
  if (!btn) throw new Error('顶栏没有激励作者按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function fillNewTask() {
  const t = document.getElementById('tmTitle');
  t.value = '整理 10 月物业例会纪要并发给各部门';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  const est = document.getElementById('tmEst');
  est.value = '45';
  const f = document.getElementById('tmFolder');
  f.value = 'E:\\工作资料';
}

const SCENARIOS = {
  focus: { url: '/', desc: '聚焦（默认首页）' },
  dark: { url: '/?theme=dark', desc: '深色模式' },
  today: { url: '/?view=today', desc: '今天' },
  all: { url: '/?view=all', desc: '全部待办' },
  done: { url: '/?view=done', desc: '已完成' },
  archive: { url: '/?view=archive', desc: '归档' },
  stats: { url: '/?view=stats', desc: '统计' },
  day: { url: '/?view=day', desc: '某一天：当天完成' },
  dayDue: { url: '/?view=day&mode=due', desc: '某一天：当天到期' },
  calendar: { url: '/', desc: '月历浮层', steps: [openCalendar] },
  detail: { url: '/', desc: '打开详情面板', steps: [clickFirstRow] },
  palette: { url: '/', desc: '命令面板', steps: [openPalette] },
  settings: { url: '/', desc: '设置弹窗', steps: [openSettings, clickPaletteCommand] },
  narrow: { url: '/', desc: '窄屏（900px）', width: 900 },
  narrowDetail: { url: '/', desc: '窄屏打开详情浮层', width: 900, steps: [clickFirstRow] },
  newTask: { url: '/', desc: '新建待办弹窗（已填写）', steps: [openNewTask, fillNewTask] },
  newTaskCat: { url: '/', desc: '新建待办：分类抽屉', steps: [openNewTask, openCatDrawer] },
  newTaskDate: { url: '/', desc: '新建待办：日期选择', steps: [openNewTask, openDatePicker] },
  newTaskNarrow: { url: '/', desc: '新建待办（窄屏）', width: 900, steps: [openNewTask, fillNewTask] },
  contact: { url: '/', desc: '联系作者二维码', steps: [openContact] },
  reward: { url: '/', desc: '激励作者收款码', steps: [openReward] },
  newTaskRecur: { url: '/', desc: '新建待办：每月例行', steps: [openNewTaskRecur, pick28] },
  series: { url: '/?view=series', desc: '每月例行列表' },
};

async function main() {
  const wanted = argOf('scenario', 'focus,dark,detail,archive,stats,palette,narrow')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of wanted) if (!SCENARIOS[s]) throw new Error(`未知场景：${s}（可选：${Object.keys(SCENARIOS).join(', ')}）`);

  fs.mkdirSync(OUT, { recursive: true });

  // 先确认服务在
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`工作台没在运行：${BASE}（先 node src\\server.mjs 或 start.cmd）`);

  const profile = path.join(ROOT, 'data', 'edge-cdp-profile');
  fs.mkdirSync(profile, { recursive: true });
  const { cdp, errors, close } = await openBrowser({ edge: EDGE, port: PORT, width: W, height: H, profile });

  try {
    for (const name of wanted) {
      const sc = SCENARIOS[name];
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: sc.width || W, height: H, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Page.navigate', { url: BASE + sc.url });
      await sleep(900);
      // 兜底：如果令牌还是占位符，说明服务端注入有问题，直接报出来
      const tok = await cdp.eval('String(window.__WB_TOKEN__ || "")');
      if (!tok || tok.includes('@@WB_TOKEN@@')) throw new Error('页面里的令牌没有被替换，服务端注入有问题');
      for (const step of sc.steps || []) {
        await cdp.eval(`(${step.toString()})()`);
        await sleep(500);
      }
      await sleep(300);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  ✓ ${name.padEnd(12)} ${sc.desc}  → ${path.relative(ROOT, file)}`);
    }

    if (errors.length) {
      console.log(`\n页面报错 ${errors.length} 处：`);
      for (const e of errors) console.log('  ! ' + String(e).split('\n')[0]);
      process.exitCode = 1;
    } else {
      console.log(`\n页面无未捕获异常。截图在 ${OUT}`);
    }
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error('截图失败：' + err.message);
  process.exit(1);
});
