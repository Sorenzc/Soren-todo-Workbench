// 真实浏览器端到端：新建 → 改标题自动保存 → 完成并归档 → 撤销 → 清理。
// 用无头 Edge 走真实 DOM 和真实 HTTP，验证「界面接线」而不只是接口。
// 用法：node scripts\e2e.mjs [--url http://127.0.0.1:7861]
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
const EDGE = argOf('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const PORT = Number(argOf('port', '9334'));

const token = fs.readFileSync(path.join(ROOT, 'data', 'token.txt'), 'utf8').trim();
const H = { 'x-wb-token': token, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name + (extra ? `（${extra}）` : ''));
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
}

const stamp = Date.now().toString().slice(-6);
const TITLE = `端到端-${stamp}`;
const TITLE2 = `${TITLE}-改过标题`;
let taskId = null;
let archiveAbs = null;
let seriesId = null;
let modalTaskId = null;

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`工作台没在运行：${BASE}`);

  // 上次中断留下的 E2E 系列/任务先清掉，别越积越多
  try {
    const stale = await api('GET', '/api/series');
    for (const s of stale.data?.series || []) {
      if (/^E2E 例行 /.test(s.title)) await api('DELETE', '/api/series/' + s.id, undefined).catch(() => {});
    }
    const staleTasks = await api('GET', '/api/tasks?status=open&limit=500');
    for (const t of staleTasks.data?.tasks || []) {
      if (/^E2E |^弹窗-/.test(t.title)) await api('POST', `/api/tasks/${t.id}/purge`, {}).catch(() => {});
    }
  } catch { /* 清理失败不影响主流程 */ }

  const created = await api('POST', '/api/tasks', { title: TITLE, priority: 1 });
  taskId = created.data?.task?.id;
  ok('接口建出测试任务', created.status >= 200 && created.status < 300 && !!taskId, `HTTP ${created.status}`);
  if (!taskId) throw new Error('任务没建出来，后续步骤没法继续');

  const profile = path.join(ROOT, 'data', 'edge-cdp-profile');
  const { cdp, errors, close } = await openBrowser({ edge: EDGE, port: PORT, profile });
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/?view=all` });
    await sleep(1200);

    const tok = await cdp.eval('String(window.__WB_TOKEN__ || "")');
    ok('页面拿到注入的令牌', !!tok && !tok.includes('@@WB_TOKEN@@'));

    // 记下未处理的 Promise 拒绝：异步流程里的异常不会进 console.error，只有这个能抓到
    await cdp.eval(`window.__wbRej = [];
      window.addEventListener('unhandledrejection', (e) => window.__wbRej.push(String((e.reason && (e.reason.stack || e.reason)) || e.reason)));
      true`);

    // 点开这一行（用标题精确定位，避免点到别人的任务）
    const clicked = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.row-title')?.textContent || '') === ${JSON.stringify(TITLE)});
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    ok('在列表里点开了测试任务', clicked === true);
    await sleep(700);

    const titleShown = await cdp.eval('document.querySelector(".d-title")?.value || ""');
    ok('详情标题与选中的任务一致', titleShown === TITLE, titleShown);

    // 改标题：走 input 事件，等自动保存（防抖 500ms）
    await cdp.eval(`(() => {
      const ta = document.querySelector('.d-title');
      ta.value = ${JSON.stringify(TITLE2)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1400);
    const afterSave = await api('GET', `/api/tasks/${taskId}`);
    ok('编辑标题自动落库', afterSave.data?.task?.title === TITLE2, afterSave.data?.task?.title);

    // 写笔记，验证 notes_md 也能存
    await cdp.eval(`(() => {
      const ta = document.querySelector('.notes');
      ta.value = '端到端笔记\\n- 第一行';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1400);
    const withNote = await api('GET', `/api/tasks/${taskId}`);
    ok('笔记自动落库', (withNote.data?.task?.notes_md || '').includes('端到端笔记'));

    // 完成并归档
    const completed = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.detail button')].find((b) => /完成并归档/.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    ok('详情里有「完成并归档」并能点', completed === true);
    await sleep(1800);

    const doneTask = await api('GET', `/api/tasks/${taskId}`);
    ok('任务状态变为已完成', doneTask.data?.task?.status === 'done');
    const archivedPath = doneTask.data?.task?.archived_path;
    archiveAbs = archivedPath ? path.join(ROOT, 'archive', archivedPath) : null;
    ok('归档路径已写回数据库', !!archivedPath, archivedPath || '');
    ok('归档 Markdown 文件真的存在', !!archiveAbs && fs.existsSync(archiveAbs));
    if (archiveAbs && fs.existsSync(archiveAbs)) {
      const md = fs.readFileSync(archiveAbs, 'utf8');
      ok('归档文件里有改过的标题', md.includes(TITLE2));
      ok('归档文件里有笔记内容', md.includes('端到端笔记'));
    }

    const toastText = await cdp.eval('document.querySelector(".toast, #toasts")?.textContent || ""');
    ok('页面弹出完成提示', /已完成/.test(toastText), toastText.trim().slice(0, 40));

    // 撤销：点 toast 上的「撤销」按钮
    const undone = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('#toasts button')].find((b) => /撤销/.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    ok('toast 上有撤销按钮', undone === true);
    await sleep(1500);
    const reopened = await api('GET', `/api/tasks/${taskId}`);
    ok('撤销后任务回到未完成', reopened.data?.task?.status === 'open');
    ok('撤销后归档文件被删除', !archiveAbs || !fs.existsSync(archiveAbs));

    // 「某天完成」回顾视图：再完成一次（这次走接口），用深链看当天回顾能否读到它
    await api('POST', `/api/tasks/${taskId}/complete`, { done_note: '端到端回顾' });
    const today = (await api('GET', '/api/bootstrap')).data?.today;
    await cdp.eval(`location.href = '/?view=day&date=${today}'`);
    await sleep(1800);
    const recap = await cdp.eval(`(() => ({
      title: document.querySelector('.view-heading h1')?.textContent || '',
      rows: [...document.querySelectorAll('.row .row-title')].map((n) => n.textContent),
      mode: [...document.querySelectorAll('#dayModeSeg button')].find((b) => (b.className || '').includes('active'))?.textContent || '',
    }))()`);
    ok('深链进入「某天完成」：标题是日期', /月.*日/.test(recap?.title || ''), recap?.title || '');
    ok('深链默认选中「已完成」', (recap?.mode || '').includes('已完成'), recap?.mode || '');
    ok('回顾列表里有刚完成的任务', (recap?.rows || []).some((t) => t.includes(TITLE2)), (recap?.rows || []).join(' | '));
    const openedRecap = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.textContent || '').includes(${JSON.stringify(TITLE2)}));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(1400);
    const recapDetail = await cdp.eval('document.querySelector(".detail .d-title")?.value || ""');
    ok('回顾里能点开详情', openedRecap === true && (recapDetail || '').includes(TITLE2), recapDetail || '');
    const recapMd = await cdp.eval('document.querySelector(".detail textarea.notes")?.value || ""');
    ok('回顾详情里能看到完成说明', (recapMd || '').includes('端到端笔记'), (recapMd || '').slice(0, 30));
    // 切「到期」看同一天：刚完成的这条不应再出现在待办里
    const dueRows = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('#dayModeSeg button')].find((b) => (b.textContent || '').trim() === '到期');
      btn?.click();
      return true;
    })()`);
    await sleep(1400);
    const dueTitles = await cdp.eval('[...document.querySelectorAll(".row .row-title")].map((n) => n.textContent)');
    ok('切「到期」后已完成的条目不再出现', dueRows === true && !(dueTitles || []).some((t) => t.includes(TITLE2)), (dueTitles || []).join(' | '));

    // ---- 新建待办弹窗（完整表单） ----
    await cdp.eval(`location.href = '/?view=all'`);
    await sleep(1600);
    const MODAL_TITLE = `弹窗-${stamp}`;
    modalTaskId = null;
    seriesId = null;

    await cdp.eval(`document.getElementById('qaAdd').click()`);
    await sleep(600);
    ok('点「添加」弹出新建窗口', await cdp.eval('!!document.getElementById("taskModal")') === true);
    ok('新窗口里标题框已聚焦', await cdp.eval('document.activeElement?.id || ""') === 'tmTitle');

    // 空标题直接提交：应被拦下并给出提示
    await cdp.eval(`document.getElementById('tmOk').click()`);
    await sleep(500);
    const emptyErr = await cdp.eval(`document.querySelector('#taskModal .tm-err-global')?.textContent || ''`);
    ok('标题为空时拒绝提交并提示', /待办内容/.test(emptyErr), emptyErr);

    await cdp.eval(`(() => {
      const t = document.getElementById('tmTitle');
      t.value = ${JSON.stringify(MODAL_TITLE)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    // 分类抽屉
    await cdp.eval(`document.getElementById('tmCat').click()`);
    await sleep(400);
    const catOpts = await cdp.eval('document.querySelectorAll("#tmCatDrawer .tm-opt").length');
    ok('分类抽屉列出可选分类', catOpts >= 3, String(catOpts));
    const catPicked = await cdp.eval(`(() => {
      const opt = [...document.querySelectorAll('#tmCatDrawer .tm-opt')].find((b) => (b.textContent || '').includes('合同与法务'));
      if (!opt) return false;
      opt.click();
      return true;
    })()`);
    ok('抽屉里能选中「合同与法务」', catPicked === true);

    // 日期选择
    await cdp.eval(`document.getElementById('tmDue').click()`);
    await sleep(600);
    ok('点截止日期弹出日历', await cdp.eval('!document.getElementById("tmCal").hidden') === true);
    const cells = await cdp.eval('document.querySelectorAll("#tmCal .cal-day").length');
    ok('日历是 6×7 格', cells === 42, String(cells));
    const dueText = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('#tmCal .tm-cal-foot button')].find((x) => (x.textContent || '').trim() === '明天');
      if (!b) return '';
      b.click();
      return document.getElementById('tmDue')?.textContent || '';
    })()`);
    ok('点「明天」把日期写回', /明天/.test(dueText), dueText);

    // 优先级 / 标签 / 预估 / 文件夹 / 笔记
    await cdp.eval(`(() => {
      const p0 = [...document.querySelectorAll('#taskModal .tm-prio button')].find((b) => (b.textContent || '').trim() === 'P0');
      p0?.click();
      const tag = document.querySelector('#taskModal .chip-input');
      tag.value = 'e2e标签';
      tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const chipN = await cdp.eval('document.querySelectorAll("#taskModal .chips .chip").length');
    ok('回车能把标签加进表单', chipN === 1, String(chipN));

    await cdp.eval(`(() => {
      document.getElementById('tmEst').value = '30';
      document.getElementById('tmFolder').value = 'E:\\\\SFH office';
      document.querySelector('#taskModal .tm-notes').value = '弹窗里写的备注';
      return true;
    })()`);
    await cdp.eval(`document.getElementById('tmOk').click()`);
    await sleep(2000);
    const modalState = await cdp.eval(`(() => ({
      open: !!document.getElementById('taskModal'),
      err: document.querySelector('#taskModal .tm-err-global')?.textContent || '',
      toasts: [...document.querySelectorAll('#toasts .toast')].map((n) => n.textContent.trim()),
      rej: (window.__wbRej || []).slice(-3),
    }))()`);
    ok('创建成功后弹窗关闭', modalState.open === false,
      `err=${modalState.err} toasts=${modalState.toasts.join(' | ')} rej=${modalState.rej.join(' | ')}`);

    const openList = await api('GET', '/api/tasks?status=open&limit=500');
    const made = (openList.data?.tasks || []).find((t) => t.title === MODAL_TITLE);
    modalTaskId = made?.id || null;
    ok('弹窗创建的任务出现在列表', !!modalTaskId);

    if (modalTaskId) {
      const boot = await api('GET', '/api/bootstrap');
      const cat = (boot.data?.categories || []).find((c) => c.name === '合同与法务');
      const detail = await api('GET', `/api/tasks/${modalTaskId}`);
      const t = detail.data?.task || {};
      const tags = detail.data?.tags || [];
      const links = detail.data?.links || [];
      const tomorrow = new Date(Date.now() + 86400000);
      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      ok('分类按选择落库', !!cat && t.category_id === cat.id, `${t.category_id} vs ${cat?.id}`);
      ok('优先级按选择落库', t.priority === 0, String(t.priority));
      ok('截止日期按选择落库', t.due_on === tomorrowStr, `${t.due_on} vs ${tomorrowStr}`);
      ok('预估耗时落库', t.estimate_min === 30, String(t.estimate_min));
      ok('笔记落库', (t.notes_md || '').includes('弹窗里写的备注'));
      ok('标签落库', tags.some((x) => (x.name || x) === 'e2e标签'), JSON.stringify(tags.map((x) => x.name || x)));
      ok('关联文件夹落库', links.some((l) => /SFH office/i.test(l.path || '')), JSON.stringify(links.map((l) => l.path)));
    }

    // Esc 关闭
    await cdp.eval(`document.getElementById('qaAdd').click()`);
    await sleep(500);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(500);
    ok('Esc 能关掉新建窗口', await cdp.eval('!document.getElementById("taskModal")') === true,
      await cdp.eval('document.getElementById("taskModal") ? "还在" : "关掉了"'));

    // 联系作者
    await cdp.eval(`document.getElementById('btnContact').click()`);
    await sleep(600);
    const qr = await cdp.eval(`(() => {
      const img = document.querySelector('#contactModal .qr-img');
      return img ? { src: img.getAttribute('src'), w: img.naturalWidth } : null;
    })()`);
    ok('「联系作者」弹出二维码', !!qr && /contact-qr\.png/.test(qr.src || ''), JSON.stringify(qr));
    ok('二维码图片真的加载出来了', (qr?.w || 0) > 100, String(qr?.w || 0));
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    ok('Esc 能关掉二维码弹窗', await cdp.eval('!document.getElementById("contactModal")') === true);

    // 激励作者（收款码）：放在联系作者右边，弹窗版式复用，图片必须是真实加载的正方形
    await cdp.eval(`document.getElementById('btnReward').click()`);
    await sleep(600);
    const reward = await cdp.eval(`(() => {
      const img = document.querySelector('#rewardModal .qr-img');
      const tip = document.querySelector('#rewardModal .qr-tip');
      if (!img) return null;
      return { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, tip: tip ? tip.textContent : '', shown: Math.round(img.width) };
    })()`);
    ok('「激励作者」弹出收款码', !!reward && /reward-qr\.png/.test(reward.src || ''), JSON.stringify(reward));
    ok('收款码图片真的加载出来了', (reward?.w || 0) > 100, String(reward?.w || 0));
    ok('收款码是正方形（不会被拉伸）', !!reward && Math.abs(reward.w / reward.h - 1) < 0.02, reward ? (reward.w / reward.h).toFixed(3) : 'null');
    ok('收款码文案含「您的支持」', /您的支持/.test(reward?.tip || ''), reward?.tip);
    ok('收款码显示尺寸不至于糊（≥200px）', (reward?.shown || 0) >= 200, String(reward?.shown || 0));
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    ok('Esc 能关掉收款码弹窗', await cdp.eval('!document.getElementById("rewardModal")') === true);
    // 连开两次：先联系作者、关掉、再激励作者，验证两个弹窗互不遮挡
    await cdp.eval(`document.getElementById('btnContact').click()`);
    await sleep(300);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btnReward').click()`);
    await sleep(400);
    ok('开过联系作者后激励作者仍能打开', await cdp.eval(`!!document.getElementById('rewardModal')`) === true);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);

    // ---- 每月例行（从侧栏的 ＋ 直接开例行表单） ----
    const seriesTitle = 'E2E 例行 ' + Date.now();
    await cdp.eval(`document.getElementById('btnAddSeries').click()`);
    await sleep(600);
    ok('侧栏「＋」直接打开例行表单', await cdp.eval(`!!document.getElementById('tmRecur') && document.getElementById('tmRecur').checked`) === true);
    ok('例行面板有 1–31 共 31 个号数', await cdp.eval(`document.querySelectorAll('#tmDayGrid .tm-day').length`) === 31,
      String(await cdp.eval(`document.querySelectorAll('#tmDayGrid .tm-day').length`)));
    await cdp.eval(`[...document.querySelectorAll('#tmDayGrid .tm-day')].find((b) => b.textContent.trim() === '28').click()`);
    await sleep(200);
    await cdp.eval(`(() => {
      const t = document.getElementById('tmTitle');
      t.value = ${JSON.stringify(seriesTitle)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return t.value;
    })()`);
    await cdp.eval(`document.getElementById('tmOk').click()`);
    await sleep(2500);
    ok('例行提交后关闭弹窗', await cdp.eval(`!document.getElementById('taskModal')`) === true);
    const seriesToast = await cdp.eval(`[...document.querySelectorAll('#toasts .toast')].map((n) => n.textContent).join(' | ')`);
    ok('提示里说明铺了几期', /每月 28 号/.test(seriesToast) && /36/.test(seriesToast), seriesToast);
    ok('侧栏出现例行条目', await cdp.eval(`(document.getElementById('seriesList')?.textContent || '').includes(${JSON.stringify(seriesTitle)})`) === true);

    const seriesApi = await api('GET', '/api/series');
    const seriesRow = (seriesApi.data?.series || []).find((s) => s.title === seriesTitle);
    seriesId = seriesRow?.id || null;
    ok('例行系列落库，36 期', !!seriesId && seriesRow.total_count === 36, JSON.stringify(seriesRow && { day: seriesRow.day_of_month, total: seriesRow.total_count }));

    await cdp.eval(`document.querySelector('#navViews button:nth-child(4)').click()`);
    await sleep(1200);
    const seriesPage = await cdp.eval(`(() => ({
      title: document.getElementById('viewTitle')?.textContent || '',
      rows: [...document.querySelectorAll('.series-row')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    }))()`);
    ok('例行页标题正确', seriesPage.title.includes('例行'), seriesPage.title);
    ok('例行页列出这个系列', seriesPage.rows.some((r) => r.includes(seriesTitle) && r.includes('每月 28 号')), seriesPage.rows.join(' || '));

    // 从例行页打开某一期，详情里能看到「每月例行」回溯入口
    await cdp.eval(`[...document.querySelectorAll('.series-row button')].find((b) => b.textContent.includes('看下一期'))?.click()`);
    await sleep(1200);
    const detailSeries = await cdp.eval(`(() => ({
      open: document.getElementById('detail')?.classList.contains('open'),
      hasRecur: !!document.querySelector('#detail .d-link'),
    }))()`);
    ok('能打开系列里的一期', detailSeries.open === true, JSON.stringify(detailSeries));
    ok('详情里有例行回溯入口', detailSeries.hasRecur === true);

    ok('页面全程无未捕获异常', errors.length === 0, errors.map((e) => String(e).split('\n')[0]).join(' | '));
  } finally {
    close();
    // 清理：删掉测试任务、测试系列和可能残留的归档文件
    if (taskId) await api('POST', `/api/tasks/${taskId}/purge`, {}).catch(() => {});
    if (modalTaskId) await api('POST', `/api/tasks/${modalTaskId}/purge`, {}).catch(() => {});
    if (seriesId) await api('DELETE', '/api/series/' + seriesId, undefined).catch(() => {});
    try {
      if (archiveAbs && fs.existsSync(archiveAbs)) fs.rmSync(archiveAbs, { force: true });
    } catch { /* ignore */ }
  }
}

try {
  await main();
} catch (err) {
  fails.push('脚本异常：' + (err?.message || err));
  console.log(`  ✗ 脚本异常：${err?.message || err}`);
  if (taskId) await api('POST', `/api/tasks/${taskId}/purge`, {}).catch(() => {});
}

const total = pass + fails.length;
console.log(`\n端到端结果：${pass}/${total} 通过${fails.length ? `，${fails.length} 项失败` : ''}`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
