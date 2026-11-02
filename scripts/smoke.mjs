// 端到端冒烟：真的起一个服务进程，走一遍完整业务链路，最后清理测试数据。
// 用法：node scripts/smoke.mjs          （服务未启动时自动拉起，跑完关闭）
//       node scripts/smoke.mjs --url http://127.0.0.1:7871 --token xxx  （复用已启动的服务）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

let base = argOf('url', '');
let token = argOf('token', '');
let child = null;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    return true;
  }
  fail++;
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}

function readToken() {
  const f = path.join(root, 'data', 'token.txt');
  return fs.readFileSync(f, 'utf8').trim();
}

async function api(method, p, body) {
  const mutating = method !== 'GET';
  const res = await fetch(base + p, {
    method,
    headers: {
      'x-wb-token': token,
      ...(mutating ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : mutating ? '{}' : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function waitUp(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(base + '/api/health', { headers: { 'x-wb-token': token } });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function startServer() {
  const port = 7901 + Math.floor(Math.random() * 80);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, WB_PORT: String(port), WB_NO_OPEN: '1' },
    stdio: 'ignore',
  });
  if (!fs.existsSync(path.join(root, 'data', 'token.txt'))) {
    await new Promise((r) => setTimeout(r, 400));
  }
  token = readToken();
}

function cleanup() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 主流程 ------------------------------ */
const createdTasks = [];
const createdCats = [];

async function main() {
  if (!base) await startServer();
  if (!token) token = readToken();

  ok('服务可达', await waitUp());

  const health = await api('GET', '/api/health');
  ok('GET /api/health 200', health.status === 200 && health.data?.ok === true);

  // 页面必须把值占位符换成真令牌，否则浏览器里会显示「令牌未注入」
  const page = await fetch(base + '/');
  const html = await page.text();
  ok('首页 200 且注入令牌', page.status === 200 && /window\.__WB_TOKEN__ = '[^@']+/.test(html) && !html.includes('@@WB_TOKEN@@'));

  const noToken = await fetch(base + '/api/bootstrap');
  ok('缺少 token 被拒（401/403）', noToken.status === 401 || noToken.status === 403);

  const boot = await api('GET', '/api/bootstrap');
  ok('GET /api/bootstrap 200', boot.status === 200);
  ok('内置 7 个分类', Array.isArray(boot.data?.categories) && boot.data.categories.length >= 7);
  const inbox = boot.data.categories.find((c) => c.id === 'cat-inbox');
  ok('存在系统分类「收件箱」', Boolean(inbox));

  // 分类
  const catName = `冒烟分类-${Date.now()}`;
  const cat = await api('POST', '/api/categories', { name: catName, color: '#8B5CF6' });
  ok('POST /api/categories 201', (cat.status === 200 || cat.status === 201) && cat.data?.category?.id);
  if (cat.data?.category?.id) createdCats.push(cat.data.category.id);
  const catId = cat.data?.category?.id;

  const dupCat = await api('POST', '/api/categories', { name: catName });
  ok('同名分类冲突（409）', dupCat.status === 409);

  // 任务：覆盖 逾期 / 今天 / 明天 / 三天后 / 无日期
  const today = boot.data.today;
  const mk = (t) => api('POST', '/api/tasks', t);
  const tOverdue = await mk({ title: '冒烟：逾期任务', priority: 1, category_id: catId, due_on: '2026-10-10' });
  const tToday = await mk({ title: '冒烟：今天到期', priority: 0, category_id: catId, due_on: today });
  const tSoon = await mk({ title: '冒烟：三天内到期', priority: 2, category_id: catId, due_on: '2026-10-22' });
  const tLater = await mk({ title: '冒烟：很久以后', priority: 3, category_id: catId, due_on: '2026-12-31' });
  const tNoDate = await mk({ title: '冒烟：无日期', priority: 1, category_id: catId, tags: ['冒烟', '归档'] });
  for (const r of [tOverdue, tToday, tSoon, tLater, tNoDate]) {
    if (r.data?.task?.id) createdTasks.push(r.data.task.id);
  }
  ok('POST /api/tasks 保存了 due_on', tOverdue.data?.task?.due_on === '2026-10-10');
  ok('POST /api/tasks 保存了优先级', tToday.data?.task?.priority === 0);
  ok('POST /api/tasks 保存了标签', (tNoDate.data?.task?.tag_names || '').includes('冒烟'));
  const titleRoundTrip = tNoDate.data?.task?.title === '冒烟：无日期';
  ok('中文标题往返不乱码', titleRoundTrip, tNoDate.data?.task?.title);

  const emptyTitle = await api('POST', '/api/tasks', { title: '   ' });
  ok('空标题被拒（400）', emptyTitle.status === 400);

  // 读列表 / 过滤
  const openList = await api('GET', '/api/tasks?status=open');
  ok('GET /api/tasks 返回带 bucket 的行', Array.isArray(openList.data?.tasks) && openList.data.tasks.every((t) => t.bucket));
  const byCat = await api('GET', `/api/tasks?status=open&category=${catId}`);
  ok('按分类过滤', byCat.data.tasks.length === 5, `实际 ${byCat.data.tasks.length}`);
  const byQ = await api('GET', '/api/tasks?status=open&q=' + encodeURIComponent('逾期'));
  ok('按关键字搜索', byQ.data.tasks.some((t) => t.title.includes('逾期')));
  const dueToday = await api('GET', '/api/tasks?status=open&due=today');
  ok('due=today 过滤', dueToday.data.tasks.some((t) => t.id === tToday.data.task.id));

  // 聚焦
  const focus = await api('GET', '/api/focus');
  ok('GET /api/focus 200', focus.status === 200);
  const mustIds = (focus.data.must || []).map((t) => t.id);
  ok('必做含逾期', mustIds.includes(tOverdue.data.task.id));
  ok('必做含今天', mustIds.includes(tToday.data.task.id));
  ok('必做含三天内', mustIds.includes(tSoon.data.task.id));
  ok('必做不含远期', !mustIds.includes(tLater.data.task.id));
  ok('统计：逾期 1 个', focus.data.overdue_count >= 1, String(focus.data.overdue_count));
  const firstMust = focus.data.must?.[0];
  ok('必做按分数降序且带解释', Boolean(firstMust?.why) && firstMust.score >= (focus.data.must[1]?.score ?? 0));

  // 乐观锁
  const detail = await api('GET', `/api/tasks/${tOverdue.data.task.id}`);
  ok('GET /api/tasks/:id 200', detail.status === 200 && detail.data?.task?.id);
  const stale = await api('PATCH', `/api/tasks/${tOverdue.data.task.id}`, {
    rev: detail.data.task.rev + 5,
    patch: { title: '不该写进去' },
  });
  ok('陈旧 rev 返回 409', stale.status === 409);
  const patchOk = await api('PATCH', `/api/tasks/${tOverdue.data.task.id}`, {
    rev: detail.data.task.rev,
    patch: { title: '冒烟：逾期任务（已改）', notes_md: '## 记录\n- 改标题成功' },
  });
  ok('PATCH 成功且 rev+1', patchOk.status === 200 && patchOk.data.task.rev === detail.data.task.rev + 1);

  // 关联文件夹
  const linkDir = path.join(root, 'archive');
  const link = await api('POST', `/api/tasks/${tToday.data.task.id}/links`, {
    path: linkDir,
    kind: 'folder',
    is_primary: true,
    label: '归档目录',
  });
  ok('POST 关联文件夹 201', (link.status === 200 || link.status === 201) && link.data?.link?.id);
  ok('关联路径被规范化', Boolean(link.data?.link?.path));
  const badLink = await api('POST', `/api/tasks/${tToday.data.task.id}/links`, {
    path: 'relative\\path',
    kind: 'folder',
  });
  ok('相对路径被拒（422/400）', badLink.status === 422 || badLink.status === 400);
  const verify = await api('POST', `/api/links/${link.data.link.id}/verify`);
  ok('校验链接存在', verify.status === 200 && verify.data?.link?.exists_state === 'ok');

  // 完成 → 归档
  const done = await api('POST', `/api/tasks/${tToday.data.task.id}/complete`, { done_note: '冒烟完成' });
  ok('完成任务 200', done.status === 200 && done.data?.task?.status === 'done');
  ok('完成写入归档相对路径', /^\d{4}\/\d{4}-\d{2}\//.test(done.data?.task?.archived_path || ''));
  const archiveAbs = path.join(root, 'archive', done.data.task.archived_path || '');
  ok('归档 Markdown 真实存在', fs.existsSync(archiveAbs), archiveAbs);
  if (fs.existsSync(archiveAbs)) {
    const md = fs.readFileSync(archiveAbs, 'utf8');
    ok('归档内容含标题与完成说明', md.includes('冒烟：今天到期') && md.includes('冒烟完成'));
  }
  const doneAgain = await api('POST', `/api/tasks/${tToday.data.task.id}/complete`, {});
  ok('重复完成幂等', doneAgain.status === 200 && doneAgain.data?.task?.status === 'done');

  const tree = await api('GET', '/api/archive/tree');
  ok('GET /api/archive/tree 200', tree.status === 200 && Array.isArray(tree.data?.years));
  const ym = (done.data.task.archived_path || '').split('/')[1];
  const month = await api('GET', `/api/archive/month?ym=${encodeURIComponent(ym)}`);
  ok('GET /api/archive/month 有本月归档', month.status === 200 && (month.data?.tasks || []).some((t) => t.id === done.data.task.id));

  const briefing = await fetch(base + '/api/briefing.md', { headers: { 'x-wb-token': token } });
  const briefText = await briefing.text();
  ok('今日简报 Markdown 可下载', briefing.ok && briefText.includes('#') && briefText.includes('逾期'));

  // 静态素材：顶栏「激励作者」用的收款码必须是 200 + image/png，不能是 403 的错误体
  const qr = await fetch(base + '/assets/reward-qr.png');
  const qrBuf = Buffer.from(await qr.arrayBuffer());
  ok('收款码图片 200', qr.status === 200, String(qr.status));
  ok('收款码 Content-Type 是 image/png', (qr.headers.get('content-type') || '').startsWith('image/png'), qr.headers.get('content-type'));
  ok('收款码是真图片（PNG 头 + >10KB）', qrBuf.length > 10000 && qrBuf[0] === 0x89 && qrBuf[1] === 0x50, `bytes=${qrBuf.length}`);
  const traversal = await fetch(base + '/assets/../src/server.mjs');
  ok('静态目录挡住 ../ 穿越', traversal.status === 404 || traversal.status === 403, String(traversal.status));

  // 重开
  const reopen = await api('POST', `/api/tasks/${tToday.data.task.id}/reopen`, {});
  ok('重新打开 200', reopen.status === 200 && reopen.data?.task?.status === 'open');
  ok('重开后归档文件被清理', !fs.existsSync(archiveAbs));

  // 删除 / 恢复
  const del = await api('DELETE', `/api/tasks/${tLater.data.task.id}`);
  ok('软删除 200', del.status === 200 && del.data?.ok === true);
  const afterDel = await api('GET', '/api/tasks?status=open');
  ok('软删除后不出现在列表', !afterDel.data.tasks.some((t) => t.id === tLater.data.task.id));
  const restore = await api('POST', `/api/tasks/${tLater.data.task.id}/restore`, {});
  ok('恢复 200', restore.status === 200 && restore.data?.task?.id);

  // 统计 / 设置 / 打包
  const stats = await api('GET', '/api/stats');
  ok('GET /api/stats 200', stats.status === 200 && stats.data?.openCount >= 1);
  const set = await api('PUT', '/api/settings', { settings: { leadDays: 5 } });
  ok('PUT /api/settings 生效', set.status === 200 && Number(set.data?.settings?.leadDays) === 5);
  await api('PUT', '/api/settings', { settings: { leadDays: 3 } });

  const backup = await api('POST', '/api/backup', {});
  ok('POST /api/backup 200', backup.status === 200 && backup.data?.file);

  // 日历区间聚合：今天建的「今天到期」任务要出现在计数里
  const cal = await api('GET', `/api/calendar?from=${today}&to=${today}`);
  ok('GET /api/calendar 200', cal.status === 200 && cal.data?.from === today);
  ok('日历计数包含今天到期的任务', Number(cal.data?.days?.[today] || 0) >= 1);
  ok('日历返回开放任务总数', Number(cal.data?.open_total) >= 1);
  const calBad = await api('GET', '/api/calendar?from=2026-10-01&to=2026-09-01');
  ok('日历区间到序被拒（400）', calBad.status === 400);
  const calWide = await api('GET', '/api/calendar?from=2026-01-01&to=2026-12-31');
  ok('日历区间过长被拒（400）', calWide.status === 400);

  // 「某天完成」：doneOn 精确到那一天（按本地时区区间，不走 UTC 的 date()）
  const doneToday = await api('POST', '/api/tasks', {
    title: '冒烟：今天完成的回顾项',
    ...(catId ? { categoryId: catId } : {}),
    due_on: today,
  });
  createdTasks.push(doneToday.data.task.id);
  await api('POST', `/api/tasks/${doneToday.data.task.id}/complete`, { done_note: '冒烟回顾备注' });
  const doneOnToday = await api('GET', `/api/tasks?status=done&doneOn=${today}`);
  ok('doneOn 过滤返回今天完成的记录', doneOnToday.status === 200 && (doneOnToday.data.tasks || []).some((t) => t.id === doneToday.data.task.id));
  const doneOnOther = await api('GET', '/api/tasks?status=done&doneOn=2020-01-01');
  ok('doneOn 过滤不串到别的日期', !(doneOnOther.data.tasks || []).some((t) => t.id === doneToday.data.task.id));
  const onlyDoneOn = await api('GET', `/api/tasks?doneOn=${today}`);
  ok('只给 doneOn 时默认查已完成', onlyDoneOn.status === 200 && (onlyDoneOn.data.tasks || []).every((t) => t.status === 'done'));
  const calDone = await api('GET', `/api/calendar?from=${today}&to=${today}`);
  ok('日历返回当天完成计数', Number(calDone.data?.done_days?.[today] || 0) >= 1);
  const badDoneOn = await api('GET', '/api/tasks?doneOn=2026-02-30');
  ok('非法 doneOn 被拒（400）', badDoneOn.status === 400);

  // 创建时带 folder：回包要带 links（前端据此判断到底关联上没有）
  const withFolder = await api('POST', '/api/tasks', { title: '冒烟：带文件夹创建', folder: process.cwd() });
  createdTasks.push(withFolder.data.task.id);
  ok('创建回包带 links', Array.isArray(withFolder.data.links) && withFolder.data.links.length === 1, JSON.stringify(withFolder.data.linkError));
  ok('创建时关联的文件夹是主关联', withFolder.data.links?.[0]?.is_primary === 1);
  ok('创建成功时 linkError 为空', withFolder.data.linkError === null, String(withFolder.data.linkError));
  const badFolder = await api('POST', '/api/tasks', { title: '冒烟：坏文件夹创建', folder: 'not-a-path' });
  createdTasks.push(badFolder.data.task.id);
  ok('坏路径仍能创建但要回 linkError', badFolder.status === 201 && !!badFolder.data.linkError, badFolder.data.linkError);

  // ---- 每月例行 ----
  const recTitle = '冒烟：每月例行 ' + Date.now();
  const recRes = await api('POST', '/api/tasks', {
    title: recTitle,
    recurrence: { rule: 'monthly', day_of_month: 28, start_month: today.slice(0, 7), horizon_months: 36 },
  });
  const seriesId = recRes.data?.series?.id;
  ok('带 recurrence 创建返回系列', recRes.status === 201 && Boolean(seriesId), JSON.stringify(recRes.data?.series));
  ok('一次铺满 36 期', recRes.data?.seriesOccurrences === 36, String(recRes.data?.seriesOccurrences));
  // 首期从「今天或之后的下一个 28 号」开始，不能落在过去
  const expectFirst = (() => {
    const [y, m] = today.slice(0, 7).split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const cand = `${today.slice(0, 7)}-${String(Math.min(28, last)).padStart(2, '0')}`;
    if (cand >= today) return cand;
    const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    return `${nm}-28`;
  })();
  ok('首期落在今天或之后的下一个 28 号', recRes.data?.task?.due_on === expectFirst, `${recRes.data?.task?.due_on} vs ${expectFirst}`);
  const seriesList = await api('GET', '/api/series');
  const seriesRow = (seriesList.data.series || []).find((s) => s.id === seriesId);
  ok('GET /api/series 列出系列', seriesList.status === 200 && Boolean(seriesRow));
  ok('系列带下一期与期数统计', Boolean(seriesRow?.next_on) && seriesRow?.total_count === 36, JSON.stringify(seriesRow && { next: seriesRow.next_on, total: seriesRow.total_count, open: seriesRow.open_count }));
  ok('远期期挂在排期区（不进列表计数）', (seriesRow?.scheduled_count || 0) >= 30, String(seriesRow?.scheduled_count));
  const occOpen = await api('GET', `/api/tasks?status=open&limit=200&q=${encodeURIComponent(recTitle)}`);
  const occRows = occOpen.data.tasks || [];
  ok('只有本月与下月的期算待办', occRows.length >= 1 && occRows.length <= 3, String(occRows.length));
  ok('期的日期都落在每月 28 号', occRows.every((t) => t.due_on.endsWith('-28')), occRows.slice(0, 3).map((t) => t.due_on).join(','));
  ok('每期都带 series_id', occRows.every((t) => t.series_id === seriesId));
  const occAll = await api('GET', `/api/series/${seriesId}`);
  const occAllRows = occAll.data?.tasks || [];
  ok('36 期都在库里（含排期）', occAllRows.length === 36, String(occAllRows.length));
  ok('排期期的状态是 scheduled', occAllRows.filter((t) => t.status === 'scheduled').length >= 30, JSON.stringify(occAllRows.slice(0, 2)));

  // 再建一个「31 号」的系列：2 月要收敛到 28/29 号，而不是报错
  const r31 = await api('POST', '/api/tasks', {
    title: '冒烟：31 号例行 ' + Date.now(),
    recurrence: { rule: 'monthly', day_of_month: 31, horizon_months: 12 },
  });
  ok('31 号例行能创建', r31.status === 201 && Boolean(r31.data?.series?.id), String(r31.status));
  const r31rows = await api('GET', `/api/series/${r31.data.series.id}`);
  const feb = (r31rows.data.tasks || []).filter((t) => t.due_on.slice(5, 7) === '02');
  ok('2 月的 31 号收敛到月末', feb.length === 1 && Number(feb[0].due_on.slice(8, 10)) >= 28, feb.map((t) => t.due_on).join(','));

  // 非法参数
  const badRec = await api('POST', '/api/tasks', { title: '冒烟：坏例行', recurrence: { rule: 'monthly', day_of_month: 99 } });
  ok('号数 99 被拒（400）', badRec.status === 400, String(badRec.status));
  const badRule = await api('POST', '/api/tasks', { title: '冒烟：坏规则', recurrence: { rule: 'yearly', day_of_month: 1 } });
  ok('不是 monthly 被拒（400）', badRule.status === 400, String(badRule.status));

  // 取消未来 / 恢复 / 删除
  const cancel = await api('POST', `/api/series/${seriesId}/cancel`, { scope: 'future' });
  ok('取消未来 200', cancel.status === 200 && cancel.data?.cancelled >= 1, String(cancel.data?.cancelled));
  const afterCancel = await api('GET', `/api/tasks?status=open&limit=200&q=${encodeURIComponent(recTitle)}`);
  const futureLeft = (afterCancel.data.tasks || []).filter((t) => t.due_on > today);
  ok('取消后明天以后不再有待办', futureLeft.length === 0, futureLeft.slice(0, 3).map((t) => t.due_on).join(','));
  const resume = await api('POST', `/api/series/${seriesId}/resume`, {});
  ok('恢复 200', resume.status === 200 && resume.data?.resumed >= 1, String(resume.data?.resumed));
  const afterResume = await api('GET', `/api/tasks?status=open&limit=200&q=${encodeURIComponent(recTitle)}`);
  ok('恢复后未来期又回来了', (afterResume.data.tasks || []).filter((t) => t.due_on > today).length > 0);
  const delSeries = await api('DELETE', `/api/series/${r31.data.series.id}`);
  ok('删除系列 200', delSeries.status === 200);
  const gone = await api('GET', `/api/series/${r31.data.series.id}`);
  ok('删系列时把它的期一起清掉', gone.status === 404, String(gone.status));

  // 清理测试数据
  if (seriesId) await api('DELETE', `/api/series/${seriesId}`);
  if (catId) await api('DELETE', `/api/categories/${catId}`);
  for (const id of createdTasks) {
    try {
      await fetch(`${base}/api/tasks/${id}/purge`, {
        method: 'POST',
        headers: { 'x-wb-token': token, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
  }
  // 兜底：清掉历史遗留的「冒烟分类-*」（早前中断的测试可能没删干净）
  try {
    const cats = await api('GET', '/api/categories');
    for (const c of cats.data.categories || []) {
      if (/^冒烟/.test(c.name)) await api('DELETE', `/api/categories/${c.id}`);
    }
  } catch {
    /* ignore */
  }
  // 清掉冒烟期间写出的归档文件（任务已 purge，文件可能残留）
  try {
    const sm = await api('GET', '/api/archive/tree');
    for (const y of sm.data.years || []) {
      for (const m of y.months || []) {
        const mm = await api('GET', `/api/archive/month?ym=${encodeURIComponent(m.ym)}`);
        for (const t of mm.data.tasks || []) {
          if (String(t.title || '').startsWith('冒烟')) {
            const abs = path.join(root, 'archive', t.archived_path || '');
            if (t.archived_path && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
}

try {
  await main();
} catch (err) {
  fail++;
  failures.push(`脚本异常：${err && err.stack ? err.stack.split('\n')[0] : err}`);
} finally {
  cleanup();
}

const total = pass + fail;
console.log(`\n冒烟结果：${pass}/${total} 通过${fail ? `，${fail} 项失败` : ''}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(fail ? 1 : 0);
