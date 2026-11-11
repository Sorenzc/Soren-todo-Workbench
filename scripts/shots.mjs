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
// 选中一条「等待他人」的任务，用来看详情里的状态切换与行上的「等」标
function clickWaitingRow() {
  const rows = [...document.querySelectorAll('.list .row')];
  const row = rows.find((r) => r.querySelector('.row-wait'));
  if (!row) throw new Error('当前页没有等待他人的任务');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function clickFirstRow() {
  const row = document.querySelector('.list .row') || document.querySelector('.row');
  if (!row) throw new Error('没有可点击的任务行');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
// 选中「一张多行卡片里的第一行」，用来看选中描边在卡片上方圆角处有没有被裁
function clickCardFirstRow() {
  const rows = [...document.querySelectorAll('.list .row')];
  const multi = rows.find((r) => {
    const card = r.closest('.card');
    return card && card.querySelectorAll('.row').length >= 2;
  }) || rows[0];
  if (!multi) throw new Error('没有可点击的任务行');
  multi.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function openPalette() {
  // app.js 的快捷键监听挂在 document 上，派发到 window 收不到
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}
// 把列表滚到底，用来拍「等待他人」这种排在最后的分组
function scrollListBottom() {
  setTimeout(() => {
    const list = document.querySelector('#list') || document.querySelector('.list');
    if (list) list.scrollTop = list.scrollHeight;
  }, 900);
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
  if (!btn) throw new Error('侧栏没有「新建例行」按钮');
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

function openMaintenance() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const item = [...document.querySelectorAll('#paletteList .p-item')].find((i) => /设置/.test(i.textContent || ''));
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const btn = [...document.querySelectorAll('.modal .btn')].find((b) => /体检与清理/.test(b.textContent || ''));
  if (!btn) throw new Error('设置里没有「体检与清理」按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function searchArchive() {
  const input = document.getElementById('arcSearch');
  if (!input) throw new Error('归档视图没有搜索框');
  input.value = '会议室';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// 打开设置 → 点「检查更新」，等接口回来（截图前会再等一下）
function checkUpdate() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const item = [...document.querySelectorAll('#paletteList .p-item')].find((i) => /设置/.test(i.textContent || ''));
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const btn = [...document.querySelectorAll('.modal .btn')].find((b) => /检查更新/.test(b.textContent || ''));
  if (!btn) throw new Error('设置里没有「检查更新」按钮');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// 等接口回来后再把弹窗滚到底，这样截图里能看到下载按钮
function scrollModalBottom() {
  setTimeout(() => {
    const m = document.querySelector('.modal');
    if (m) m.scrollTop = m.scrollHeight;
  }, 1800);
}

// 点「下载安装包」，用真实下载验证前端的进度轮询
function clickDownload() {
  setTimeout(() => {
    const btn = [...document.querySelectorAll('.modal .btn')].find((b) => /下载安装包/.test(b.textContent || ''));
    if (!btn) throw new Error('没有找到「下载安装包」按钮');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, 1200);
}

// 多选截图：点第一条，再 Shift 点第二、三条
function pickRows() {
  setTimeout(() => {
    const rows = [...document.querySelectorAll('#list .row[data-id]')];
    if (rows.length < 3) throw new Error('列表里的行不够，无法演示多选');
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  }, 700);
}

// 打印预览截图：直接构造打印 DOM 并显示出来（真打印时只显示这一块）
function showPrintSheet() {
  setTimeout(() => {
    const s = window.__wb.buildPrintSheet();
    s.style.display = 'block';
    s.style.background = '#fff';
    s.style.color = '#111';
    s.style.padding = '28px 34px';
    s.style.margin = '24px auto';
    s.style.maxWidth = '760px';
    s.style.boxShadow = '0 18px 44px rgba(16,24,40,.12)';
    document.querySelector('main.main').append(s);
  }, 900);
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
  calView: { url: '/?view=calendar', desc: '日历视图（整月格子 + 条目）' },
  memo: { url: '/?view=memo', desc: '速记（随手记的便签）' },
  trash: { url: '/?view=trash', desc: '回收站（还原或彻底删除）' },
  waitDetail: { url: '/', desc: '等待他人的任务（状态切换）', steps: [clickWaitingRow] },
  waitingGroup: { url: '/?view=focus', desc: '聚焦页：等待他人分组', steps: [scrollListBottom], settle: 1600 },
  memoDark: { url: '/?view=memo&theme=dark', desc: '深色下的速记' },
  detail: { url: '/', desc: '打开详情面板', steps: [clickFirstRow] },
  detailEdge: { url: '/?view=today', desc: '选中多行卡片的第一行（圆角描边）', steps: [clickCardFirstRow] },
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
  newTaskRecur: { url: '/', desc: '新建待办：例行待办（每月某日）', steps: [openNewTaskRecur, pick28] },
  series: { url: '/?view=series', desc: '例行待办列表' },
  archiveSearch: { url: '/?view=archive', desc: '归档全文搜索', steps: [searchArchive] },
  maintenance: { url: '/', desc: '体检与清理', steps: [openMaintenance] },
  update: { url: '/', desc: '检查更新（发现新版本）', steps: [checkUpdate, scrollModalBottom], settle: 2800 },
  bulk: { url: '/?view=all', desc: '多选与批量操作条', steps: [pickRows], settle: 1600 },
  printSheet: { url: '/?view=today', desc: '打印今日清单（页面预览）', steps: [showPrintSheet], settle: 1600 },
  updateDone: { url: '/', desc: '更新包下载完成（已校验）', steps: [checkUpdate, scrollModalBottom, clickDownload], settle: 14000 },
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
      // 有些场景要等接口回来（比如检查更新），sc.settle 指定额外等待毫秒
      await sleep(sc.settle || 300);
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
