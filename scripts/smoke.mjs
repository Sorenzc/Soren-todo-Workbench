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

// 本地日期加减（别用 toISOString，UTC 会差一天）
function addDaysLocal(ymd, n) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
const createdSeries = [];

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

  // ---- 子待办 ----
  const parentTitle = '冒烟：父任务 ' + Date.now();
  const parentRes = await api('POST', '/api/tasks', { title: parentTitle, priority: 1 });
  const parentId = parentRes.data?.task?.id;
  if (parentId) createdTasks.push(parentId);
  ok('父任务能创建', parentRes.status === 201 && Boolean(parentId), String(parentRes.status));
  const kid1 = await api('POST', '/api/tasks', { title: '冒烟：子项 A ' + Date.now(), parentId });
  const kid2 = await api('POST', '/api/tasks', { title: '冒烟：子项 B ' + Date.now(), parentId });
  const kid1Id = kid1.data?.task?.id;
  if (kid1Id) createdTasks.push(kid1Id);
  if (kid2.data?.task?.id) createdTasks.push(kid2.data.task.id);
  ok('子待办挂到父任务', kid1.status === 201 && kid1.data?.task?.parent_id === parentId && kid2.status === 201);
  ok('父行带子项进度', kid1.data?.task?.child_count === 0, String(kid1.data?.task?.child_count));

  const kidSearch = await api('GET', `/api/tasks?status=all&limit=200&q=${encodeURIComponent('冒烟：子项')}`);
  ok('列表默认不返回子项', (kidSearch.data.tasks || []).length === 0, String((kidSearch.data.tasks || []).length));

  const parentDetail = await api('GET', `/api/tasks/${parentId}`);
  ok('详情带 children', (parentDetail.data?.children || []).length === 2, String((parentDetail.data?.children || []).length));

  const grandKid = await api('POST', '/api/tasks', { title: '冒烟：孙项', parentId: kid1Id });
  ok('子待办下不能再挂子待办（400）', grandKid.status === 400, String(grandKid.status));
  const kidRecur = await api('POST', '/api/tasks', {
    title: '冒烟：子项带例行',
    parentId,
    recurrence: { rule: 'monthly', day_of_month: 1 },
  });
  ok('子待办不能同时开例行（400）', kidRecur.status === 400, String(kidRecur.status));

  // 删父连带软删子项，恢复父时子项一起回来
  await api('DELETE', `/api/tasks/${parentId}`);
  const kidAfterDel = await api('GET', `/api/tasks/${kid1Id}`);
  ok('删父连带软删子项', kidAfterDel.status === 404, String(kidAfterDel.status));
  await api('POST', `/api/tasks/${parentId}/restore`, {});
  const kidBack = await api('GET', `/api/tasks/${kid1Id}`);
  ok('恢复父把子项一起找回', kidBack.status === 200, String(kidBack.status));

  // ---- 到期提醒 ----
  const localMinute = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const remindAt = localMinute(Date.now() - 60000);
  const tRemind = await api('POST', '/api/tasks', { title: '冒烟：提醒到期 ' + Date.now(), remindAt });
  const remindId = tRemind.data?.task?.id;
  if (remindId) createdTasks.push(remindId);
  ok('提醒时间能存下来', tRemind.data?.task?.remind_at === remindAt, String(tRemind.data?.task?.remind_at));
  const badRemind = await api('POST', '/api/tasks', { title: '冒烟：坏提醒', remindAt: '2026-13-45T99:99' });
  ok('非法提醒时间被拒（400）', badRemind.status === 400, String(badRemind.status));

  // 迟到 3 小时的只标记不补发
  const staleAt = localMinute(Date.now() - 3 * 3600 * 1000);
  const tStale = await api('POST', '/api/tasks', { title: '冒烟：过时提醒 ' + Date.now(), remindAt: staleAt });
  const staleId = tStale.data?.task?.id;
  if (staleId) createdTasks.push(staleId);

  const r1 = await api('GET', '/api/reminders');
  const r1ids = (r1.data?.reminders || []).map((x) => x.id);
  ok('到期提醒被领取', r1.status === 200 && r1ids.includes(remindId), JSON.stringify(r1ids));
  ok('迟到太久的提醒不补发', !r1ids.includes(staleId), JSON.stringify(r1ids));
  const r2 = await api('GET', '/api/reminders');
  ok('同一条提醒不会重复领', !(r2.data?.reminders || []).some((x) => x.id === remindId), JSON.stringify(r2.data?.reminders));
  const staleRow = await api('GET', `/api/tasks/${staleId}`);
  ok('迟到的提醒只标记已发', staleRow.data?.task?.remind_fired === 1, String(staleRow.data?.task?.remind_fired));

  // 改提醒时间要重新武装
  const remindAt2 = localMinute(Date.now() - 60000);
  await api('PATCH', `/api/tasks/${staleId}`, { patch: { remindAt: remindAt2 } });
  const r3 = await api('GET', '/api/reminders');
  ok('改了提醒时间能再领一次', (r3.data?.reminders || []).some((x) => x.id === staleId), JSON.stringify(r3.data?.reminders));

  // ---- 父任务完成：子项级联 + 归档 checklist ----
  const doneParent = await api('POST', `/api/tasks/${parentId}/complete`, { done_note: '冒烟父任务完成' });
  ok('父任务完成', doneParent.status === 200 && doneParent.data?.task?.status === 'done', String(doneParent.status));
  const parentAfter = await api('GET', `/api/tasks/${parentId}`);
  const kidsAfter = parentAfter.data?.children || [];
  ok('勾父带子：子项全部完成', kidsAfter.length === 2 && kidsAfter.every((k) => k.status === 'done'), JSON.stringify(kidsAfter.map((k) => k.status)));
  ok('子项完成不单独归档', kidsAfter.every((k) => !k.archived_path), JSON.stringify(kidsAfter.map((k) => k.archived_path)));
  const archiveRel = doneParent.data?.task?.archived_path || '';
  ok('父任务写出归档文件', Boolean(archiveRel), archiveRel);
  let mdText = '';
  try {
    mdText = fs.readFileSync(path.join(root, 'archive', (archiveRel || '').split('/').join(path.sep)), 'utf8');
  } catch {
    mdText = '';
  }
  ok('归档 md 带子项 checklist', /## 子项/.test(mdText) && /- \[x\] 冒烟：子项 A/.test(mdText), mdText.slice(0, 120));
  ok('归档 md 表头记子项进度', /\| 子项 \| 2\/2/.test(mdText), mdText.slice(0, 200));

  // ---- 置顶 / 组内排序 / 导出 / 日历条目 ----
  const canPin1 = await api('POST', '/api/tasks', { title: '冒烟：排序甲', dueOn: '2030-03-03', priority: 3 });
  const canPin2 = await api('POST', '/api/tasks', { title: '冒烟：排序乙', dueOn: '2030-03-03', priority: 3 });
  const pinA = canPin1.data?.task?.id;
  const pinB = canPin2.data?.task?.id;
  if (pinA) createdTasks.push(pinA);
  if (pinB) createdTasks.push(pinB);
  ok('置顶字段默认是 0', canPin1.data?.task?.pinned === 0, String(canPin1.data?.task?.pinned));

  const pinnedAt = await api('PATCH', `/api/tasks/${pinB}`, { patch: { pinned: true } });
  ok('能置顶', pinnedAt.status === 200 && pinnedAt.data?.task?.pinned === 1, String(pinnedAt.data?.task?.pinned));
  const afterPin = await api('GET', `/api/tasks?status=open&limit=50`);
  const order1 = (afterPin.data?.tasks || []).map((t) => t.id);
  ok('置顶排在同类前面', order1.indexOf(pinB) >= 0 && order1.indexOf(pinB) < order1.indexOf(pinA), JSON.stringify(order1.slice(0, 6)));

  // 取消置顶后再比手动排序：sort_order 大的在前
  await api('PATCH', `/api/tasks/${pinB}`, { patch: { pinned: false } });
  const reorder1 = await api('POST', '/api/tasks/reorder', { ids: [pinA, pinB] });
  ok('排序接口接受一组 id', reorder1.status === 200 && reorder1.data?.updated === 2, JSON.stringify(reorder1.data));
  const afterOrder = await api('GET', `/api/tasks?status=open&limit=50`);
  const order2 = (afterOrder.data?.tasks || []).map((t) => t.id);
  ok('手动顺序生效（甲在乙前）', order2.indexOf(pinA) < order2.indexOf(pinB), JSON.stringify(order2.slice(0, 6)));

  const reorder2 = await api('POST', '/api/tasks/reorder', { ids: [pinB, pinA] });
  ok('反向再排一次', reorder2.status === 200, JSON.stringify(reorder2.data));
  const afterOrder2 = await api('GET', `/api/tasks?status=open&limit=50`);
  const order3 = (afterOrder2.data?.tasks || []).map((t) => t.id);
  ok('手动顺序可翻转（乙在甲前）', order3.indexOf(pinB) < order3.indexOf(pinA), JSON.stringify(order3.slice(0, 6)));

  ok('空 ids 被拒', (await api('POST', '/api/tasks/reorder', { ids: [] })).status === 400);
  ok('不存在的 id 被拒', (await api('POST', '/api/tasks/reorder', { ids: ['no-such-task'] })).status === 400);
  ok('重复 id 被拒', (await api('POST', '/api/tasks/reorder', { ids: [pinA, pinA] })).status === 400);

  // 导出：和列表同一筛选口径
  const exportRes = await fetch(`${base}/api/export.md?status=open&q=${encodeURIComponent('冒烟：排序')}`, {
    headers: { 'x-wb-token': token },
  });
  const exportMd = await exportRes.text();
  ok('导出返回 markdown', exportRes.status === 200 && /text\/markdown/.test(exportRes.headers.get('content-type') || ''), exportRes.headers.get('content-type'));
  ok('导出内容跟随筛选', exportMd.includes('冒烟：排序甲') && exportMd.includes('冒烟：排序乙'), exportMd.slice(0, 160));
  ok('导出带勾选框与表头', /^# 待办清单/m.test(exportMd) && /- \[ \] 冒烟：排序甲/.test(exportMd), exportMd.slice(0, 120));

  // 日历条目：同一天的任务要能取到 chip 数据
  const calFrom = '2030-03-01';
  const calTo = '2030-03-07';
  const calMonth = await api('GET', `/api/calendar?from=${calFrom}&to=${calTo}`);
  const calItems = calMonth.data?.items?.['2030-03-03'] || [];
  ok('日历返回格子条目', calMonth.status === 200 && calItems.some((t) => t.id === pinA), JSON.stringify(calItems.map((t) => t.title)));
  ok('日历条目带分类与子项字段', calItems.every((t) => 'category_name' in t && 'child_count' in t), JSON.stringify(calItems[0] || {}));
  ok('日历仍返回计数', (calMonth.data?.days || {})['2030-03-03'] >= 2, JSON.stringify(calMonth.data?.days));

  // 拖 chip 改期走的是普通 PATCH dueOn
  const moved = await api('PATCH', `/api/tasks/${pinA}`, { patch: { dueOn: '2030-03-05' } });
  ok('改期成功', moved.status === 200 && moved.data?.task?.due_on === '2030-03-05', moved.data?.task?.due_on);

  // ---- 每日 / 每周：单行滚动 ----
  const dailyTitle = '冒烟：每日滚动 ' + Date.now();
  const daily = await api('POST', '/api/tasks', {
    title: dailyTitle,
    recurrence: { rule: 'daily', start_date: today, interval_n: 1 },
  });
  const dailySeriesId = daily.data?.series?.id;
  if (dailySeriesId) createdSeries.push(dailySeriesId);
  ok('每日重复只建一条活行', daily.status === 201 && daily.data?.seriesOccurrences === 1, JSON.stringify(daily.data?.seriesOccurrences));
  ok('活行日期就是起始日', daily.data?.task?.due_on === today, daily.data?.task?.due_on);
  ok('每日系列的规则文案', daily.data?.series?.rule_label === '每天', String(daily.data?.series?.rule_label));
  const dailyLiveId = daily.data?.task?.id;
  if (dailyLiveId) createdTasks.push(dailyLiveId);

  const dailyDone = await api('POST', `/api/tasks/${dailyLiveId}/complete`, {});
  const nextDate = dailyDone.data?.repeated?.next;
  ok('完成一期会滚到下一期', Boolean(nextDate) && nextDate > today, String(nextDate));
  ok('活行日期推进到下一期', dailyDone.data?.task?.due_on === nextDate, dailyDone.data?.task?.due_on);
  ok('活行仍然是待办', dailyDone.data?.task?.status === 'open', dailyDone.data?.task?.status);
  ok('这一期变成历史行并归档', Boolean(dailyDone.data?.ghost?.id) && Boolean(dailyDone.data?.ghost?.archived_path), JSON.stringify(dailyDone.data?.ghost));
  const ghostId = dailyDone.data?.ghost?.id;
  const dailySeries1 = await api('GET', `/api/series/${dailySeriesId}`);
  ok('系列累计滚了 1 轮', dailySeries1.data?.series?.repeat_done_count === 1, String(dailySeries1.data?.series?.repeat_done_count));
  ok('系列下一期同步', dailySeries1.data?.series?.next_on === nextDate, String(dailySeries1.data?.series?.next_on));
  const dailyOcc = dailySeries1.data?.tasks || [];
  ok('系列里是活行 + 一条历史行', dailyOcc.length === 2 && dailyOcc.filter((t) => t.status === 'done').length === 1, JSON.stringify(dailyOcc.map((t) => `${t.status}:${t.due_on}`)));

  const dailyDone2 = await api('POST', `/api/tasks/${dailyLiveId}/complete`, {});
  ok('连续完成第二轮', dailyDone2.data?.repeated?.doneCount === 2 && dailyDone2.data?.repeated?.next > nextDate, JSON.stringify(dailyDone2.data?.repeated));

  // 历史行重新打开：滚动系列会断开，不能变成第二条活行
  const reopened = await api('POST', `/api/tasks/${ghostId}/reopen`, {});
  ok('历史行可以重新打开', reopened.status === 200 && reopened.data?.task?.status === 'open', reopened.data?.task?.status);
  ok('重新打开后脱离系列', reopened.data?.task?.series_id === null, String(reopened.data?.task?.series_id));
  if (reopened.data?.task?.id) createdTasks.push(reopened.data.task.id);

  // 每 2 天 + 每周
  const daily2 = await api('POST', '/api/tasks', {
    title: '冒烟：每两天 ' + Date.now(),
    recurrence: { rule: 'daily', start_date: today, interval_n: 2 },
  });
  if (daily2.data?.series?.id) createdSeries.push(daily2.data.series.id);
  ok('每 2 天的文案', daily2.data?.series?.rule_label === '每 2 天', String(daily2.data?.series?.rule_label));
  if (daily2.data?.task?.id) createdTasks.push(daily2.data.task.id);
  const daily2Done = await api('POST', `/api/tasks/${daily2.data.task.id}/complete`, {});
  const expect2 = addDaysLocal(today, 2);
  ok('每 2 天跳 2 天', daily2Done.data?.repeated?.next === expect2, `${daily2Done.data?.repeated?.next} vs ${expect2}`);

  const weekTitle = '冒烟：每周 ' + Date.now();
  const weekly = await api('POST', '/api/tasks', {
    title: weekTitle,
    recurrence: { rule: 'weekly', start_date: today, interval_n: 1, weekday: 0 },
  });
  if (weekly.data?.series?.id) createdSeries.push(weekly.data.series.id);
  if (weekly.data?.task?.id) createdTasks.push(weekly.data.task.id);
  const monday = weekly.data?.task?.due_on || '';
  ok('每周重复从周一开始', monday && (new Date(`${monday}T00:00:00`).getDay() + 6) % 7 === 0, monday);
  ok('每周的文案', String(weekly.data?.series?.rule_label || '').startsWith('每周'), String(weekly.data?.series?.rule_label));
  ok('每周系列一条活行', weekly.data?.seriesOccurrences === 1, String(weekly.data?.seriesOccurrences));

  // 非法参数
  ok('间隔 0 被拒（400）', (await api('POST', '/api/tasks', { title: '冒烟：坏间隔', recurrence: { rule: 'daily', interval_n: 0 } })).status === 400);
  ok('间隔 61 被拒（400）', (await api('POST', '/api/tasks', { title: '冒烟：坏间隔', recurrence: { rule: 'weekly', interval_n: 61 } })).status === 400);
  ok('未知规则被拒（400）', (await api('POST', '/api/tasks', { title: '冒烟：坏规则2', recurrence: { rule: 'weird' } })).status === 400);

  // 日历虚拟展开：未来的期只出现在日历里，不是真的任务行
  const winFrom = today;
  const winTo = addDaysLocal(today, 20);
  const calDaily = await api('GET', `/api/calendar?from=${winFrom}&to=${winTo}`);
  const virt = Object.values(calDaily.data?.items || {}).flat().filter((t) => t.virtual);
  ok('日历里有周期虚拟条目', virt.some((t) => t.series_id === dailySeriesId), JSON.stringify(virt.map((t) => `${t.due_on}:${t.id}`)));
  ok('虚拟条目不可当任务打开（id 带 virt: 前缀）', virt.every((t) => String(t.id).startsWith('virt:')), String(virt[0]?.id));
  ok('虚拟条目不进待办列表', ((await api('GET', `/api/tasks?status=all&limit=500&q=${encodeURIComponent(dailyTitle)}`)).data.tasks || []).every((t) => !String(t.id).startsWith('virt:')));

  // 滚动系列取消 / 恢复
  const rollCancel = await api('POST', `/api/series/${weekly.data.series.id}/cancel`, {});
  ok('滚动系列能取消', rollCancel.status === 200, String(rollCancel.status));
  const weeklyOpen = await api('GET', `/api/tasks?status=open&limit=200&q=${encodeURIComponent(weekTitle)}`);
  ok('取消后活行不在待办里', (weeklyOpen.data.tasks || []).length === 0, String((weeklyOpen.data.tasks || []).length));
  const rollResume = await api('POST', `/api/series/${weekly.data.series.id}/resume`, {});
  ok('滚动系列能恢复', rollResume.status === 200, String(rollResume.status));
  const weeklyBack = await api('GET', `/api/tasks?status=open&limit=200&q=${encodeURIComponent(weekTitle)}`);
  ok('恢复后活行回来且日期不早于今天', (weeklyBack.data.tasks || []).length === 1 && weeklyBack.data.tasks[0].due_on >= today, JSON.stringify((weeklyBack.data.tasks || []).map((t) => t.due_on)));

  // ---------------- 速记（独立一库） ----------------
  const memoMark = `冒烟：速记 ${Date.now()}`;
  const memoNew = await api('POST', '/api/memos', { body: memoMark });
  ok('速记能创建', memoNew.status === 201 && memoNew.data.memo.body === memoMark, String(memoNew.status));
  const memoId = memoNew.data.memo.id;
  ok('速记默认未置顶且 rev=1', memoNew.data.memo.pinned === 0 && memoNew.data.memo.rev === 1);
  const memoList = await api('GET', `/api/memos?q=${encodeURIComponent('冒烟：速记')}`);
  ok('速记列表能按正文搜到', (memoList.data.memos || []).some((m) => m.id === memoId));
  ok('bootstrap 里带速记条数', typeof (await api('GET', '/api/bootstrap')).data.counts.memos === 'number');

  const memoPatched = await api('PATCH', `/api/memos/${memoId}`, { patch: { body: `${memoMark}（改过）` }, rev: 1 });
  ok('速记能改正文', memoPatched.status === 200 && memoPatched.data.memo.rev === 2, String(memoPatched.status));
  const memoStale = await api('PATCH', `/api/memos/${memoId}`, { patch: { body: 'x' }, rev: 1 });
  ok('速记旧 rev 会 409', memoStale.status === 409, String(memoStale.status));
  const memoPinned = await api('PATCH', `/api/memos/${memoId}`, { patch: { pinned: true }, rev: 2 });
  ok('速记能置顶', memoPinned.data.memo.pinned === 1);
  const memoTop = await api('GET', '/api/memos?limit=50');
  ok('置顶的速记排最前', (memoTop.data.memos || [])[0]?.id === memoId);

  ok('空速记被拒 400', (await api('POST', '/api/memos', { body: '   ' })).status === 400);
  ok('超长速记被拒 400', (await api('POST', '/api/memos', { body: 'x'.repeat(4001) })).status === 400);

  ok('速记能软删', (await api('DELETE', `/api/memos/${memoId}`)).status === 200);
  const memoGone = await api('GET', `/api/memos?q=${encodeURIComponent('冒烟：速记')}`);
  ok('删除后列表看不到', !(memoGone.data.memos || []).some((m) => m.id === memoId));
  ok('速记能恢复', (await api('POST', `/api/memos/${memoId}/restore`, {})).status === 200);
  const memoBack = await api('GET', `/api/memos?q=${encodeURIComponent('冒烟：速记')}`);
  ok('恢复后又能看到', (memoBack.data.memos || []).some((m) => m.id === memoId));
  ok('速记能彻底删除', (await api('POST', `/api/memos/${memoId}/purge`, {})).status === 200);
  ok('彻底删除后查详情 404', (await api('GET', `/api/memos/${memoId}`)).status === 404);

  // 清理测试数据
  if (seriesId) await api('DELETE', `/api/series/${seriesId}`);
  for (const sid of createdSeries) {
    try { await api('DELETE', `/api/series/${sid}`); } catch { /* ignore */ }
  }
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
  // 兜底：直接扫归档目录，删掉文件名里带「冒烟」的孤儿 md（滚动系列的历史行会被系列删除带走，
  // 但已经写出的归档文件不会跟着删，上面的按 DB 遍历收不到它们）
  try {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (name.endsWith('.md') && name.includes('冒烟')) fs.rmSync(p, { force: true });
      }
    };
    walk(path.join(root, 'archive'));
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
