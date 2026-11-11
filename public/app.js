// 待办工作台 · 前端（零依赖，原生 ES Module）
const TOKEN = window.__WB_TOKEN__;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------ 小工具 ------------------------------ */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

const PRIO = ['P0 紧急', 'P1 重要', 'P2 普通', 'P3 可缓'];
const PRIO_SHORT = ['P0', 'P1', 'P2', 'P3'];
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() { return state.bootstrap?.today || localDate(); }
function localDate(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return localDate(d); }
function daysLeft(due) {
  if (!due) return null;
  return Math.round((Date.parse(due + 'T00:00:00') - Date.parse(todayStr() + 'T00:00:00')) / 86400000);
}
function dueLabel(due) {
  const dl = daysLeft(due);
  if (dl === null) return { text: '无日期', cls: '' };
  if (dl < 0) return { text: `逾期 ${-dl} 天`, cls: 'overdue' };
  if (dl === 0) return { text: '今天', cls: 'today' };
  if (dl === 1) return { text: '明天', cls: 'soon' };
  if (dl <= 3) return { text: `${dl} 天后`, cls: 'soon' };
  const d = parseDate(due);
  return { text: `${d.getMonth() + 1}-${d.getDate()} 周${WEEKDAY[d.getDay()]}`, cls: '' };
}
function fmtTime(iso) {
  if (!iso) return '';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
function initialsOf(name) { return String(name || '?').slice(0, 1); }

/* ------------------------------ API ------------------------------ */
async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-wb-token': TOKEN,
      ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.code = data?.error?.code;
    err.status = res.status;
    err.details = data?.error?.details;
    throw err;
  }
  return data;
}
const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

/* ------------------------------ 状态 ------------------------------ */
const state = {
  bootstrap: null,
  focus: null,
  tasks: [],
  done: [],
  archiveTree: null,
  archiveMonth: null,
  stats: null,
  view: 'focus',
  day: null,
  // day 视图看什么：due=这天到期的未完成，done=这天完成的
  dayMode: 'due',
  cal: { open: false, ym: null, days: {}, doneDays: {}, overdue: 0, loaded: false },
  // 日历视图（和上面那个纯计数的月历浮层是两回事：这里要放条目、能拖改期）
  cv: { mode: 'month', anchor: null, from: '', to: '', days: {}, doneDays: {}, items: {}, overdue: 0 },
  filter: { q: '', cat: null, tag: null, sort: 'score' },
  selectedId: null,
  detail: null,
  showScore: true,
  settingsOpen: false,
  // 新建待办弹窗：{ kind, onEsc, onTab }
  overlay: null,
  // 刚创建的待办：列表里闪一下绿，便于定位
  flashTaskId: null,
  // 每月例行系列
  series: [],
  // 聚焦页小组件：当月 6×7 宫格与本月的每日计数（/api/calendar 一次取回）
  wg: { from: '', to: '', days: {}, doneDays: {}, loaded: false },
  // 速记（独立一库）：列表与搜索词
  memos: [],
  memoQ: '',
  trash: { tasks: [], memos: [], loaded: false },
  // 归档搜索词（只在内存里，不落盘）
  arcQ: '',
  // 多选：Shift/Ctrl 点行进这里，底部操作条据此显示
  picked: new Set(),
  // 静默检查更新拿到的结果（顶栏小圆点用）
  pendingUpdate: null,
};

/* ------------------------------ Toast ------------------------------ */
function toast(msg, opts = {}) {
  const root = $('#toasts');
  const actions = Array.isArray(opts.actions) ? opts.actions : [];
  const box = el('div', { class: 'toast' },
    el('span', { class: 'toast-msg', text: msg }),
    actions.length
      ? el('span', { class: 'toast-actions' }, ...actions.map((a) =>
          el('button', {
            text: a.label,
            onclick: () => { a.onClick?.(); dismiss(); },
          })
        ))
      : opts.actionLabel
        ? el('button', { text: opts.actionLabel, onclick: () => { opts.onAction?.(); dismiss(); } })
        : null,
    el('button', { class: 'toast-close', text: '✕', onclick: () => dismiss() })
  );
  root.append(box);
  const timer = setTimeout(() => dismiss(), opts.ms || 5200);
  function dismiss() {
    clearTimeout(timer);
    box.classList.add('out');
    setTimeout(() => box.remove(), 180);
  }
  return dismiss;
}

/* ------------------------------ 命令面板 / 模态 ------------------------------ */
let paletteItems = [];
let paletteIndex = 0;

function openModal(builder) {
  const root = $('#modalRoot');
  const mask = el('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) closeModal(); } });
  const modal = el('div', { class: 'modal' });
  mask.append(modal);
  root.append(mask);
  builder(modal, closeModal);
  const first = modal.querySelector('input, select, button');
  first?.focus();
  function closeModal() { mask.remove(); }
  return { close: closeModal, mask, modal };
}

function openPalette() {
  const p = $('#palette');
  p.hidden = false;
  const input = $('#paletteInput');
  input.value = '';
  paletteIndex = 0;
  renderPalette('');
  input.focus();
}

function closePalette() {
  $('#palette').hidden = true;
}

function paletteCommands() {
  return [
    { kind: '命令', text: '新建待办（完整表单）', run: () => { closePalette(); openNewTaskModal(); } },
    { kind: '命令', text: '新建例行待办', run: () => { closePalette(); openNewTaskModal({ recurring: true }); } },
    { kind: '命令', text: '联系作者（扫码反馈）', run: () => { closePalette(); openContactModal(); } },
    { kind: '命令', text: '激励作者（支付宝扫码）', run: () => { closePalette(); openRewardModal(); } },
    { kind: '命令', text: '新建分类', run: () => { closePalette(); openCategoryModal(); } },
    { kind: '命令', text: '打开设置', run: () => { closePalette(); openSettings(); } },
    { kind: '命令', text: '今日简报（Markdown）', run: () => { closePalette(); downloadBriefing(); } },
    { kind: '命令', text: '打印今日清单', run: () => { closePalette(); printToday(); } },
    { kind: '命令', text: '打开归档文件夹', run: () => { closePalette(); api.post('/api/open-directory', { target: 'archive' }).catch(showErr); } },
    { kind: '命令', text: '立即备份数据库', run: () => { closePalette(); doBackup(); } },
    { kind: '命令', text: '切换深浅色', run: () => { closePalette(); toggleTheme(); } },
    { kind: '命令', text: '重新生成全部归档文件', run: () => { closePalette(); rerenderArchive(); } },
    { kind: '命令', text: '标签管理（改名 / 合并 / 删除）', run: () => { closePalette(); openTagManager(); } },
    { kind: '命令', text: '回收站（还原或彻底删除）', run: () => { closePalette(); setView('trash'); } },
    // 针对当前选中的待办，省得先点开详情再点按钮
    { kind: '动作', text: '完成当前选中的待办', run: () => { const t = selectedTask(); closePalette(); if (t) completeTask(t); } },
    { kind: '动作', text: '把当前选中的待办推到明天', run: () => { const t = selectedTask(); closePalette(); if (t) pushOneTo(t, addDays(todayStr(), 1)); } },
    { kind: '动作', text: '置顶 / 取消置顶当前选中', run: () => { const t = selectedTask(); closePalette(); if (t) togglePin(t); } },
    { kind: '动作', text: '当前选中的待办标为等待他人', run: () => { const t = selectedTask(); closePalette(); if (t) setTaskStatus(t, 'waiting'); } },
  ];
}

/** 当前选中的待办（列表里找得到的那一份） */
function selectedTask() {
  if (!state.selectedId) { toast('先选中一条待办'); return null; }
  return state.tasks.find((x) => x.id === state.selectedId)
    || state.done.find((x) => x.id === state.selectedId)
    || null;
}

async function setTaskStatus(t, status) {
  try {
    await api.patch(`/api/tasks/${t.id}`, { patch: { status } });
    await refresh();
    toast(status === 'waiting' ? '已标为等待他人（不算逾期）' : '状态已更新');
  } catch (err) { showErr(err); }
}

async function pushOneTo(t, date) {
  try {
    await api.patch(`/api/tasks/${t.id}`, { patch: { dueOn: date } });
    await refresh();
    toast(`已挪到 ${date}`);
  } catch (err) { showErr(err); }
}

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  const cmds = paletteCommands();
  const views = [
    { kind: '视图', text: '聚焦', run: () => setView('focus') },
    { kind: '视图', text: '今天', run: () => setView('today') },
    { kind: '视图', text: '全部待办', run: () => setView('all') },
    { kind: '视图', text: '已完成', run: () => setView('done') },
    { kind: '视图', text: '归档目录', run: () => setView('archive') },
    { kind: '视图', text: '统计', run: () => setView('stats') },
  ];
  const cats = (state.bootstrap?.categories || []).map((c) => ({
    kind: '分类',
    text: c.name,
    run: () => { closePalette(); state.filter.cat = c.id; setView('all'); },
  }));
  const tasks = state.tasks.slice(0, 200).map((t) => ({
    kind: '待办',
    text: t.title,
    sub: `${t.category_name || ''}${t.due_on ? ' · ' + t.due_on : ''}`,
    run: () => { closePalette(); selectTask(t.id); },
  }));
  const all = [...cmds, ...views, ...cats, ...tasks].filter((it) => !q || it.text.toLowerCase().includes(q) || it.kind.includes(q));
  paletteItems = all.slice(0, 40);
  const list = $('#paletteList');
  list.innerHTML = '';
  if (!paletteItems.length) {
    list.append(el('div', { class: 'p-item', text: '没有匹配项' }));
    return;
  }
  paletteIndex = Math.min(paletteIndex, paletteItems.length - 1);
  paletteItems.forEach((it, i) => {
    const row = el('div', { class: `p-item${i === paletteIndex ? ' active' : ''}`, onclick: () => { closePalette(); it.run(); } },
      el('span', { class: 'p-kind', text: it.kind }),
      el('span', { class: 'p-text', text: it.text }),
      it.sub ? el('span', { class: 'p-sub', text: it.sub }) : null
    );
    row.addEventListener('mousemove', () => {
      if (paletteIndex === i) return;
      paletteIndex = i;
      $$('.p-item', list).forEach((n, j) => n.classList.toggle('active', j === i));
    });
    list.append(row);
  });
}

/* ------------------------------ 主题 ------------------------------ */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('wb-theme', theme);
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  api.put('/api/settings', { settings: { theme: next } }).catch(() => {});
}

/* ------------------------------ 数据加载 ------------------------------ */
function showErr(err) {
  console.error(err);
  toast(err?.message || '操作失败');
}

async function loadBootstrap() {
  state.bootstrap = await api.get('/api/bootstrap');
  if (!localStorage.getItem('wb-theme') && state.bootstrap.settings?.theme) {
    applyTheme(state.bootstrap.settings.theme);
  }
  // 日期本身是月历入口：尾巴带一个小箭头，提示可以点
  $('#todayLabel').textContent = `${state.bootstrap.today} 周${WEEKDAY[parseDate(state.bootstrap.today).getDay()]} ▾`;
}

async function loadFocus() {
  state.focus = await api.get('/api/focus');
  // 聚焦面板的三个分区来自同一份「开放任务」列表，保证和列表一致
  const open = await api.get('/api/tasks?status=open&limit=1000');
  state.tasks = open.tasks;
}

/* 聚焦页小组件常驻：条目多的时候换成紧凑模式，少占一点高度，但不消失 */
const WIDGETS_COMPACT_AT = 5;
function widgetsCompact() {
  return (state.bootstrap?.counts?.open ?? 0) >= WIDGETS_COMPACT_AT;
}

async function loadFocusWidgets() {
  // 6×7 宫格 + 本周可能跨月，前后各多取一周，跨度仍在 /api/calendar 的 62 天上限内
  const ym = monthOf(todayStr());
  const from = addDays(`${ym}-01`, -7);
  const to = addDays(addDays(`${monthOf(addMonths(ym, 1))}-01`, -1), 7);
  const r = await api.get(`/api/calendar?from=${from}&to=${to}`);
  state.wg = { from, to, days: r.days || {}, doneDays: r.done_days || {}, loaded: true };
}

async function loadTasks() {
  const params = new URLSearchParams({ status: 'open', limit: '500' });
  if (state.filter.cat) params.set('category', state.filter.cat);
  if (state.filter.tag) params.set('tag', state.filter.tag);
  if (state.filter.q) params.set('q', state.filter.q);
  if (isDoneDay()) {
    // 「这天完成了什么」：用完成时间的本地日期区间查，和日历格子里的 done_days 同源
    params.set('status', 'done');
    params.set('doneOn', state.day);
    params.set('limit', '1000');
  } else if (state.view === 'day' && state.day) {
    // 某一天的列表和日历格子用同一个口径：due_on 精确等于这一天
    params.set('due', state.day);
  }
  const r = await api.get('/api/tasks?' + params.toString());
  state.tasks = r.tasks;
  if (state.view === 'focus') state.focus = await api.get('/api/focus');
}

const isDueDay = () => state.view === 'day' && state.dayMode !== 'done';
const isDoneDay = () => state.view === 'day' && state.dayMode === 'done';

async function loadDone() {
  const r = await api.get('/api/tasks?status=done&limit=500');
  state.done = r.tasks;
}

async function loadSeries() {
  const r = await api.get('/api/series');
  state.series = r.series || [];
}

async function loadArchive() {
  state.archiveTree = await api.get('/api/archive/tree');
}

async function loadStats() {
  state.stats = await api.get('/api/stats');
}

/* ---------------------------- 速记（独立一库） ---------------------------- */
async function loadMemos() {
  const q = state.memoQ ? `?q=${encodeURIComponent(state.memoQ)}&limit=200` : '?limit=200';
  const r = await api.get('/api/memos' + q);
  state.memos = r.memos || [];
}

/* 回收站：软删掉的待办与速记，可以还原或彻底删掉 */
async function loadTrash() {
  const r = await api.get('/api/trash?limit=200');
  state.trash = { tasks: r.tasks || [], memos: r.memos || [], loaded: true };
}

/** 速记的时间口径：刚记的用「刚刚 / N 分钟前」，跨天用日期，跨年带年 */
function memoTime(iso) {
  if (!iso) return '';
  const d = parseDate(String(iso).slice(0, 10));
  const today = parseDate(todayStr());
  const days = Math.round((today - d) / 86400000);
  const hm = String(iso).slice(11, 16);
  if (days <= 0) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    return `今天 ${hm}`;
  }
  if (days === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* --------------------------- 日历视图（月/周） --------------------------- */
/** 当前档位要看的日期区间：月=6×7 的整格窗口，周=周一至周日 */
function calViewRange(mode, anchor) {
  if (mode === 'week') {
    const d = parseDate(anchor);
    const dow = (d.getDay() + 6) % 7; // 周一=0
    const from = localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow));
    return { from, to: addDays(from, 6) };
  }
  const { start, end } = gridRange(monthOf(anchor));
  return { from: start, to: end };
}

async function loadCalendarView() {
  const anchor = state.cv.anchor || todayStr();
  state.cv.anchor = anchor;
  const { from, to } = calViewRange(state.cv.mode, anchor);
  const r = await api.get(`/api/calendar?from=${from}&to=${to}`);
  state.cv.from = from;
  state.cv.to = to;
  state.cv.days = r.days || {};
  state.cv.doneDays = r.done_days || {};
  state.cv.items = r.items || {};
  state.cv.overdue = Number(r.overdue || 0);
}

/** 拖 chip 改期：只改 due_on，其余字段（提醒、子项、标签）都不动 */
async function moveTaskTo(id, date) {
  try {
    const cur = state.cv.items?.[date] || [];
    if (cur.some((t) => t.id === id)) return;
    await api.patch(`/api/tasks/${id}`, { patch: { dueOn: date } });
    await refresh();
    toast(`已挪到 ${mdLabel(date)}`, { ms: 4000 });
  } catch (err) {
    showErr(err);
  }
}

function calChip(t) {
  // 虚拟条目：每日/每周周期里还没到期的那几期，点了只解释一下，不能拖改期
  const virt = Boolean(t.virtual);
  const chip = el('button', {
    class: `cv-chip${t.priority <= 1 ? ' p' + t.priority : ''}${t.due_time ? ' timed' : ''}${virt ? ' virt' : ''}`,
    title: virt
      ? `${t.title} · 周期里的未来一期（${t.rule === 'weekly' ? '每周' : '每天'}重复）`
      : [t.title, t.category_name, t.due_time, t.child_count ? `子项 ${t.child_done || 0}/${t.child_count}` : '']
        .filter(Boolean).join(' · '),
    style: { '--c': t.category_color || null },
    draggable: virt ? undefined : 'true',
    onclick: (e) => {
      e.stopPropagation();
      if (virt) { toast(`「${t.title}」是周期里的未来一期，上一期完成时它会自动变成待办`); return; }
      selectTask(t.id);
    },
  },
    el('span', { class: 'cv-chip-dot', style: { '--c': t.category_color || 'var(--text-3)' } }),
    el('span', { class: 'cv-chip-t', text: t.title }),
    t.due_time ? el('span', { class: 'cv-chip-time', text: t.due_time }) : null
  );
  if (virt) return chip;
  chip.addEventListener('dragstart', (e) => {
    try {
      e.dataTransfer.setData('application/x-wb-task', t.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* 老浏览器不支持自定义类型时靠 drop 的兜底 */ }
    chip.classList.add('dragging');
    dragTaskId = t.id;
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
    dragTaskId = null;
  });
  return chip;
}

let dragTaskId = null;

function calCell(date, opts = {}) {
  const items = state.cv.items?.[date] || [];
  const nDone = state.cv.doneDays?.[date] || 0;
  const isToday = date === todayStr();
  const cell = el('div', {
    class: `cv-day${opts.other ? ' other' : ''}${isToday ? ' today' : ''}${date < todayStr() && items.length ? ' late' : ''}`,
    dataset: { date },
    title: `${date}${items.length ? ` · ${items.length} 条待办` : ''}${nDone ? ` · 完成 ${nDone}` : ''}`,
    onclick: () => setDay(date),
  },
    el('div', { class: 'cv-day-head' },
      el('span', { class: 'cv-day-num', text: String(Number(date.slice(8, 10))) }),
      nDone ? el('span', { class: 'cv-day-done', text: `✓${nDone}` }) : null
    )
  );
  if (opts.mode === 'week') {
    const wrap = el('div', { class: 'cv-week-list' });
    for (const t of items) wrap.append(calChip(t));
    if (!items.length) wrap.append(el('div', { class: 'cv-empty', text: '—' }));
    cell.append(wrap);
  } else {
    const show = items.slice(0, 3);
    for (const t of show) cell.append(calChip(t));
    if (items.length > show.length) cell.append(el('div', { class: 'cv-more', text: `还有 ${items.length - show.length} 条` }));
  }
  cell.addEventListener('dragover', (e) => {
    e.preventDefault();
    cell.classList.add('drop');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
  cell.addEventListener('drop', (e) => {
    e.preventDefault();
    cell.classList.remove('drop');
    let id = '';
    try { id = e.dataTransfer.getData('application/x-wb-task'); } catch { /* 忽略 */ }
    id = id || dragTaskId;
    if (id) moveTaskTo(id, date);
  });
  return cell;
}

function renderCalendarView() {
  const list = $('#list');
  list.innerHTML = '';
  const cv = state.cv;
  const mode = cv.mode;
  const from = cv.from;
  const to = cv.to;
  if (!from || !to) return;
  const wrap = el('div', { class: `calview ${mode}` });

  // 星期表头（周视图里顺带显示每列的日期）
  const head = el('div', { class: 'cv-head' });
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  if (mode === 'week') {
    const d0 = parseDate(from);
    WD.forEach((w, i) => {
      const d = localDate(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i));
      head.append(el('div', { class: `cv-head-cell${d === todayStr() ? ' today' : ''}` },
        el('span', { text: `周${w}` }),
        el('span', { class: 'cv-head-date', text: d.slice(5) })
      ));
    });
  } else {
    WD.forEach((w) => head.append(el('div', { class: 'cv-head-cell', text: `周${w}` })));
  }
  wrap.append(head);

  const grid = el('div', { class: `cv-grid ${mode}` });
  const days = [];
  let cur = from;
  while (cur <= to) { days.push(cur); cur = addDays(cur, 1); }
  const monthPrefix = monthOf(cv.anchor || todayStr());
  for (const d of days) {
    grid.append(calCell(d, { mode, other: mode === 'month' && monthOf(d) !== monthPrefix }));
  }
  wrap.append(grid);
  if (cv.overdue) {
    wrap.append(el('div', { class: 'cv-foot' },
      el('span', { class: 'cv-foot-warn', text: `另有 ${cv.overdue} 条逾期未排进来` }),
      el('button', { class: 'btn small ghost', text: '去今天视图处理', onclick: () => setView('today') })
    ));
  }
  list.append(wrap);
}

async function refresh() {
  try {
    await loadBootstrap();
    // 侧栏「聚焦」计数要跟着今天的逾期/近期待办走，任何视图下都刷新一次
    if (state.view !== 'focus') state.focus = await api.get('/api/focus');
    // 侧栏的例行列表一直要有，不然新建后侧栏不更新
    await loadSeries();
    if (state.view === 'focus') await loadFocus();
    else if (state.view === 'all' || state.view === 'today' || state.view === 'day') await loadTasks();
    else if (state.view === 'series') { /* 上面已经加载过 */ }
    else if (state.view === 'done') await loadDone();
    else if (state.view === 'archive') await loadArchive();
    else if (state.view === 'stats') { await loadTasks(); await loadStats(); }
    else if (state.view === 'calendar') await loadCalendarView();
    else if (state.view === 'memo') await loadMemos();
    else if (state.view === 'trash') await loadTrash();
    // 聚焦页小组件要一份「本月每天几件」的计数，只在用得上的时候取
    if (state.view === 'focus') await loadFocusWidgets();
    if (state.cal.open) await loadCalendarMonth(state.cal.ym);
    // 选中项跟着数据走：任务被完成/删掉后，多选里不该还留着幽灵 id
    if (state.picked.size) {
      const alive = new Set([...(state.tasks || []), ...(state.done || [])].map((t) => t.id));
      for (const id of [...state.picked]) if (!alive.has(id)) state.picked.delete(id);
    }
    renderAll();
  } catch (err) {
    showErr(err);
  }
}

/* ------------------------------ 侧栏 ------------------------------ */
const VIEWS = [
  { id: 'focus', label: '聚焦', icon: '◎' },
  { id: 'today', label: '今天', icon: '◉' },
  { id: 'all', label: '全部待办', icon: '≡' },
  { id: 'series', label: '例行待办', icon: '↻' },
  { id: 'done', label: '已完成', icon: '✓' },
  { id: 'archive', label: '归档', icon: '▤' },
  { id: 'stats', label: '统计', icon: '▦' },
  // 追加在最后：e2e 用 #navViews button:nth-child(4) 点「每月例行」，别插到前面去
  { id: 'calendar', label: '日历', icon: '⊞' },
  // 速记也追加在最后：它是独立一库（便签/备忘录），不参与待办计数
  { id: 'memo', label: '速记', icon: '✎' },
  { id: 'trash', label: '回收站', icon: '⌫' },
];

function renderNav() {
  const nav = $('#navViews');
  nav.innerHTML = '';
  const counts = state.bootstrap?.counts || {};
  const f = state.focus;
  for (const v of VIEWS) {
    let n = '';
    if (v.id === 'focus') n = f?.must?.length || counts.open || '';
    else if (v.id === 'today') n = (counts.overdue || 0) + (counts.today || 0) || '';
    else if (v.id === 'all') n = counts.open ?? '';
    else if (v.id === 'series') n = (state.series || []).filter((s) => s.status === 'active').length || '';
    else if (v.id === 'done') n = counts.done ?? '';
    else if (v.id === 'memo') n = counts.memos ?? '';
    const btn = el('button', { class: `nav-item${state.view === v.id ? ' active' : ''}`, onclick: () => setView(v.id) },
      el('span', { class: 'n-icon', text: v.icon }),
      el('span', { text: v.label }),
      n === '' ? null : el('span', { class: 'n-count', text: String(n) })
    );
    nav.append(btn);
  }
}

function renderCats() {
  const ul = $('#catList');
  ul.innerHTML = '';
  const cats = state.bootstrap?.categories || [];
  const active = state.filter.cat;
  const allBtn = el('li', {},
    el('button', { class: `cat-item${!active ? ' active' : ''}`, onclick: () => { state.filter.cat = null; state.filter.tag = null; if (state.view === 'focus') setView('all'); else refresh(); } },
      el('span', { class: 'cat-dot', style: { '--c': 'var(--text-3)' } }),
      el('span', { class: 'cat-name', text: '全部分类' }),
      el('span', { class: 'cat-n', text: String(state.bootstrap?.counts?.open ?? '') })
    )
  );
  ul.append(allBtn);
  for (const c of cats) {
    const li = el('li', {},
      el('button', {
        class: `cat-item${active === c.id ? ' active' : ''}`,
        title: c.name,
        onclick: () => {
          state.filter.cat = c.id;
          state.filter.tag = null;
          if (state.view === 'focus' || state.view === 'today') setView('all');
          else refresh();
        },
        oncontextmenu: (e) => { e.preventDefault(); openCategoryModal(c); },
      },
        el('span', { class: 'cat-dot', style: { '--c': c.color } }),
        el('span', { class: 'cat-name', text: c.name }),
        el('span', { class: 'cat-n', text: c.open_count ? String(c.open_count) : '' })
      )
    );
    ul.append(li);
  }
}

function renderSeriesSidebar() {
  const ul = $('#seriesList');
  if (!ul) return;
  ul.innerHTML = '';
  const rows = (state.series || []).filter((s) => s.status === 'active');
  $('#seriesSection').hidden = !rows.length;
  for (const s of rows) {
    ul.append(el('li', {},
      el('button', {
        class: 'cat-item', title: `${s.title} · 每月 ${s.day_of_month} 号${s.next_on ? ` · 下一期 ${s.next_on}` : ''}`,
        onclick: () => openSeriesNext(s),
      },
        el('span', { class: 'cat-dot', style: { '--c': 'var(--accent, #2563EB)' } }),
        el('span', { class: 'cat-name', text: s.title }),
        el('span', { class: 'cat-n', text: s.rule === 'monthly' ? `每月${s.day_of_month}` : (s.rule_label || '') })
      )
    ));
  }
}

async function openSeriesNext(s) {
  await openNextOccurrence(s);
}

function renderTags() {
  const box = $('#tagCloud');
  box.innerHTML = '';
  const tags = state.bootstrap?.tags || [];
  $('#tagSection').hidden = !tags.length;
  for (const t of tags) {
    box.append(el('button', {
      class: `tag-chip${state.filter.tag === t.name ? ' active' : ''}`,
      onclick: () => {
        state.filter.tag = state.filter.tag === t.name ? null : t.name;
        state.filter.cat = null;
        if (state.view === 'focus' || state.view === 'today') setView('all');
        else refresh();
      },
    }, `#${t.name}`, el('span', { class: 't-n', text: String(t.task_count ?? '') })));
  }
  // 标签管理：改名（同名即合并）、删除；入口放在标签区标题右侧
  $('#tagManage').hidden = !tags.length;
}

/* 标签管理弹窗：改名会顺带合并同名标签，删除只影响标签本身，不会动待办 */
function openTagManager() {
  const tags = state.bootstrap?.tags || [];
  return openModal((box, done) => {
    box.append(el('h3', { text: '标签管理' }));
    box.append(el('p', { class: 'muted', text: '改名时如果新名字已经存在，会合并成一个标签；删除标签不会删掉待办。' }));
    const wrap = el('div', { class: 'tag-mgr' });
    for (const t of tags) {
      wrap.append(el('div', { class: 'tag-mgr-row' },
        el('span', { class: 'tag-chip', text: `#${t.name}` }),
        el('span', { class: 'muted', text: `${t.task_count ?? 0} 条` }),
        el('span', { class: 'bulk-sp' }),
        el('button', {
          class: 'btn small', text: '改名',
          onclick: async () => {
            const next = window.prompt(`把 #${t.name} 改成：`, t.name);
            if (next === null) return;
            const to = next.trim().replace(/^#/, '');
            if (!to || to === t.name) return;
            try {
              await api.patch(`/api/tags/${encodeURIComponent(t.name)}`, { name: to });
              await loadBootstrap();
              await refresh();
              done();
              openTagManager();
              toast(`已把 #${t.name} 改成 #${to}`);
            } catch (err) { showErr(err); }
          },
        }),
        el('button', {
          class: 'btn small ghost danger', text: '删除',
          onclick: async () => {
            if (!window.confirm(`删掉标签 #${t.name}？${t.task_count ? `它挂在 ${t.task_count} 条待办上，删掉只是去掉这个标签。` : ''}`)) return;
            try {
              await api.del(`/api/tags/${encodeURIComponent(t.name)}`);
              await loadBootstrap();
              await refresh();
              done();
              openTagManager();
              toast(`已删除标签 #${t.name}`);
            } catch (err) { showErr(err); }
          },
        })));
    }
    box.append(wrap);
  });
}

/* ------------------------------ 主列表 ------------------------------ */
// 一行只留四类信息：标题 / 分类 / 优先级 / 到期。色条只表示紧迫度，
// 其余（标签、评分、原因、关联）挪到详情面板，避免一行 8 个元素抢注意力。
function taskRow(t, opts = {}) {
  const isDone = t.status === 'done';
  const isWaiting = t.status === 'waiting';
  const dl = t.due_on ? daysLeft(t.due_on) : null;
  // 等待他人不算逾期：既有红条也不该出现「逾期 N 天」这种催自己的字
  const urgency = isDone || isWaiting || dl === null ? '' : dl < 0 ? 'overdue' : dl === 0 ? 'today' : '';
  const folder = t.primary_link_state === 'missing'
    ? el('span', { class: 'row-folder missing', title: '关联的文件夹找不到了', text: '⚠' })
    : t.link_count ? el('span', { class: 'row-folder', title: '已关联文件夹', text: '📁' }) : null;
  const dueText = isDone
    ? (t.completed_at ? (isDoneDay() ? t.completed_at.slice(11, 16) : t.completed_at.slice(5, 10)) : '')
    : isWaiting ? '等对方'
      : dl === null ? ''
        : dl < 0 ? `逾期 ${-dl} 天`
          : dl === 0 ? '今天'
            : `${parseDate(t.due_on).getMonth() + 1}-${parseDate(t.due_on).getDate()}`;
  const tips = [t.title, t.category_name && `分类：${t.category_name}`, t.due_on && `到期：${t.due_on}`,
    t.tag_names && `标签：${t.tag_names}`, t.why, t.archived_path && `归档：${t.archived_path}`].filter(Boolean).join('\n');
  return el('article', {
    class: `row${isDone ? ' done' : ''}${state.selectedId === t.id ? ' selected' : ''}${state.picked.has(t.id) ? ' picked' : ''}${state.flashTaskId === t.id ? ' flash' : ''}`,
    dataset: { id: t.id }, title: tips,
    onclick: (e) => {
      if (e.target.closest('button')) return;
      // Shift / Ctrl / Cmd 点击 = 多选，不打开详情
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        togglePick(t.id, e.shiftKey);
        return;
      }
      selectTask(t.id);
    },
  },
    el('span', { class: `bar ${urgency}` }),
    isDone
      ? el('button', { class: 'tick', title: '重新打开', text: '✓', onclick: () => reopenTask(t) })
      : el('button', { class: 'tick', title: '标记完成', text: '✓', onclick: () => completeTask(t) }),
    el('span', { class: 'row-title' },
      el('span', { class: 'rt-text', text: t.title }),
      el('span', { class: 'row-badges' },
        t.status === 'waiting' ? el('span', { class: 'row-wait', title: '等待他人（不计逾期）', text: '等' }) : null,
        t.status === 'doing' ? el('span', { class: 'row-doing', title: '进行中', text: '▶' }) : null,
        t.series_id ? el('span', { class: 'row-recur', title: '例行待办', text: '↻' }) : null,
        t.child_count
          ? el('span', {
              class: 'row-child',
              title: `子待办 ${t.child_done || 0}/${t.child_count} 已完成`,
              text: `${t.child_done || 0}/${t.child_count}`,
            })
          : null,
        t.remind_at ? el('span', { class: 'row-remind', title: `提醒：${t.remind_at.replace('T', ' ')}`, text: '⏰' }) : null,
        t.pinned ? el('span', { class: 'row-pin', title: '置顶', text: '📌' }) : null
      )
    ),
    t.category_name
      ? el('span', { class: 'row-cat', style: { '--c': t.category_color || 'var(--text-3)' } },
          el('span', { class: 'd' }), t.category_name)
      : el('span'),
    el('span', { class: `row-prio p${t.priority}`, text: t.priority <= 1 ? PRIO_SHORT[t.priority] : '' }),
    el('span', { class: `row-due ${isDone ? 'done-time' : isWaiting ? 'waiting' : urgency}`, text: dueText }),
    folder || el('span'),
    el('div', { class: 'row-actions' },
      el('button', {
        class: `pin${t.pinned ? ' on' : ''}`,
        title: t.pinned ? '取消置顶' : '置顶（永远排最前）',
        text: '📌',
        onclick: () => togglePin(t),
      }),
      el('button', { title: '打开详情', text: '✎', onclick: () => selectTask(t.id) }),
      el('button', { title: isDone ? '重新打开' : '完成', text: isDone ? '↺' : '✓', onclick: () => (isDone ? reopenTask(t) : completeTask(t)) }),
      el('button', { class: 'danger', title: '删除', text: '🗑', onclick: () => deleteTask(t) })
    )
  );
}

function groupHead(title, count, cls = '', hint = '') {
  return el('div', { class: `group-head ${cls}` },
    el('span', { text: title }),
    el('span', { class: 'g-n', text: String(count) }),
    hint ? el('span', { class: 'g-hint', text: hint }) : null
  );
}

// iOS 风格的「分组内嵌卡片」：一组待办包进一张圆角卡，行还是 36px 网格行
function rowCard(items) {
  const card = el('div', { class: 'card' });
  for (const t of items) card.append(taskRow(t));
  return card;
}

/* ------------------------------ 聚焦页小组件 ------------------------------ */
function greetingOf(hour) {
  if (hour < 6) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 23) return '晚上好';
  return '夜深了';
}

function clockText(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function minuteText(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (!m) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} 分钟`;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/** 今天到期 + 逾期（还没做）的预计耗时，只统计填过预估的 */
function todayLoad() {
  let count = 0;
  let minutes = 0;
  for (const t of state.tasks) {
    if (!t.due_on || daysLeft(t.due_on) > 0) continue;
    count += 1;
    minutes += Number(t.estimate_min || 0);
  }
  return { count, minutes };
}

function greetText(d = new Date()) {
  const load = todayLoad();
  const tail = load.count ? `今天有 ${load.count} 件要处理` : '今天还没有安排';
  return `${greetingOf(d.getHours())}，${tail}`;
}

/** 今天接下来要做的那一件：先按时间排，没填时间的排在后面 */
function nextUp() {
  const todayTasks = state.tasks.filter((t) => t.due_on === todayStr() && t.status !== 'done');
  if (!todayTasks.length) return null;
  const sorted = [...todayTasks].sort((a, b) => {
    const at = a.due_time || '99:99';
    const bt = b.due_time || '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return Number(a.priority) - Number(b.priority);
  });
  const t = sorted[0];
  return { title: t.title, time: t.due_time || '', id: t.id };
}

function fwClock() {
  const now = new Date();
  const load = todayLoad();
  const loadText = load.minutes
    ? `预计 ${minuteText(load.minutes)}${load.count > 1 ? `（${load.count} 件里填了预估的）` : ''}`
    : '给待办填个预估耗时，这里会算出今天要花多久';
  const next = nextUp();
  return el('div', { class: 'fw-card fw-clock' },
    el('div', { class: 'fw-head' }, el('span', { text: '现在' })),
    el('div', { class: 'fw-time', id: 'fwTime', text: clockText(now) }),
    el('div', { class: 'fw-date', id: 'fwDate', text: mdLabel(todayStr()) }),
    el('div', { class: 'fw-greet', id: 'fwGreet', text: greetText(now) }),
    el('div', { class: 'fw-load', id: 'fwLoad', text: loadText }),
    next
      ? el('button', {
          type: 'button', class: 'fw-next', title: '打开这一条',
          onclick: () => selectTask(next.id),
        },
          el('span', { class: 'fw-next-k', text: '接下来' }),
          el('span', { class: 'fw-next-t', text: `${next.time ? `${next.time} ` : ''}${next.title}` }))
      : null
  );
}

function fwMonth() {
  const ym = monthOf(todayStr());
  const first = `${ym}-01`;
  const start = addDays(first, -((parseDate(first).getDay() + 6) % 7));
  const grid = el('div', { class: 'fw-cal' });
  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => grid.append(el('div', { class: 'fw-dow', text: w })));
  let planned = 0;
  let done = 0;
  for (let i = 0; i < 42; i += 1) {
    const date = addDays(start, i);
    const other = monthOf(date) !== ym;
    const count = Number(state.wg.days?.[date] || 0);
    const doneCount = Number(state.wg.doneDays?.[date] || 0);
    if (!other) {
      planned += count;
      done += doneCount;
    }
    const cell = el('button', {
      type: 'button',
      class: `fw-day${other ? ' other' : ''}${date === todayStr() ? ' today' : ''}${doneCount ? ' done' : ''}${count && !other ? ' has' : ''}`,
      title: `${mdLabel(date)} · ${count} 条待办${doneCount ? `，完成 ${doneCount}` : ''}`,
      text: String(parseDate(date).getDate()),
      onclick: () => setDay(date),
    });
    if (count && !other) cell.append(el('span', { class: 'd' }));
    grid.append(cell);
  }
  return el('div', { class: 'fw-card' },
    el('div', { class: 'fw-head' },
      el('span', { text: '本月' }),
      el('span', { text: `${Number(ym.slice(5, 7))} 月` })),
    grid,
    el('div', { class: 'fw-foot' },
      el('span', { text: `排期 ${planned} 条 · 已完成 ${done}` }),
      el('span', { text: '点日期看当天' }))
  );
}

function fwWeek() {
  const today = todayStr();
  const start = addDays(today, -((parseDate(today).getDay() + 6) % 7));
  const cells = [];
  let doneTotal = 0;
  let openTotal = 0;
  let peak = 1;
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const open = Number(state.wg.days?.[date] || 0);
    const doneCount = Number(state.wg.doneDays?.[date] || 0);
    doneTotal += doneCount;
    openTotal += open;
    peak = Math.max(peak, open, doneCount);
    cells.push({ date, open, done: doneCount, isToday: date === today });
  }
  const bars = cells.map((c, i) => {
    const value = c.done && !c.open ? c.done : c.open;
    // 0 条的那天不画条：4px 的短横看着像「有一点点事」，反而误导
    const h = Math.max(4, Math.round(8 + (value / peak) * 56));
    return el('div', { class: `fw-col${c.isToday ? ' today' : ''}` },
      el('div', { class: 'fw-track' },
        value
          ? el('div', {
              class: `fw-bar${c.done && !c.open ? ' done' : c.open ? ' has' : ''}`,
              style: { height: `${h}px` },
              title: `${mdLabel(c.date)} · ${c.open} 条待办，完成 ${c.done}`,
            })
          : null),
      // 紧凑模式列很窄（尤其右边开着详情），「星期一」会把左右两列顶到一起，缩成「周一」
      el('span', {
        class: 'fw-num',
        text: widgetsCompact() ? WEEK_LABELS[i].replace('星期', '周') : WEEK_LABELS[i],
        title: WEEK_LABELS[i],
      })
    );
  });
  const empty = !doneTotal && !openTotal;
  return el('div', { class: 'fw-card' },
    el('div', { class: 'fw-head' },
      el('span', { text: '本周' }),
      el('span', { text: '周一 → 周日' })),
    empty
      ? el('div', { class: 'fw-quiet', text: '这周还没排期，日子是空的也挺好' })
      : el('div', { class: 'fw-week' }, ...bars),
    el('div', { class: 'fw-cap', text: empty ? '想排点什么，按 C 记一条' : `完成 ${doneTotal} · 还有 ${openTotal} 条排期` })
  );
}

function focusWidgets() {
  if (!state.wg.loaded) return null;
  return el('div', { class: widgetsCompact() ? 'fw fw-compact' : 'fw' }, fwClock(), fwMonth(), fwWeek());
}

function renderFocus() {
  const list = $('#list');
  list.innerHTML = '';
  const f = state.focus;
  const items = state.tasks;
  // 小组件常驻在最上面（条目多时自动收成紧凑模式），下面才是任务
  const widgets = focusWidgets();
  if (widgets) list.append(widgets);
  if (!f || !items.length) {
    if (!widgets) {
      showEmpty('今天没有必须处理的事项', '按 N 记一条，或切到「全部待办」看看还有什么。');
      return;
    }
    // 有小组件时，空状态给三条路，而不是一句「没有」
    list.append(el('div', { class: 'fw-empty' },
      el('span', { class: 't', text: '今天还没有安排。' }),
      el('button', { class: 'btn small', text: '记一条', title: '光标进速记框（C）', onclick: () => $('#captureInput')?.focus() }),
      el('button', { class: 'btn small', text: '看看全部待办', onclick: () => setView('all') }),
      el('button', { class: 'btn small', text: '今日简报', title: '导出今天的 Markdown 简报', onclick: () => downloadBriefing() })
    ));
    return;
  }
  const must = f.must || [];
  const week = f.week || [];
  const pinned = items.filter((t) => t.pinned);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const mustIds = new Set(must.map((t) => t.id));
  const weekIds = new Set(week.map((t) => t.id));
  // 「等待他人」在等对方，别混进待办池里跟着排到期
  const waitingIds = new Set((f.waiting || []).map((t) => t.id));
  const pool = items.filter((t) => !pinnedIds.has(t.id) && !mustIds.has(t.id) && !weekIds.has(t.id) && !waitingIds.has(t.id));

  // 置顶永远在最前：范围档、排序都压不住它，这是置顶的全部意义
  if (pinned.length) {
    list.append(groupHead('置顶', pinned.length, 'pin', '不参与到期排序'));
    list.append(rowCard(pinned));
  }
  if (must.length) {
    // 「即将逾期」比「必做」更好懂：这里放的就是逾期 + 快到期 + 久未处理的硬骨头
    const breakdown = [
      f.overdue_count ? `逾期 ${f.overdue_count}` : '',
      f.today_count ? `今天 ${f.today_count}` : '',
    ].filter(Boolean).join(' · ');
    const hint = breakdown || '拖了很久的 P0/P1';
    list.append(groupHead('即将逾期', must.length, f.overdue_count ? 'overdue' : '', hint));
    list.append(rowCard(must.filter((t) => !pinnedIds.has(t.id))));
  }
  if (week.length) {
    list.append(groupHead('本周', week.length, '', '7 天内到期'));
    list.append(rowCard(week.filter((t) => !pinnedIds.has(t.id))));
  }
  const poolShow = pool.slice(0, 60);
  if (poolShow.length) {
    list.append(groupHead('待办池', pool.length, '', '无日期或 7 天以后'));
    list.append(rowCard(poolShow));
    if (pool.length > poolShow.length) {
      list.append(el('div', { class: 'list-foot', text: `还有 ${pool.length - poolShow.length} 条在池子里，用搜索或「全部待办」查看` }));
    }
  }
  // 等待他人单独一段：在等对方，不算逾期，也不参与上面的排序
  const waiting = f.waiting || [];
  if (waiting.length) {
    list.append(groupHead('等待他人', waiting.length, 'wait', '不算逾期 · 等对方有动静再挪回来'));
    list.append(rowCard(waiting));
  }
}

function renderToday() {
  const list = $('#list');
  list.innerHTML = '';
  const overdue = state.tasks.filter((t) => daysLeft(t.due_on) < 0);
  const today = state.tasks.filter((t) => daysLeft(t.due_on) === 0);
  if (!overdue.length && !today.length) {
    showEmpty('今天没有到期的待办', '看看「聚焦」里的本周事项，或者给后面的任务排个日期。');
    return;
  }
  if (overdue.length) {
    const head = groupHead('逾期', overdue.length, 'overdue', '');
    head.append(el('button', {
      class: 'btn small ghost', style: { marginLeft: 'auto' },
      text: `全推到明天`,
      onclick: () => pushOverdueTo(overdue, addDays(todayStr(), 1)),
    }));
    head.append(el('button', {
      class: 'btn small ghost',
      style: { marginLeft: '8px' },
      text: `一键完成 ${overdue.length} 条`,
      onclick: () => completeOverdue(overdue),
    }));
    list.append(head);
    list.append(rowCard(overdue));
  }
  if (today.length) {
    list.append(groupHead('今天到期', today.length, 'today', ''));
    list.append(rowCard(today));
  }
}

/**
 * 逾期批量完成：逐条走 /complete，中间失败不中断，结尾报 ok/total。
 * 确认文案只在真会发生的时候提一句（每月例行会滚下一期、父任务会带上子项），
 * 不为不存在的副作用吓人。
 */
async function completeOverdue(items) {
  const list = [...items];
  if (!list.length) return;
  const recur = list.filter((t) => t.series_id).length;
  const withKids = list.filter((t) => (t.child_count || 0) > 0).length;
  const extra = [];
  if (recur) extra.push(`${recur} 条是例行待办，只完成这一期，系列照常排下一期`);
  if (withKids) extra.push(`${withKids} 条带子待办，未完成的子项会一并勾上`);
  const sure = window.confirm(
    `完成这 ${list.length} 条逾期待办？${extra.length ? '\n\n' + extra.join('；') + '。' : ''}`
  );
  if (!sure) return;
  let ok = 0;
  const fails = [];
  for (const t of list) {
    try {
      await api.post(`/api/tasks/${t.id}/complete`, {});
      ok += 1;
    } catch (err) {
      fails.push(`${t.title}：${err?.message || '失败'}`);
    }
  }
  await refresh();
  toast(`已完成 ${ok}/${list.length} 条逾期待办${fails.length ? `，${fails.length} 条失败（${fails[0]}）` : ''}`, { ms: 7000 });
}

const SORT_LABEL = { score: '智能', due: '到期时间', priority: '优先级', created: '创建时间' };

/**
 * 逾期批量改期：不完成，只是整体挪到某一天。
 * 比「全完成」温柔，也比一条条点日期快。
 */
async function pushOverdueTo(items, date) {
  const list = [...items];
  if (!list.length) return;
  const sure = window.confirm(`把这 ${list.length} 条逾期挪到 ${date}？改期不会动完成状态。`);
  if (!sure) return;
  try {
    const r = await api.post('/api/tasks/bulk-reschedule', { ids: list.map((t) => t.id), dueOn: date });
    await refresh();
    toast(`已挪到 ${date}：${r.updated} 条${r.failed && r.failed.length ? `，${r.failed.length} 条没挪成` : ''}`);
  } catch (err) {
    toast(`改期失败：${err.message}`);
  }
}

/**
 * 七段分组：置顶 → 逾期 → 今天 → 本周 → 本月 → 以后 → 无日期。
 * 置顶排最前、且不受「范围」影响——这是置顶唯一的意义，不能又被日期压下去。
 */
function bucketOfTask(t, today = todayStr()) {
  if (t.pinned) return 'pinned';
  if (!t.due_on) return 'nodate';
  const dl = daysLeft(t.due_on);
  if (dl < 0) return 'overdue';
  if (dl === 0) return 'today';
  if (dl <= 7) return 'week';
  if (monthOf(t.due_on) === monthOf(today)) return 'month';
  return 'later';
}
const BUCKETS = [
  ['pinned', '置顶', 'pin'],
  ['overdue', '逾期', 'overdue'],
  ['today', '今天', 'today'],
  ['week', '本周', ''],
  ['month', '本月', ''],
  ['later', '以后', ''],
  ['nodate', '无日期', ''],
];

function renderAllList() {
  const list = $('#list');
  list.innerHTML = '';
  let items = [...state.tasks];
  if (state.filter.q) {
    const q = state.filter.q.toLowerCase();
    items = items.filter((t) => `${t.title} ${t.notes_md || ''} ${t.tag_names || ''}`.toLowerCase().includes(q));
  }
  const sorters = {
    score: (a, b) => (b.score || 0) - (a.score || 0) || a.priority - b.priority,
    due: (a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.priority - b.priority,
    priority: (a, b) => a.priority - b.priority || (a.due_on || '9999').localeCompare(b.due_on || '9999'),
    created: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  };
  items.sort(sorters[state.filter.sort] || sorters.score);
  if (!items.length) {
    showEmpty('这里还没有待办', '用顶部输入框添加第一条：写标题即可，还能带 #分类 !P0 @明天。');
    return;
  }
  const buckets = new Map();
  for (const t of items) {
    const k = bucketOfTask(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  const flag = state.filter.q ? `搜索「${state.filter.q}」` : `按${SORT_LABEL[state.filter.sort] || '智能'}排序 · 可拖动排序`;
  for (const [key, label, cls] of BUCKETS) {
    const group = buckets.get(key) || [];
    if (!group.length) continue;
    list.append(groupHead(label, group.length, cls, key === 'pinned' ? '永远排最前' : key === 'overdue' ? '拖了很久' : ''));
    const card = rowCard(group);
    list.append(card);
    enableRowDrag(card);
  }
  // 分组说明放在最后一行，不跟第一个分组头抢注意力
  list.append(el('div', { class: 'list-foot', text: flag }));
}

/* 组内拖拽排序：只调顺序，不改分组（拖不回「无日期」里去） */
let rowDragId = null;
function enableRowDrag(card) {
  const rows = [...card.querySelectorAll('.row')];
  if (rows.length < 2) return;
  for (const row of rows) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      rowDragId = row.dataset.id;
      row.classList.add('dragging');
      try {
        e.dataTransfer.setData('text/plain', rowDragId);
        e.dataTransfer.effectAllowed = 'move';
      } catch { /* 忽略 */ }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      rowDragId = null;
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drop-near');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-near'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-near');
      let from = '';
      try { from = e.dataTransfer.getData('text/plain'); } catch { /* 忽略 */ }
      from = from || rowDragId;
      const to = row.dataset.id;
      if (!from || !to || from === to) return;
      const order = [...card.querySelectorAll('.row')].map((n) => n.dataset.id);
      const fi = order.indexOf(from);
      const ti = order.indexOf(to);
      if (fi < 0 || ti < 0) return;
      order.splice(fi, 1);
      order.splice(ti, 0, from);
      await saveOrder(order);
    });
  }
}

async function saveOrder(ids) {
  try {
    await api.post('/api/tasks/reorder', { ids });
    await refresh();
  } catch (err) {
    showErr(err);
  }
}

async function togglePin(t) {
  try {
    await api.patch(`/api/tasks/${t.id}`, { patch: { pinned: !t.pinned } });
    await refresh();
    toast(t.pinned ? '已取消置顶' : '已置顶，会一直排在列表最前');
  } catch (err) {
    showErr(err);
  }
}

/* --------------------------- 多选与批量 ----------------------------- */
// Shift 连选：从上次点的那条到这一条之间全选；单独 Shift 点则只切换这一条
function togglePick(id, shift) {
  const rows = [...document.querySelectorAll('#list .row')].map((r) => r.dataset && r.dataset.id).filter(Boolean);
  if (shift && state.pickAnchor && rows.includes(state.pickAnchor)) {
    const a = rows.indexOf(state.pickAnchor);
    const b = rows.indexOf(id);
    if (b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (const rid of rows.slice(lo, hi + 1)) state.picked.add(rid);
      state.pickAnchor = id;
      syncPickedRows();
      return;
    }
  }
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.pickAnchor = id;
  syncPickedRows();
}

function syncPickedRows() {
  const ids = state.picked;
  for (const row of document.querySelectorAll('#list .row')) {
    // 用 add/remove 而不是 toggle(cls, force)：极简 DOM 垫片里 toggle 的第二个参数会被忽略
    if (row.dataset && ids.has(row.dataset.id)) row.classList.add('picked');
    else row.classList.remove('picked');
  }
  renderBulkBar();
}

function clearPicked() {
  state.picked.clear();
  state.pickAnchor = null;
  syncPickedRows();
}

function pickedTasks() {
  const all = [...state.tasks, ...state.done];
  const byId = new Map(all.map((t) => [t.id, t]));
  return [...state.picked].map((id) => byId.get(id)).filter(Boolean);
}

// 底部操作条：只在有选中时出现，动作全部走后端批量接口
function renderBulkBar() {
  let bar = $('#bulkBar');
  const n = state.picked.size;
  if (!n) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = el('div', { class: 'bulk-bar', id: 'bulkBar' });
    (document.querySelector('main.main') || $('#list')?.parentElement || document.body).append(bar);
  }
  bar.innerHTML = '';
  const items = pickedTasks();
  const hasRolling = items.some((t) => t.series_id);
  bar.append(
    el('span', { class: 'bulk-n', text: `已选 ${n} 条` }),
    el('button', {
      class: 'btn small', text: '完成',
      title: '标记完成并归档（例行待办只完成这一期）',
      onclick: () => bulkDo('complete', items),
    }),
    el('button', { class: 'btn small', text: '改到明天', onclick: () => bulkDo('tomorrow', items) }),
    el('button', { class: 'btn small', text: '改到本周日', onclick: () => bulkDo('sunday', items) }),
    el('button', { class: 'btn small', text: '打标签', onclick: () => bulkDo('tag', items) }),
    el('button', { class: 'btn small', text: '移分类', onclick: () => bulkDo('category', items) }),
    el('button', { class: 'btn small', text: '改提醒', onclick: () => bulkDo('remind', items) }),
    el('button', { class: 'btn small ghost danger', text: '删除', onclick: () => bulkDo('delete', items) }),
    el('span', { class: 'bulk-sp' }),
    el('button', { class: 'btn small ghost', text: '取消选择', onclick: clearPicked })
  );
  if (hasRolling) bar.append(el('span', { class: 'bulk-hint', text: '例行待办只完成这一期' }));
}

async function bulkDo(kind, items) {
  const ids = items.map((t) => t.id);
  if (!ids.length) return;
  try {
    if (kind === 'complete') {
      if (!window.confirm(`把选中的 ${ids.length} 条都标记完成？\n\n例行待办只完成这一期，系列照常排下一期。`)) return;
      const r = await api.post('/api/tasks/bulk-complete', { ids });
      clearPicked();
      await refresh();
      const bad = r.failed && r.failed.length ? `，${r.failed.length} 条没完成` : '';
      toast(`已完成 ${r.completed}/${r.total} 条${bad}`);
      return;
    }
    if (kind === 'tomorrow' || kind === 'sunday') {
      const due = kind === 'tomorrow' ? addDays(todayStr(), 1) : thisSunday();
      const r = await api.post('/api/tasks/bulk-reschedule', { ids, dueOn: due });
      clearPicked();
      await refresh();
      const bad = r.failed && r.failed.length ? `，${r.failed.length} 条没挪成` : '';
      toast(`已挪到 ${due}（${r.updated} 条）${bad}`);
      return;
    }
    if (kind === 'tag') {
      const raw = window.prompt('给选中的待办加标签（多个用空格分隔）：', '');
      if (raw === null) return;
      const tags = raw.split(/[\s,，]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
      if (!tags.length) return;
      const r = await api.post('/api/tasks/bulk-patch', { ids, patch: { tags } });
      clearPicked();
      await refresh();
      toast(`已给 ${r.updated} 条加上 #${tags.join(' #')}`);
      return;
    }
    if (kind === 'category') {
      const cats = state.bootstrap?.categories || [];
      const names = cats.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
      const raw = window.prompt(`移到哪个分类？\n\n${names}`, '1');
      if (raw === null) return;
      const idx = Number(raw) - 1;
      const cat = cats[idx];
      if (!cat) { toast('没有这个分类'); return; }
      const r = await api.post('/api/tasks/bulk-patch', { ids, patch: { categoryId: cat.id } });
      clearPicked();
      await refresh();
      toast(`已把 ${r.updated} 条移到「${cat.name}」`);
      return;
    }
    if (kind === 'delete') {
      if (!window.confirm(`把选中的 ${ids.length} 条移到回收站？\n\n移进去还能还原，不会立刻丢。`)) return;
      const r = await api.post('/api/tasks/bulk-delete', { ids });
      clearPicked();
      await refresh();
      toast(`已移到回收站（${r.deleted || ids.length} 条）`);
      return;
    }
    if (kind === 'remind') {
      const raw = window.prompt('给选中的待办设提醒时间（例如 2026-11-12T09:00，留空表示清掉提醒）：', '');
      if (raw === null) return;
      const at = raw.trim();
      const r = await api.post('/api/tasks/bulk-remind', { ids, remindAt: at || null });
      clearPicked();
      await refresh();
      toast(at ? `已给 ${r.updated} 条设上提醒 ${at.replace('T', ' ')}` : `已清掉 ${r.updated} 条的提醒`);
    }
  } catch (err) {
    showErr(err);
  }
}

function thisSunday() {
  const d = new Date();
  const delta = (7 - ((d.getDay() + 6) % 7)) % 7;
  return addDays(todayStr(), delta);
}

/* ---------------------------- 打印今日 ----------------------------- */
// 生成一份只给打印用的 DOM（放在 body 下，@media print 时只显示它）
function buildPrintSheet() {
  const today = todayStr();
  const due = state.tasks
    .filter((t) => t.status !== 'done' && t.due_on && t.due_on <= today)
    // 纸上先看最急的：按到期日（逾期在前），同一天再按优先级、时间
    .sort((a, b) => String(a.due_on).localeCompare(String(b.due_on))
      || a.priority - b.priority
      || String(a.due_time || '99:99').localeCompare(String(b.due_time || '99:99')));
  const est = due.reduce((n, t) => n + (Number(t.estimate_min) || 0), 0);
  const d = parseDate(today);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const items = due.length
    ? due.map((t) => {
        const late = t.due_on < today ? `逾期 ${-daysLeft(t.due_on)} 天` : '今天';
        const meta = [t.category_name || '未分类', PRIO_SHORT[t.priority] || '', late, t.due_time || '', t.estimate_min ? `${t.estimate_min} 分钟` : '']
          .filter(Boolean).join(' · ');
        return el('div', { class: 'ps-item' },
          el('span', { class: 'ps-box' }),
          el('div', { class: 'ps-main' },
            el('div', { class: 'ps-t', text: t.title }),
            el('div', { class: 'ps-m', text: meta })
          )
        );
      })
    : [el('div', { class: 'ps-empty', text: '今天没有到期的事。' })];
  return el('div', { class: 'print-sheet', id: 'printSheet' },
    el('div', { class: 'ps-head' },
      el('div', { class: 'ps-title', text: '今日清单' }),
      el('div', { class: 'ps-date', text: `${today} ${wd}` })
    ),
    ...items,
    el('div', { class: 'ps-foot', text: `共 ${due.length} 件${est ? ` · 预计 ${minuteText(est)}` : ''} · 由待办工作台打印` })
  );
}

function printToday() {
  const old = $('#printSheet');
  if (old) old.remove();
  document.body.append(buildPrintSheet());
  document.body.classList.add('printing');  const done = () => {
    document.body.classList.remove('printing');
    const s = $('#printSheet');
    if (s) s.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  // 有的浏览器不触发 afterprint，兜底清掉
  setTimeout(done, 4000);
}

// 给自动化测试（ui-smoke / e2e / 截图）留一个最小入口，免得测试去猜内部状态
window.__wb = { buildPrintSheet, printToday, picked: () => [...state.picked] };

function renderDone() {
  const list = $('#list');
  list.innerHTML = '';
  const items = state.done;
  if (!items.length) {
    showEmpty('还没有完成记录', '完成一条待办后，会在这里按月份自动归档。');
    return;
  }
  const byMonth = new Map();
  for (const t of items) {
    const m = (t.completed_at || '').slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(t);
  }
  for (const [m, arr] of [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const [y, mo] = m.split('-');
    list.append(groupHead(`${y} 年 ${Number(mo)} 月`, arr.length, '', ''));
    list.append(rowCard(arr));
  }
}

function mdLabel(date) {
  const d = parseDate(date);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAY[d.getDay()]}`;
}

function renderDay() {
  const list = $('#list');
  list.innerHTML = '';
  const items = state.tasks;
  if (isDoneDay()) {
    if (!items.length) {
      showEmpty(`${mdLabel(state.day)}没有完成记录`, '这一天处理完待办后，会在这里留一笔，点开还能看到当时的完成说明。');
      return;
    }
    list.append(rowCard(items));
    return;
  }
  if (!items.length) {
    showEmpty(`${mdLabel(state.day)}没有安排`, '在下面的输入框写一条，会自动落在这一天。');
    return;
  }
  list.append(rowCard(items));
}

/**
 * 归档搜索：归档本来就是普通 Markdown，所以直接 grep 文件，不需要额外索引。
 * 输入停 300ms 再查，避免每敲一个字都扫一遍目录。
 */
function archiveSearchBar() {
  const wrap = el('div', { class: 'arc-search' });
  const input = el('input', {
    id: 'arcSearch', type: 'search', placeholder: '在归档的 Markdown 里搜一句话…',
    value: state.arcQ || '',
  });
  const result = el('div', { class: 'arc-result' });
  const run = debounce(async (q) => {
    state.arcQ = q;
    result.innerHTML = '';
    if (!q.trim()) return;
    try {
      const r = await api.get('/api/archive/search?q=' + encodeURIComponent(q) + '&limit=40');
      if (!r.items.length) {
        result.append(el('div', { class: 'arc-none', text: `没有找到「${q}」` }));
        return;
      }
      result.append(el('div', { class: 'arc-count', text: `找到 ${r.total} 篇${r.truncated ? '（只显示前 40）' : ''}` }));
      for (const it of r.items) {
        result.append(el('button', {
          class: 'arc-hit',
          onclick: () => openArchiveFile(it.rel),
        },
          el('span', { class: 'arc-hit-t', text: it.title }),
          el('span', { class: 'arc-hit-m', text: [it.date, it.kind === 'index' ? '月度索引' : ''].filter(Boolean).join(' · ') }),
          it.snippet ? el('span', { class: 'arc-hit-s', text: it.snippet }) : null
        ));
      }
    } catch (err) {
      result.append(el('div', { class: 'arc-none', text: `搜索失败：${err.message}` }));
    }
  }, 300);
  input.addEventListener('input', () => run(input.value));
  if (state.arcQ) run(state.arcQ);
  wrap.append(el('span', { class: 'arc-tag', text: '归档搜索' }), input);
  wrap.append(result);
  return wrap;
}

async function openArchiveFile(rel) {
  try {
    await api.post('/api/archive/open', { rel });
    toast('已在文件夹里定位到这篇归档');
  } catch (err) {
    toast(`打不开：${err.message}`);
  }
}

async function renderArchive() {
  const list = $('#list');
  list.innerHTML = '';
  list.append(archiveSearchBar());
  if (!state.archiveTree) await loadArchive();
  const tree = state.archiveTree;
  if (!tree || !tree.years?.length) {
    showEmpty('归档目录还是空的', '完成待办时会自动生成 Markdown 文件，按「年 / 月 / 日」放好。');
    return;
  }
  const wrap = el('div', { class: 'tree' });
  const thisYear = todayStr().slice(0, 4);
  const thisMonth = todayStr().slice(0, 7);

  async function loadMonth(monthBox, ym) {
    if (monthBox.dataset.loaded) return;
    monthBox.dataset.loaded = '1';
    try {
      const r = await api.get('/api/archive/month?ym=' + encodeURIComponent(ym));
      const box = el('div', { class: 't-list' });
      if (!r.tasks?.length) box.append(el('div', { class: 't-none', text: '这个月还没有归档' }));
      for (const t of r.tasks || []) {
        box.append(el('button', { class: 't-item', onclick: () => selectTask(t.id) },
          el('span', { class: 'd-date', text: (t.completed_at || '').slice(8, 10) + ' 日' }),
          el('span', { class: 'd-title', text: t.title }),
          el('span', { class: 'd-cat', text: t.category_name || '' })
        ));
      }
      monthBox.append(box);
    } catch (err) {
      monthBox.dataset.loaded = ''; // 失败允许再试
      showErr(err);
    }
  }

  for (const y of tree.years) {
    const yearBox = el('details', { class: 'tree-year', open: y.year === thisYear },
      el('summary', {},
        el('strong', { text: `${y.year} 年` }),
        el('span', { class: 't-total', text: `${y.total} 项` })
      )
    );
    const months = el('div', { class: 'tree-months' });
    for (const m of y.months) {
      const isCurrent = m.ym === thisMonth;
      const monthBox = el('details', { class: 'tree-month', open: isCurrent },
        el('summary', {}, el('span', { text: `${Number(m.ym.slice(5))} 月` }), el('span', { class: 't-n', text: `${m.count} 项` }))
      );
      monthBox.addEventListener('toggle', () => {
        if (monthBox.open) loadMonth(monthBox, m.ym);
      });
      if (isCurrent) loadMonth(monthBox, m.ym); // 默认展开的月份要主动加载，否则看着像空的
      months.append(monthBox);
    }
    yearBox.append(months);
    wrap.append(yearBox);
  }
  list.append(wrap);
  // 有内容时只留一行小字，不再占一大块「空状态」面板
  list.append(el('div', { class: 'tree-foot' },
    el('span', { text: '归档文件就是普通 Markdown，在 archive 目录里。' }),
    el('button', { class: 'mini-btn', text: '打开归档文件夹', onclick: () => api.post('/api/open-directory', { target: 'archive' }).catch(showErr) })
  ));
}

function renderStats() {
  const list = $('#list');
  list.innerHTML = '';
  const s = state.stats;
  if (!s) { showEmpty('正在统计…', ''); return; }
  const grid = el('div', { class: 'stats-grid' },
    statCard('待办中', s.openCount ?? 0),
    statCard('已逾期', s.overdue ?? 0, 'danger'),
    statCard('今天到期', s.dueToday ?? 0, 'warn'),
    statCard('本月完成', s.doneThisMonth ?? 0, 'success'),
    statCard('累计完成', s.doneTotal ?? 0),
    statCard('昨天完成', s.doneYesterday ?? 0)
  );
  list.append(grid);

  const byCat = el('div', { class: 'panel' }, el('h3', { text: '分类分布（未完成）' }));
  const bars = el('div', { class: 'bars' });
  const maxCat = Math.max(1, ...(s.byCategory || []).map((c) => c.n));
  for (const c of s.byCategory || []) {
    bars.append(el('div', { class: 'bar-row' },
      el('span', { text: c.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
      el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${(c.n / maxCat) * 100}%`, background: c.color || 'var(--accent)' } })),
      el('span', { class: 'v', text: String(c.n) })
    ));
  }
  byCat.append(bars);
  list.append(byCat);

  const trend = el('div', { class: 'panel' }, el('h3', { text: '近 12 个月完成量' }));
  // 补全 12 个月：没有完成的月份也要有一根 0 高度的柱子和月份标签，否则看起来像坏图
  const got = new Map((s.months || []).map((m) => [m.ym, Number(m.done_count ?? m.n ?? 0)]));
  const anchor = parseDate(state.bootstrap?.today || todayStr());
  const months = [];
  for (let back = 11; back >= 0; back--) {
    const dte = new Date(anchor.getFullYear(), anchor.getMonth() - back, 1);
    const ym = `${dte.getFullYear()}-${String(dte.getMonth() + 1).padStart(2, '0')}`;
    months.push({ ym, n: got.get(ym) ?? 0 });
  }
  const maxM = Math.max(1, ...months.map((m) => m.n));
  const chart = el('div', { class: 'trend' });
  for (const m of months) {
    chart.append(el('div', { class: 'col', title: `${m.ym}：${m.n} 项` },
      el('div', { class: 'c-bar', style: { height: `${m.n === 0 ? 0 : Math.max(4, (m.n / maxM) * 100)}%` } }),
      el('span', { class: 'c-label', text: `${Number(m.ym.slice(5))}月` })
    ));
  }
  trend.append(chart);
  list.append(trend);

  const prio = el('div', { class: 'panel' }, el('h3', { text: '优先级分布（未完成）' }));
  const pb = el('div', { class: 'bars' });
  const maxP = Math.max(1, ...(s.byPriority || []).map((p) => p.n));
  for (const p of s.byPriority || []) {
    pb.append(el('div', { class: 'bar-row' },
      el('span', { text: PRIO[p.priority] || `P${p.priority}` }),
      el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${(p.n / maxP) * 100}%`, background: `var(--prio-p${p.priority})` } })),
      el('span', { class: 'v', text: String(p.n) })
    ));
  }
  prio.append(pb);
  list.append(prio);
}

function statCard(label, num, cls = '') {
  return el('div', { class: `stat-card ${cls}` },
    el('div', { class: 's-num', text: String(num) }),
    el('div', { class: 's-label', text: label })
  );
}

function showEmpty(title, sub) {
  const box = $('#empty');
  box.hidden = false;
  box.innerHTML = '';
  box.append(el('strong', { text: title }), sub || '');
}

function renderViewHead() {
  const t = $('#viewTitle');
  const sub = $('#viewSub');
  const tools = $('#viewTools');
  tools.innerHTML = '';
  $('#empty').hidden = true;
  // 唯一的「添加」入口：归档/统计/例行/某天已完成这些不该新建的视图，隐藏它
  const canAdd = !['archive', 'stats', 'series', 'calendar', 'memo', 'trash'].includes(state.view) && !isDoneDay();
  $('#qaAdd').hidden = !canAdd;
  // 速记条是「便签」入口，跟着视图而不是跟着「添加」：除归档/统计/回收站外都留着
  const captureBar = $('#captureForm');
  if (captureBar) captureBar.hidden = ['archive', 'stats', 'trash'].includes(state.view);
  const f = state.focus;
  if (state.view === 'focus') {
    const load = todayLoad();
    t.textContent = '聚焦';
    sub.textContent = f
      ? `今天到期 ${f.today_count ?? 0} 件 · 逾期 ${f.overdue_count ?? 0} 件${load.minutes ? ` · 预计 ${minuteText(load.minutes)}` : ''}`
      : '正在计算…';
  } else if (state.view === 'today') {
    const overdue = state.tasks.filter((x) => daysLeft(x.due_on) < 0).length;
    t.textContent = '今天';
    sub.textContent = `逾期 ${overdue} 件 · 今天到期 ${state.tasks.length - overdue} 件`;
    tools.append(el('button', {
      class: 'btn small', text: '打印清单', title: '把今天要做的打成一页 A4（Ctrl+P 也行）',
      onclick: () => printToday(),
    }));
  } else if (state.view === 'day') {
    t.textContent = mdLabel(state.day);
    const doneMode = isDoneDay();
    const isToday = state.day === todayStr();
    sub.textContent = doneMode
      ? `这一天完成 ${state.tasks.length} 条${isToday ? ' · 就是今天' : ''}`
      : `${state.tasks.length} 条待办${isToday ? ' · 就是今天' : ''}`;
    // 到期 / 已完成 两段开关：同一个日期，两种口径
    tools.append(el('div', { class: 'seg', id: 'dayModeSeg' },
      el('button', { class: !doneMode ? 'active' : '', text: '到期', title: '这天要做什么', onclick: () => setDay(state.day, 'due') }),
      el('button', { class: doneMode ? 'active' : '', text: '已完成', title: '这天做完了什么', onclick: () => setDay(state.day, 'done') })
    ));
    tools.append(
      el('button', { class: 'tool-btn', text: '‹ 前一天', title: '前一天（←）', onclick: () => setDay(addDays(state.day, -1), state.dayMode) }),
      el('button', { class: 'tool-btn', text: '今天', onclick: () => setDay(todayStr(), state.dayMode) }),
      el('button', { class: 'tool-btn', text: '后一天 ›', title: '后一天（→）', onclick: () => setDay(addDays(state.day, 1), state.dayMode) }),
      el('button', { class: 'tool-btn', text: '导出', title: '导出这天的清单', onclick: exportCurrent })
    );
  } else if (state.view === 'all') {
    t.textContent = state.filter.cat ? state.bootstrap.categories.find((c) => c.id === state.filter.cat)?.name || '待办' : '全部待办';
    sub.textContent = state.filter.tag ? `标签 #${state.filter.tag}` : '未完成，按你选的顺序排列';
    tools.append(el('div', { class: 'seg' },
      ...['score', 'due', 'priority', 'created'].map((k) =>
        el('button', { class: state.filter.sort === k ? 'active' : '', onclick: () => { state.filter.sort = k; renderAll(); renderViewHead(); } },
          ({ score: '智能', due: '按到期', priority: '按优先级', created: '按创建' })[k])
      )
    ));
    if (state.filter.cat || state.filter.tag || state.filter.q) {
      tools.append(el('button', { class: 'tool-btn', text: '清除筛选', onclick: () => { state.filter = { q: '', cat: null, tag: null, sort: state.filter.sort }; refresh(); } }));
    }
    tools.append(el('button', { class: 'tool-btn', text: '导出', title: '把当前筛选导出成 Markdown', onclick: exportCurrent }));
  } else if (state.view === 'done') {
    t.textContent = '已完成';
    sub.textContent = `共 ${state.done.length} 条，按完成时间倒序`;
  } else if (state.view === 'archive') {
    t.textContent = '归档';
    sub.textContent = '按年月归档，文件在 archive 文件夹';
    tools.append(el('button', { class: 'tool-btn', text: '打开归档文件夹', onclick: () => api.post('/api/open-directory', { target: 'archive' }).catch(showErr) }));
  } else if (state.view === 'stats') {
    t.textContent = '统计';
    sub.textContent = '完成节奏与分布';
  } else if (state.view === 'calendar') {
    const cv = state.cv;
    const byMonth = cv.mode === 'month';
    const anchor = cv.anchor || todayStr();
    const label = byMonth
      ? `${anchor.slice(0, 4)} 年 ${Number(anchor.slice(5, 7))} 月`
      : `${mdLabel(cv.from)} – ${mdLabel(cv.to)}`;
    t.textContent = '日历';
    sub.textContent = `${label} · 点格子看当天，拖条目改期`;
    tools.append(el('div', { class: 'seg' },
      el('button', { class: byMonth ? 'active' : '', text: '月', title: '整月格子', onclick: () => { state.cv.mode = 'month'; refresh(); } }),
      el('button', { class: byMonth ? '' : 'active', text: '周', title: '一周细看', onclick: () => { state.cv.mode = 'week'; refresh(); } })
    ));
    tools.append(
      el('button', {
        class: 'tool-btn', text: '‹', title: '上一段',
        onclick: () => {
          state.cv.anchor = byMonth ? `${addMonths(String(anchor).slice(0, 7), -1)}-01` : addDays(anchor, -7);
          refresh();
        },
      }),
      el('button', { class: 'tool-btn', text: '今天', onclick: () => { state.cv.anchor = todayStr(); refresh(); } }),
      el('button', {
        class: 'tool-btn', text: '›', title: '下一段',
        onclick: () => {
          state.cv.anchor = byMonth ? `${addMonths(String(anchor).slice(0, 7), 1)}-01` : addDays(anchor, 7);
          refresh();
        },
      })
    );
  } else if (state.view === 'series') {
    const alive = (state.series || []).filter((s) => s.status === 'active').length;
    t.textContent = '例行待办';
    sub.textContent = `共 ${(state.series || []).length} 个例行 · ${alive} 个在跑`;
    tools.append(el('button', {
      class: 'tool-btn', text: '＋ 新建例行', title: '新建一个按月 / 按天 / 按周的例行待办',
      onclick: () => openNewTaskModal({ recurring: true }),
    }));
  } else if (state.view === 'trash') {
    const tasks = state.trash?.tasks?.length || 0;
    const memos = state.trash?.memos?.length || 0;
    t.textContent = '回收站';
    sub.textContent = tasks + memos
      ? `删掉的待办 ${tasks} 条 · 速记 ${memos} 条；这里的东西还能还原`
      : '删掉的待办和速记会先放这里，可以还原或彻底删掉';
  } else if (state.view === 'memo') {
    const n = (state.memos || []).length;
    t.textContent = '速记';
    sub.textContent = n
      ? `${state.memoQ ? `搜索「${state.memoQ}」` : '随手记下来的东西'} · ${n} 条`
      : '随手记一句，回车就存下来；不当待办用也可以';
    if (state.memoQ) {
      tools.append(el('button', {
        class: 'tool-btn', text: '清空搜索',
        onclick: () => { state.memoQ = ''; loadMemos().then(renderAll); },
      }));
    }
  }
}

/* 底部状态条：一眼看到总量与风险，替代原来占着右栏的快捷键提示 */
function renderStatusBar() {
  const bar = $('#statusBar');
  bar.innerHTML = '';
  const counts = state.bootstrap?.counts || {};
  const left = el('span', { class: 'sb-left' });
  left.append(
    el('span', { text: `未完成 ${counts.open ?? 0}` }),
    el('span', { class: 'sb-sep', text: '·' }),
    el('span', { class: counts.overdue ? 'sb-warn' : '', text: `逾期 ${counts.overdue ?? 0}` }),
    el('span', { class: 'sb-sep', text: '·' }),
    el('span', { text: `今天到期 ${counts.today ?? 0}` }),
    el('span', { class: 'sb-sep', text: '·' }),
    el('span', { text: `已完成 ${counts.done ?? 0}` })
  );
  const right = el('span', { class: 'sb-right' },
    el('span', {}, el('kbd', { text: 'N' }), ' 新建'),
    el('span', {}, el('kbd', { text: 'C' }), ' 速记'),
    el('span', {}, el('kbd', { text: '[ ]' }), ' 选择'),
    el('span', {}, el('kbd', { text: 'E' }), ' 完成'),
    el('span', {}, el('kbd', { text: 'Ctrl K' }), ' 搜索')
  );
  bar.append(left, right);
}

function seg(items, onPick) {
  return el('div', { class: 'seg' }, ...items.map((i) => el('button', { class: i.active ? 'active' : '', text: i.label, onclick: () => onPick?.(i.id) })));
}

/* ------------------------------ 月历浮层 ------------------------------ */
function monthOf(date) { return String(date).slice(0, 7); }
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
/** 以周一为起点的 6×7 窗口，和 /api/calendar 的区间口径一致 */
function gridRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(localDate(new Date(y, m - 1, 1 - startDow + i)));
  return { cells, start: cells[0], end: cells[41] };
}

async function loadCalendarMonth(ym) {
  const { start, end } = gridRange(ym);
  try {
    const r = await api.get(`/api/calendar?from=${start}&to=${end}`);
    state.cal.days = r.days || {};
    state.cal.doneDays = r.done_days || {};
    state.cal.overdue = Number(r.overdue || 0);
  } catch (err) {
    state.cal.days = {};
    state.cal.doneDays = {};
    state.cal.overdue = 0;
  }
  renderCalendar();
}

function setCalendarOpenAttr() {
  const open = String(state.cal.open);
  $('#btnCalendar').setAttribute('aria-expanded', open);
  $('#todayLabel').setAttribute('aria-expanded', open);
}

function openCalendar() {
  state.cal.open = true;
  state.cal.ym = monthOf(state.view === 'day' && state.day ? state.day : todayStr());
  $('#calendar').hidden = false;
  setCalendarOpenAttr();
  renderCalendar();
  loadCalendarMonth(state.cal.ym);
}

function closeCalendar() {
  if (!state.cal.open) return;
  state.cal.open = false;
  $('#calendar').hidden = true;
  setCalendarOpenAttr();
}

function renderCalendar() {
  if (!state.cal.open) return;
  const box = $('#calendar');
  const ym = state.cal.ym;
  const [y, m] = ym.split('-').map(Number);
  const { cells } = gridRange(ym);
  const today = todayStr();
  box.innerHTML = '';

  box.append(el('div', { class: 'cal-head' },
    el('div', { class: 'cal-title' },
      el('button', { type: 'button', class: 'cal-nav', title: '上个月（PgUp）', text: '‹', onclick: () => { state.cal.ym = addMonths(ym, -1); loadCalendarMonth(state.cal.ym); } }),
      el('span', { class: 'cal-ym', text: `${y} 年 ${m} 月` }),
      el('button', { type: 'button', class: 'cal-nav', title: '下个月（PgDn）', text: '›', onclick: () => { state.cal.ym = addMonths(ym, 1); loadCalendarMonth(state.cal.ym); } })
    ),
    el('button', { type: 'button', class: 'cal-close', title: '关闭（Esc）', text: '✕', onclick: closeCalendar })
  ));

  const grid = el('div', { class: 'cal-grid' });
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) grid.append(el('div', { class: 'cal-wd', text: w }));
  for (const date of cells) {
    const n = state.cal.days[date] || 0;
    const m = state.cal.doneDays[date] || 0;
    const cls = ['cal-day'];
    if (monthOf(date) !== ym) cls.push('other');
    if (date === today) cls.push('today');
    if (state.view === 'day' && state.day === date) cls.push('selected');
    if (n) cls.push('has');
    if (m) cls.push('has-done');
    grid.append(el('button', {
      class: cls.join(' '),
      // title 必须以日期开头（ui-smoke 靠前 10 位取日期）
      title: `${date}${n ? ` · 到期 ${n} 件` : ''}${m ? ` · 完成 ${m} 件` : ''}`,
      onclick: () => {
        closeCalendar();
        // 这一天有完成记录就看完成；否则未来日期看到期，今天与过去也看完成
        setDay(date, m ? 'done' : (date > todayStr() ? 'due' : 'done'));
      },
    },
      String(parseDate(date).getDate()),
      // 一个圆点表示「这天有安排」；超过一件才补数字，避免格子里堆满 1
      n > 1 ? el('span', { class: 'cal-n', text: String(n) }) : null,
      m ? el('span', { class: 'cal-done', text: String(m) }) : null
    ));
  }

  box.append(grid, el('div', { class: 'cal-foot' },
    el('span', { class: state.cal.overdue ? 'cal-overdue' : '', text: `逾期 ${state.cal.overdue} 件` }),
    el('button', { text: '回到今天', onclick: () => { closeCalendar(); setView('today'); } })
  ));
}

function setDay(date, mode) {
  state.day = date;
  state.view = 'day';
  // 未来日期默认看「到期」（做计划），今天与过去默认看「已完成」（做回顾）
  state.dayMode = mode || (date > todayStr() ? 'due' : 'done');
  state.filter.q = '';
  refresh();
}

/* ------------------------------ 详情面板 ------------------------------ */
async function selectTask(id) {
  state.selectedId = id;
  // 记下「最后点过的那一行」：之后 Shift 点另一行就从这里开始连选
  state.pickAnchor = id;
  $('.body').classList.remove('no-detail');
  $('#detail').classList.add('open');
  try {
    const d = await api.get('/api/tasks/' + encodeURIComponent(id));
    state.detail = { ...d, rev: d.task.rev };
    renderDetail();
    $$('.row').forEach((r) => r.classList.toggle('selected', r.dataset.id === id));
  } catch (err) {
    showErr(err);
  }
}

function closeDetail() {
  state.selectedId = null;
  state.detail = null;
  $('#detail').classList.remove('open');
  $('.body').classList.add('no-detail');
  renderDetail();
  $$('.row').forEach((r) => r.classList.remove('selected'));
}

const saveDetail = debounce(async () => {
  const d = state.detail;
  if (!d) return;
  const patch = d.pending;
  if (!patch || !Object.keys(patch).length) return;
  d.pending = {};
  try {
    const r = await api.patch(`/api/tasks/${d.task.id}`, { rev: d.rev, patch });
    d.task = r.task;
    d.rev = r.task.rev;
    await softRefreshList(r.task);
  } catch (err) {
    if (err.status === 409) {
      toast('这条待办刚被改过，已重新载入');
      await selectTask(d.task.id);
      return;
    }
    showErr(err);
  }
}, 550);

function queuePatch(patch) {
  if (!state.detail) return;
  state.detail.pending = { ...(state.detail.pending || {}), ...patch };
  saveDetail();
}

async function softRefreshList(task) {
  if (!task) return;
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) state.tasks[i] = { ...state.tasks[i], ...task };
  else if (task.status === 'open') state.tasks.unshift(task);
  state.tasks = state.tasks.map((t) => ({ ...t }));
  if (state.view !== 'archive') renderListOnly();
  renderNav();
}

function renderListOnly() {
  if (state.view === 'focus') renderFocus();
  else if (state.view === 'today') renderToday();
  else if (state.view === 'all') renderAll();
}

// 选文件夹/文件后直接建成关联（详情页两个按钮共用）
async function pickLink(taskId, kind, btn) {
  const label = btn && btn.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '选择中…';
  }
  try {
    const r = await api.post(kind === 'file' ? '/api/pick-file' : '/api/pick-folder', {});
    if (r?.path) {
      await api.post(`/api/tasks/${taskId}/links`, { path: r.path, kind, isPrimary: false });
      toast(kind === 'file' ? '已关联文件' : '已关联文件夹');
      await selectTask(taskId);
      refresh();
    }
  } catch (err) {
    showErr(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

function renderDetail() {
  const root = $('#detail');
  root.innerHTML = '';
  const d = state.detail;
  // 没选中时右栏整个收起（body.no-detail），这里不必再画占位提示
  if (!d) return;
  const t = d.task;
  const isDone = t.status === 'done';

  // 标题
  const title = el('textarea', { class: 'd-title', rows: 1 });
  title.value = t.title;
  const grow = () => { title.style.height = 'auto'; title.style.height = Math.min(title.scrollHeight, 160) + 'px'; };
  requestAnimationFrame(grow);
  title.addEventListener('input', () => { grow(); queuePatch({ title: title.value }); });
  title.addEventListener('blur', () => { if (!title.value.trim()) { title.value = t.title; toast('标题不能为空'); } });

  root.append(
    el('div', { class: 'd-head' },
      title,
      el('button', { class: 'd-close', title: '关闭', text: '✕', onclick: closeDetail })
    )
  );

  // 完成/重开
  const actions = el('div', { class: 'd-actions' });
  if (isDone) {
    actions.append(el('button', { class: 'btn primary', text: '重新打开', onclick: () => reopenTask(t) }));
    actions.append(el('button', { class: 'btn', text: '打开归档文件夹', onclick: () => api.post('/api/open-directory', { target: 'archive' }).catch(showErr) }));
  } else {
    actions.append(el('button', { class: 'btn success', text: '✓ 完成并归档', onclick: () => completeTask(t) }));
    if (d.links?.length) {
      actions.append(el('button', { class: 'btn', text: '📁 打开关联', onclick: () => openPrimaryLink(t) }));
    }
  }
  actions.append(el('button', { class: 'btn danger', text: '删除', onclick: () => deleteTask(t) }));
  root.append(actions);

  // 归档信息
  if (t.archived_path) {
    root.append(el('div', { class: 'done-hint' },
      '已归档为 Markdown 文件',
      el('div', { class: 'archive-path', text: t.archived_path })
    ));
  }
  if (t.archive_error) {
    root.append(el('div', { class: 'done-hint', style: { background: 'var(--danger-50)', color: 'var(--danger)' } }, `归档写入失败：${t.archive_error}（记录仍在数据库中，可点「重新生成全部归档」重试）`));
  }

  // 分类 / 优先级 / 日期
  const catSelect = el('select', {
    onchange: () => queuePatch({ categoryId: catSelect.value }),
  });
  for (const c of state.bootstrap.categories) {
    catSelect.append(el('option', { value: c.id, text: c.name, selected: c.id === t.category_id }));
  }
  const prio = el('div', { class: 'prio-pills' },
    ...[0, 1, 2, 3].map((p) =>
      el('button', {
        class: t.priority === p ? 'active' : '',
        dataset: { p: String(p) },
        title: PRIO[p],
        text: PRIO_SHORT[p],
        onclick: () => { t.priority = p; queuePatch({ priority: p }); renderDetail(); },
      })
    )
  );
  const dueInput = el('input', { type: 'date', value: t.due_on || '', onchange: () => queuePatch({ dueOn: dueInput.value || null }) });
  const dueTime = el('input', { type: 'time', value: t.due_time || '', onchange: () => queuePatch({ dueTime: dueTime.value || null }) });
  const remindInput = el('input', {
    class: 'd-remind',
    type: 'datetime-local',
    value: t.remind_at || '',
    title: '到点弹系统通知；改了时间会重新计一次',
    onchange: () => queuePatch({ remindAt: remindInput.value || null }),
  });
  const estInput = el('input', { type: 'number', min: '1', step: '5', value: t.estimate_min ?? '', placeholder: '分钟', onchange: () => queuePatch({ estimateMin: estInput.value ? Number(estInput.value) : null }) });
  const actInput = el('input', { type: 'number', min: '1', step: '5', value: t.actual_min ?? '', placeholder: '分钟', onchange: () => queuePatch({ actualMin: actInput.value ? Number(actInput.value) : null }) });
  const pinBtn = el('button', {
    class: `btn small${t.pinned ? ' on' : ' ghost'}`,
    title: t.pinned ? '取消置顶' : '置顶后永远排在列表最前',
    text: t.pinned ? '📌 已置顶' : '📌 置顶',
    onclick: () => { t.pinned = t.pinned ? 0 : 1; queuePatch({ pinned: t.pinned }); renderDetail(); },
  });

  root.append(el('div', { class: 'd-section' },
    el('div', { class: 'd-label', text: '安排' }),
    el('div', { class: 'd-grid' },
      el('label', { class: 'field' }, el('span', { text: '分类' }), catSelect),
      el('div', { class: 'field' }, el('span', { text: '优先级' }), prio),
      el('label', { class: 'field' }, el('span', { text: '截止日期' }), dueInput),
      el('label', { class: 'field' }, el('span', { text: '时间' }), dueTime),
      el('label', { class: 'field wide' }, el('span', { text: '提醒' }), remindInput),
      el('label', { class: 'field' }, el('span', { text: '预估耗时' }), estInput),
      el('label', { class: 'field' }, el('span', { text: '实际耗时' }), actInput)
    ),
    el('div', { class: 'd-row' },
      pinBtn,
      el('span', { class: 'status-seg', role: 'group', 'aria-label': '状态' },
        ...[['open', '待办'], ['doing', '进行中'], ['waiting', '等待他人']].map(([k, label]) =>
          el('button', {
            class: `btn small${(t.status || 'open') === k ? ' on' : ' ghost'}`,
            title: k === 'waiting' ? '在等对方，不算逾期' : `标记为${label}`,
            text: label,
            onclick: async () => {
              try {
                await api.patch(`/api/tasks/${t.id}`, { patch: { status: k } });
                await selectTask(t.id);
                await refresh();
              } catch (err) { showErr(err); }
            },
          })
        )
      )
    )
  ));

  // 子待办：只允许一层，只在父任务详情里维护；子项不单独归档，跟着父任务的 md checklist 走
  if (!t.parent_id) {
    const kids = d.children || [];
    const kidsDone = kids.filter((k) => k.status === 'done').length;
    const afterKidChange = async () => {
      await selectTask(t.id);
      await refresh();
    };
    const kidList = el('div', { class: 'kids' });
    for (const k of kids) {
      const kidDone = k.status === 'done';
      kidList.append(el('div', { class: `kid${kidDone ? ' done' : ''}` },
        el('button', {
          class: 'tick', title: kidDone ? '重新打开' : '完成', text: '✓',
          onclick: async () => {
            try {
              await api.post(kidDone ? `/api/tasks/${k.id}/reopen` : `/api/tasks/${k.id}/complete`, {});
              await afterKidChange();
            } catch (err) { showErr(err); }
          },
        }),
        el('span', { class: 'kid-title', text: k.title }),
        el('button', {
          class: 'kid-del', title: '删除子待办', text: '✕',
          onclick: async () => {
            try { await api.del(`/api/tasks/${k.id}`); await afterKidChange(); } catch (err) { showErr(err); }
          },
        })
      ));
    }
    const kidInput = el('input', { class: 'kid-input', placeholder: '＋ 回车添加子待办' });
    kidInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !kidInput.value.trim()) return;
      e.preventDefault();
      const title = kidInput.value.trim();
      kidInput.value = '';
      try {
        await api.post('/api/tasks', {
          title, parentId: t.id, categoryId: t.category_id, priority: t.priority,
        });
        await afterKidChange();
      } catch (err) { showErr(err); }
    });
    root.append(el('div', { class: 'd-section' },
      el('div', { class: 'd-label' }, kids.length ? `子待办（${kidsDone}/${kids.length}）` : '子待办'),
      kidList,
      kidInput
    ));
  }

  // 完成说明（已完成才有）
  if (isDone) {
    const note = el('input', { type: 'text', placeholder: '写了一两句完成说明？', value: t.done_note || '', onchange: () => queuePatch({ doneNote: note.value }) });
    root.append(el('div', { class: 'd-section' }, el('div', { class: 'd-label', text: '完成说明' }), el('label', { class: 'field' }, note)));
  }

  // 重复：让某一期能回溯到整个系列
  if (t.series_id) {
    const s = (state.series || []).find((x) => x.id === t.series_id);
    const label = s?.rule_label || `每月 ${s?.day_of_month ?? ''} 号`.trim();
    root.append(el('div', { class: 'd-section' },
      el('div', { class: 'd-label', text: '例行待办' }),
      el('button', {
        class: 'd-link', title: '打开例行列表',
        onclick: () => setView('series'),
      }, el('span', { class: 'series-icon', text: '↻' }),
        el('span', { text: s ? `${s.title} · ${label}` : '属于一个例行待办' }),
        el('span', { class: 'd-link-arrow', text: '›' }))
    ));
  }

  // 笔记
  const notes = el('textarea', { class: 'notes', placeholder: '背景、结论、待确认事项…（支持 Markdown，会写进归档文件）' });
  notes.value = t.notes_md || '';
  notes.addEventListener('input', () => queuePatch({ notesMd: notes.value }));
  root.append(el('div', { class: 'd-section' }, el('div', { class: 'd-label', text: '笔记' }), notes));

  // 标签
  const chips = el('div', { class: 'chips' });
  const tags = String(t.tag_names || '').split(',').filter(Boolean);
  let tagList = [...tags];
  const rerenderChips = () => {
    chips.innerHTML = '';
    tagList.forEach((name) => {
      chips.append(el('span', { class: 'chip' }, '#' + name,
        el('button', { text: '✕', title: '移除', onclick: () => { tagList = tagList.filter((x) => x !== name); queuePatch({ tags: tagList }); rerenderChips(); } })));
    });
    const input = el('input', { class: 'chip-input', placeholder: '＋ 回车加标签' });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        tagList = [...new Set([...tagList, input.value.trim().replace(/^#/, '')])];
        queuePatch({ tags: tagList });
        rerenderChips();
        chips.querySelector('.chip-input')?.focus();
      }
    });
    chips.append(input);
  };
  rerenderChips();
  root.append(el('div', { class: 'd-section' }, el('div', { class: 'd-label', text: '标签' }), chips));

  // 关联文件夹
  const linkBox = el('div', { class: 'links' });
  for (const link of d.links || []) {
    const b = el('div', { class: 'link-row' },
      el('span', { class: 'l-icon', text: link.kind === 'file' ? '📄' : '📁' }),
      el('div', { class: 'l-main' },
        el('div', { class: 'l-label', text: link.label || (link.kind === 'file' ? '文件' : '文件夹') }),
        el('div', { class: 'l-path', title: link.path, text: link.path })
      ),
      el('span', { class: `l-state ${link.exists_state}`, text: ({ ok: '正常', missing: '丢失', unknown: '未校验', denied: '无权限' })[link.exists_state] || link.exists_state }),
      el('button', { title: '打开', text: '↗', onclick: () => openLink(link) }),
      el('button', { title: '重新校验', text: '⟳', onclick: () => verifyLink(link) }),
      el('button', { title: '移除关联', text: '✕', onclick: () => removeLink(link) })
    );
    linkBox.append(b);
  }
  const manual = el('input', { placeholder: '粘贴文件夹或文件路径，回车关联' });
  manual.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = manual.value.trim();
    if (!v) return;
    try {
      await api.post(`/api/tasks/${t.id}/links`, { path: v, kind: /[\\/][^\\/]*\.[a-z0-9]{2,5}$/i.test(v) ? 'file' : 'folder', isPrimary: !(d.links || []).length });
      toast('已关联');
      await selectTask(t.id);
      refresh();
    } catch (err) { showErr(err); }
  });
  const pickBtn = el('button', { class: 'btn small', text: '文件夹…', title: '在弹出的窗口里选择文件夹', onclick: async () => {
    await pickLink(t.id, 'folder', pickBtn);
  } });
  const pickFileBtn = el('button', { class: 'btn small', text: '文件…', title: '在弹出的窗口里选择文件', onclick: async () => {
    await pickLink(t.id, 'file', pickFileBtn);
  } });
  root.append(el('div', { class: 'd-section' },
    el('div', { class: 'd-label' }, '关联文件夹 ', el('button', { class: 'mini-btn', title: '刷新', text: '⟳', onclick: async () => { await selectTask(t.id); } })),
    linkBox,
    el('div', { class: 'link-add', style: { marginTop: '6px' } }, manual, pickBtn, pickFileBtn)
  ));

  // 时间线
  if (d.events?.length) {
    const tl = el('div', { class: 'timeline' });
    const NAMES = { created: '创建', updated: '修改', completed: '完成', reopened: '重新打开', archived: '归档', archive_failed: '归档失败', deleted: '删除', restored: '恢复', linked: '关联文件夹', unlinked: '移除关联', opened: '打开文件夹' };
    for (const e of d.events.slice(0, 12)) {
      tl.append(el('div', { class: 'tl-item' },
        el('time', { text: fmtTime(e.at) }),
        el('span', { text: NAMES[e.type] || e.type })
      ));
    }
    root.append(el('div', { class: 'd-section' }, el('div', { class: 'd-label', text: '动态' }), tl));
  }
}

/* ------------------------------ 任务操作 ------------------------------ */
async function completeTask(t) {
  try {
    const r = await api.post(`/api/tasks/${t.id}/complete`, {});
    // 每日/每周周期：这一次完成变成历史行，活行滚到下一期，撤销没有意义（不做「撤销」按钮）
    if (r.repeated?.next) {
      toast(`已完成这一期 · 下一期 ${r.repeated.next}`, { ms: 5200 });
      if (state.detail?.task.id === t.id) await selectTask(t.id);
      afterMutation();
      return;
    }
    const archived = r.task?.archived_path;
    toast(archived ? `已完成，归档到 ${archived.split('/')[0]} 年 ${Number(archived.split('/')[1]?.slice(5))} 月` : '已完成', {
      actionLabel: '撤销',
      onAction: () => api.post(`/api/tasks/${t.id}/reopen`, {}).then(() => { toast('已撤销完成'); afterMutation(); }).catch(showErr),
    });
    if (state.detail?.task.id === t.id) await selectTask(t.id);
    afterMutation();
  } catch (err) { showErr(err); }
}

async function reopenTask(t) {
  try {
    await api.post(`/api/tasks/${t.id}/reopen`, {});
    toast('已重新打开');
    if (state.detail?.task.id === t.id) await selectTask(t.id);
    afterMutation();
  } catch (err) { showErr(err); }
}

async function deleteTask(t) {
  try {
    await api.del(`/api/tasks/${t.id}`);
    if (state.selectedId === t.id) closeDetail();
    toast(`已删除「${t.title.slice(0, 12)}${t.title.length > 12 ? '…' : ''}」`, {
      actionLabel: '撤销',
      onAction: () => api.post(`/api/tasks/${t.id}/restore`, {}).then(() => { toast('已恢复'); afterMutation(); }).catch(showErr),
    });
    afterMutation();
  } catch (err) { showErr(err); }
}

async function openLink(link) {
  try {
    await api.post(`/api/links/${link.id}/open`, {});
  } catch (err) {
    showErr(err);
    if (state.selectedId) await selectTask(state.selectedId);
  }
}

async function openPrimaryLink(t) {
  try {
    await api.post(`/api/tasks/${t.id}/open`, {});
  } catch (err) { showErr(err); }
}

async function verifyLink(link) {
  try {
    const r = await api.post(`/api/links/${link.id}/verify`, {});
    toast(r.link?.exists_state === 'ok' ? '文件夹正常' : '路径已不可用，可能被移动或删除');
    if (state.selectedId) await selectTask(state.selectedId);
  } catch (err) { showErr(err); }
}

async function removeLink(link) {
  try {
    await api.del(`/api/links/${link.id}`);
    toast('已移除关联');
    if (state.selectedId) await selectTask(state.selectedId);
  } catch (err) { showErr(err); }
}

function afterMutation() {
  if (state.view === 'focus' || state.view === 'all' || state.view === 'today') refresh();
  else if (state.view === 'done') refresh();
  else refresh();
}

/* ------------------------------ 快速添加 ------------------------------ */
function parseQuick(raw) {
  let text = String(raw || '').trim();
  const out = { tags: [], priority: 2, dueOn: null, categoryId: null };
  const take = (re, apply) => {
    text = text.replace(re, (m, pre, val) => { apply(val); return pre; });
  };
  take(/(^|\s)!p([0-3])(?=\s|$)/gi, (p) => { out.priority = Number(p); });
  const TODAY = todayStr();
  const dates = {
    今天: TODAY, 今日: TODAY, 明天: addDays(TODAY, 1), 明日: addDays(TODAY, 1),
    后天: addDays(TODAY, 2), 大后天: addDays(TODAY, 3), 昨天: addDays(TODAY, -1),
  };
  take(/(^|\s)@([^\s]+)/g, (d) => {
    if (dates[d]) { out.dueOn = dates[d]; return; }
    let m;
    if ((m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) out.dueOn = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    else if ((m = d.match(/^(\d{1,2})[-/.](\d{1,2})$/))) out.dueOn = `${TODAY.slice(0, 4)}-${pad2(m[1])}-${pad2(m[2])}`;
    else if ((m = d.match(/^(\d{1,2})月(\d{1,2})日?$/))) out.dueOn = `${TODAY.slice(0, 4)}-${pad2(m[1])}-${pad2(m[2])}`;
    else if ((m = d.match(/^周([一二三四五六日天])$/))) out.dueOn = nextWeekday(m[1]);
    else if ((m = d.match(/^下周([一二三四五六日天])$/))) out.dueOn = addDays(nextWeekday(m[1]), 7);
    else if ((m = d.match(/^(\d+)天后$/))) out.dueOn = addDays(TODAY, Number(m[1]));
    else if (d === '下周') out.dueOn = addDays(TODAY, 7);
  });
  take(/(^|\s)#([^\s]+)/g, (name) => { out.tags.push(name); });
  text = text.replace(/\s+/g, ' ').trim();
  // #分类名 也可能是分类：能对上分类名就归到分类，不再当标签
  const cats = state.bootstrap?.categories || [];
  out.tags = out.tags.filter((name) => {
    const hit = cats.find((c) => c.name === name);
    if (hit) { out.categoryId = hit.id; return false; }
    return true;
  });
  out.title = text;
  return out;
}

function nextWeekday(ch) {
  const idx = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[ch];
  const today = parseDate(todayStr());
  let diff = (idx - today.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(todayStr(), diff);
}

const WD_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 小组件里写全称，比「一/二/三」更像日历
const WEEK_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

/** 'YYYY-MM-DD' → 0=周一 … 6=周日（和服务端的 recur.weekdayOf 同一口径） */
function weekdayOf(dateStr) {
  return (parseDate(dateStr).getDay() + 6) % 7;
}

/**
 * 把「1. 报价 2. 对账 3. 发合同」这类序号列表拆成多条待办（借 x-hub 的口径）。
 * 规则：至少两个序号才拆；序号后不能紧跟数字，免得把 3.14 / 2.0 拆开；
 * 第一条序号前的文字若是「明天要做：」这种标题就丢掉，否则保留成一条。
 */
function splitNumberedList(raw) {
  const text = String(raw || '');
  const re = /(?:^|[\s;；,，、])(\d{1,3})\s*[.．、)]\s*(?!\d)/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ start: m.index, end: m.index + m[0].length });
  if (marks.length < 2) return null;
  const out = [];
  const prelude = text.slice(0, marks[0].start).replace(/[\s;；,，、]+$/, '').trim();
  if (prelude && !/[：:]$/.test(prelude)) out.push(prelude);
  for (let i = 0; i < marks.length; i += 1) {
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(marks[i].end, to).replace(/[\s;；,，、]+$/, '').trim();
    if (body) out.push(body);
  }
  return out.length >= 2 ? out : null;
}

/* ------------------------------ 新建待办（完整表单） ------------------------------ */
// 弹窗内的本地状态；弹窗关闭后不保留
function defaultCategoryId() {
  return state.filter.cat || 'cat-inbox';
}

/** 某月按「几号」落到真实日期；31 号在 2 月自动变 28/29，4 月变 30 */
function occDate(ym, day) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${pad2(Math.min(day, last))}`;
}

/** 从一个号推下一次的日期：这个月还没过就是这月，过了就是下月 */
function nextOccurrence(day) {
  const today = todayStr();
  const thisMonth = today.slice(0, 7);
  const candidate = occDate(thisMonth, day);
  if (candidate >= today) return candidate;
  return occDate(addMonths(thisMonth, 1), day);
}

function openNewTaskModal(opts = {}) {
  if (state.overlay) return; // 同时只允许一个弹窗
  const pre = opts.prefill ? parseQuick(opts.prefill) : null;
  const model = {
    categoryId: pre?.categoryId || defaultCategoryId(),
    priority: pre?.priority ?? 2,
    dueOn: pre?.dueOn || (isDueDay() ? state.day : null),
    dueTime: '',
    tags: Array.isArray(pre?.tags) ? pre.tags.slice() : [],
  };
  // 从速记转过来时，正文剩下的行直接填进备注
  const presetNotes = String(opts.notes || '').trim();
  // 重复：默认每月今天这个号，跑未来 36 期（3 年）；也可以改成每 N 天 / 每 N 周
  const recur = {
    on: Boolean(opts.recurring),
    rule: 'monthly',
    day: state.bootstrap?.today ? Number(state.bootstrap.today.slice(8, 10)) : new Date().getDate(),
    interval: 1,
    weekday: weekdayOf(todayStr()),
    horizon: 36,
  };
  if (recur.on) model.dueOn = nextOccurrence(recur.day);
  const cal = { open: false, ym: null, days: {}, seq: 0 };

  const root = $('#modalRoot');
  const mask = el('div', { class: 'modal-mask tm-mask' });
  const form = el('form', { class: 'tm-form', id: 'tmForm', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); submit(); } });
  const modal = el('div', {
    class: 'modal task-modal',
    id: 'taskModal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '新建待办',
  }, form);

  /* ---- 标题（最重要的一个输入，给它独立的框 + 标签） ---- */
  const title = el('textarea', {
    class: 'tm-title', id: 'tmTitle', rows: '1', maxlength: '200',
    placeholder: '例如：确认 A 座消防年检整改回执并归档', 'aria-label': '要做什么', enterkeyhint: 'done',
  });
  title.value = pre?.title || '';
  const titleErr = el('p', { class: 'tm-err', hidden: true });
  const titleBox = el('div', { class: 'tm-title-box' }, title, titleErr);
  const titleField = el('div', { class: 'tm-title-field' },
    el('label', { class: 'tm-title-label', for: 'tmTitle' }, '要做什么', el('span', { class: 'tm-req', text: '必填' })),
    titleBox
  );

  /* ---- 分类（行内展开的选择抽屉） ---- */
  const catBtn = el('button', { type: 'button', class: 'tm-value', id: 'tmCat', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const catPop = el('div', { class: 'tm-drawer', id: 'tmCatDrawer', hidden: true });
  const catRow = el('div', { class: 'tm-row tm-row-button' },
    el('span', { class: 'tm-label', text: '分类' }),
    catBtn,
    el('span', { class: 'tm-chev', text: '›' })
  );
  catRow.addEventListener('click', (e) => {
    if (e.target === catPop || catPop.contains?.(e.target)) return;
    toggleCatDrawer();
  });

  const drawCatValue = () => {
    const c = (state.bootstrap?.categories || []).find((x) => x.id === model.categoryId);
    catBtn.innerHTML = '';
    catBtn.append(
      el('span', { class: 'cat-dot', style: { '--c': c?.color || 'var(--text-3)' } }),
      el('span', { class: 'tm-value-text', text: c?.name || '收件箱' })
    );
  };
  function toggleCatDrawer() {
    if (cal.open) closeCal();
    catPop.hidden = !catPop.hidden;
    catBtn.setAttribute('aria-expanded', catPop.hidden ? 'false' : 'true');
    if (!catPop.hidden) renderCatDrawer();
  }
  function renderCatDrawer() {
    catPop.innerHTML = '';
    const cats = state.bootstrap?.categories || [];
    for (const c of cats) {
      catPop.append(el('button', {
        type: 'button', class: `tm-opt${c.id === model.categoryId ? ' active' : ''}`,
        onclick: () => { model.categoryId = c.id; drawCatValue(); catPop.hidden = true; catBtn.setAttribute('aria-expanded', 'false'); title.focus(); },
      },
        el('span', { class: 'cat-dot', style: { '--c': c.color || 'var(--text-3)' } }),
        el('span', { text: c.name }),
        c.id === model.categoryId ? el('span', { class: 'tm-check', text: '✓' }) : null
      ));
    }
  }

  /* ---- 优先级 ---- */
  const prio = el('div', { class: 'prio-pills tm-prio', role: 'radiogroup', 'aria-label': '优先级' });
  const drawPrio = () => {
    prio.innerHTML = '';
    [0, 1, 2, 3].forEach((p) => {
      prio.append(el('button', {
        type: 'button', class: model.priority === p ? 'active' : '', dataset: { p: String(p) },
        title: PRIO[p], text: PRIO_SHORT[p], 'aria-pressed': model.priority === p ? 'true' : 'false',
        onclick: () => { model.priority = p; drawPrio(); },
      }));
    });
  };
  drawPrio();

  /* ---- 截止日期（行内月历） ---- */
  const dueBtn = el('button', { type: 'button', class: 'tm-value', id: 'tmDue', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  const calBox = el('div', { class: 'tm-cal', id: 'tmCal', hidden: true });
  const dueRow = el('div', { class: 'tm-row tm-row-button' },
    el('span', { class: 'tm-label', text: '截止日期' }),
    dueBtn,
    el('span', { class: 'tm-chev', text: '›' })
  );
  dueRow.addEventListener('click', (e) => {
    if (calBox.contains?.(e.target)) return;
    toggleCal();
  });

  const timeInput = el('input', { type: 'time', class: 'tm-input tm-time', id: 'tmTime', step: '300', 'aria-label': '截止时间' });
  timeInput.value = model.dueTime;
  timeInput.addEventListener('change', () => { model.dueTime = timeInput.value; });

  const drawDueValue = () => {
    const d = dueLabel(model.dueOn);
    dueBtn.innerHTML = '';
    // 「今天 / 明天 / 3 天后」这类相对说法已经说清了，再叠个 2026-10-28 只是噪音；
    // 真正需要绝对日期时（7 天以后）d.text 本身就是 10-28 周三。
    const rel = ['今天', '明天', '无日期'].includes(d.text) || /天前|天后|逾期/.test(d.text);
    const label = !model.dueOn ? '无日期' : rel ? `${d.text} · ${model.dueOn.slice(5)}` : `${model.dueOn} ${d.text.split(' ')[1] || ''}`.trim();
    dueBtn.append(el('span', { class: `tm-value-text ${model.dueOn ? d.cls : 'muted'}`, text: label }));
    dueBtn.title = model.dueOn || '';
    timeInput.disabled = !model.dueOn;
    if (!model.dueOn) { model.dueTime = ''; timeInput.value = ''; }
  };
  function toggleCal() {
    if (!catPop.hidden) toggleCatDrawer();
    if (calBox.hidden) {
      cal.open = true;
      calBox.hidden = false;
      dueBtn.setAttribute('aria-expanded', 'true');
      cal.ym = monthOf(model.dueOn || todayStr());
      drawCal();      // 先画出格子，计数回来再补点，别让用户看见空白
      loadCal();
    } else closeCal();
  }
  function closeCal() {
    cal.open = false;
    calBox.hidden = true;
    dueBtn.setAttribute('aria-expanded', 'false');
  }
  async function loadCal() {
    const { start, end } = gridRange(cal.ym);
    const seq = ++cal.seq;
    try {
      const r = await api.get(`/api/calendar?from=${start}&to=${end}`);
      if (seq !== cal.seq) return;
      cal.days = r.days || {};
    } catch { cal.days = {}; }
    drawCal();
  }  function drawCal() {
    calBox.innerHTML = '';
    const { start, end, cells } = gridRange(cal.ym);
    const [y, m] = cal.ym.split('-').map(Number);
    const head = el('div', { class: 'tm-cal-head' },
      el('div', { class: 'cal-title' },
        el('button', { type: 'button', class: 'cal-nav', text: '‹', title: '上个月', onclick: () => { cal.ym = addMonths(cal.ym, -1); loadCal(); } }),
        el('span', { class: 'tm-cal-ym', text: `${y} 年 ${m} 月` }),
        el('button', { type: 'button', class: 'cal-nav', text: '›', title: '下个月', onclick: () => { cal.ym = addMonths(cal.ym, 1); loadCal(); } })
      )
    );
    const grid = el('div', { class: 'cal-grid tm-cal-grid' });
    for (const w of ['一', '二', '三', '四', '五', '六', '日']) grid.append(el('div', { class: 'cal-wd', text: w }));
    for (const date of cells) {
      const n = cal.days[date] || 0;
      const classes = ['cal-day'];
      if (monthOf(date) !== cal.ym) classes.push('other');
      if (date === todayStr()) classes.push('today');
      if (date === model.dueOn) classes.push('selected');
      if (n) classes.push('has');
      grid.append(el('button', {
        type: 'button', class: classes.join(' '), title: `${date}${n ? ` · 已排 ${n} 件` : ''}`,
        dataset: { d: date }, text: String(parseDate(date).getDate()), 'aria-label': `${date}${n ? `，已排 ${n} 件` : ''}`,
        onclick: () => { model.dueOn = date; drawDueValue(); closeCal(); title.focus(); },
      }));
    }
    const foot = el('div', { class: 'tm-cal-foot' },
      el('button', { type: 'button', text: '今天', onclick: () => { model.dueOn = todayStr(); drawDueValue(); closeCal(); } }),
      el('button', { type: 'button', text: '明天', onclick: () => { model.dueOn = addDays(todayStr(), 1); drawDueValue(); closeCal(); } }),
      el('button', { type: 'button', text: '清除', onclick: () => { model.dueOn = null; drawDueValue(); closeCal(); } })
    );
    calBox.append(head, grid, foot);
    void start; void end;
  }

  /* ---- 重复 ---- */
  const recurInput = el('input', { type: 'checkbox', class: 'tm-box', id: 'tmRecur', 'aria-label': '重复' });
  recurInput.checked = recur.on;
  const ruleSel = el('select', { class: 'tm-input', id: 'tmRule', 'aria-label': '重复规则' },
    el('option', { value: 'monthly', text: '每月某日' }),
    el('option', { value: 'daily', text: '每 N 天' }),
    el('option', { value: 'weekly', text: '每 N 周' })
  );
  ruleSel.value = recur.rule;
  ruleSel.addEventListener('change', () => { recur.rule = ruleSel.value; drawRecur(); });
  const recurDay = el('span', { class: 'tm-recur-day', id: 'tmRecurDay', text: `${recur.day} 号` });
  const dayGrid = el('div', { class: 'tm-daygrid', id: 'tmDayGrid' });
  const recurHint = el('p', { class: 'tm-sub', id: 'tmRecurHint', text: '' });
  const horizonSel = el('select', { class: 'tm-input', id: 'tmHorizon', 'aria-label': '例行范围' },
    [12, 24, 36, 48, 60].map((n) => el('option', { value: String(n), text: `未来 ${n} 期` }))
  );
  horizonSel.value = String(recur.horizon);
  horizonSel.addEventListener('change', () => { recur.horizon = Number(horizonSel.value); drawRecur(); });

  const mkInterval = (id) => {
    const inp = el('input', { type: 'number', class: 'tm-input tm-num', id, min: '1', max: '60', step: '1', 'aria-label': '间隔' });
    inp.value = String(recur.interval);
    inp.addEventListener('input', () => {
      const n = Number(inp.value);
      if (!Number.isInteger(n) || n < 1 || n > 60) return;
      recur.interval = n;
      // 两个输入框共用同一个状态，改一个另一个跟着动
      const other = id === 'tmIntervalDaily' ? intervalWeekly : intervalDaily;
      if (other && other.value !== String(n)) other.value = String(n);
      refreshHint();
    });
    return inp;
  };
  let intervalDaily = null;
  let intervalWeekly = null;
  intervalDaily = mkInterval('tmIntervalDaily');
  intervalWeekly = mkInterval('tmIntervalWeekly');
  const weekdaySel = el('select', { class: 'tm-input', id: 'tmWeekday', 'aria-label': '星期几' },
    WD_NAMES.map((n, i) => el('option', { value: String(i), text: n }))
  );
  weekdaySel.value = String(recur.weekday);
  weekdaySel.addEventListener('change', () => { recur.weekday = Number(weekdaySel.value); refreshHint(); });

  const monthlyRow = el('div', { class: 'tm-row', id: 'tmMonthlyRow' },
    el('span', { class: 'tm-label', text: '每月' }),
    recurDay
  );
  const horizonRow = el('div', { class: 'tm-row', id: 'tmHorizonRow' },
    el('span', { class: 'tm-label', text: '范围' }),
    horizonSel,
    el('span', { class: 'tm-unit', text: '期' })
  );
  const dailyRow = el('div', { class: 'tm-row', id: 'tmDailyRow' },
    el('span', { class: 'tm-label', text: '每隔' }),
    el('span', { class: 'tm-suffix' }, intervalDaily, el('span', { class: 'tm-unit', text: '天' }))
  );
  const weeklyRow = el('div', { class: 'tm-row', id: 'tmWeeklyRow' },
    el('span', { class: 'tm-label', text: '每隔' }),
    el('span', { class: 'tm-suffix' }, intervalWeekly, el('span', { class: 'tm-unit', text: '周' })),
    weekdaySel
  );

  const recurPanel = el('div', { class: 'tm-recur', id: 'tmRecurPanel' },
    el('div', { class: 'tm-row' },
      el('span', { class: 'tm-label', text: '规则' }),
      ruleSel
    ),
    monthlyRow,
    dayGrid,
    horizonRow,
    dailyRow,
    weeklyRow,
    recurHint
  );

  function drawDayGrid() {
    dayGrid.innerHTML = '';
    for (let d = 1; d <= 31; d++) {
      dayGrid.append(el('button', {
        type: 'button',
        class: `tm-day${d === recur.day ? ' active' : ''}`,
        text: String(d),
        'aria-pressed': d === recur.day ? 'true' : 'false',
        onclick: () => {
          recur.day = d;
          model.dueOn = nextOccurrence(d);
          drawDueValue();
          drawRecur();
        },
      }));
    }
  }
  function refreshHint() {
    if (!recur.on) { recurHint.textContent = ''; return; }
    if (recur.rule === 'monthly') {
      const first = model.dueOn && model.dueOn >= todayStr() ? model.dueOn : nextOccurrence(recur.day);
      recurHint.textContent = `会从 ${first} 开始，一次铺出未来 ${recur.horizon} 期；之后每次打开工作台自动往后补。可在「例行待办」里取消整个系列。`;
      return;
    }
    const from = model.dueOn && model.dueOn >= todayStr() ? model.dueOn : todayStr();
    const every = recur.rule === 'daily'
      ? `每 ${recur.interval} 天`
      : `每 ${recur.interval} 周的${WD_NAMES[recur.weekday] || '周一'}`;
    recurHint.textContent = `从 ${from} 开始${every}一次。勾掉一次就滚到下一期，中间漏掉的期直接跳过，不会堆出一摞逾期副本。`;
  }
  function drawRecur() {
    recurInput.checked = recur.on;
    recurPanel.hidden = !recur.on;
    ruleSel.value = recur.rule;
    recurDay.textContent = `${recur.day} 号`;
    horizonSel.value = String(recur.horizon);
    const monthly = recur.rule === 'monthly';
    monthlyRow.hidden = !monthly;
    dayGrid.hidden = !monthly;
    horizonRow.hidden = !monthly;
    dailyRow.hidden = recur.rule !== 'daily';
    weeklyRow.hidden = recur.rule !== 'weekly';
    drawDayGrid();
    refreshHint();
  }
  recurInput.addEventListener('change', () => {
    recur.on = recurInput.checked;
    if (recur.on) {
      // 勾上重复就把截止日期自动补上：这个月还没到这个号就用这个月，过了就用下个月
      if (!model.dueOn || model.dueOn < todayStr()) {
        model.dueOn = recur.rule === 'monthly' ? nextOccurrence(recur.day) : todayStr();
      } else if (recur.rule === 'monthly') {
        recur.day = Number(model.dueOn.slice(8, 10));
      }
      drawDueValue();
      if (!catPop.hidden) toggleCatDrawer();
      if (!calBox.hidden) closeCal();
    }
    drawRecur();
  });

  /* ---- 标签 ---- */
  const chips = el('div', { class: 'chips tm-chips' });
  const tagInput = el('input', { class: 'chip-input', placeholder: '＋ 回车加标签', 'aria-label': '标签' });
  const drawChips = () => {
    chips.innerHTML = '';
    for (const name of model.tags) {
      chips.append(el('span', { class: 'chip' }, '#' + name,
        el('button', { type: 'button', text: '✕', title: '移除', onclick: () => { model.tags = model.tags.filter((x) => x !== name); drawChips(); } })));
    }
    chips.append(tagInput);
    tagInput.value = '';
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 中文输入法组字中，回车是确认候选词
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = tagInput.value.trim().replace(/^#/, '');
      if (v) { model.tags = [...new Set([...model.tags, v])]; drawChips(); }
      chips.querySelector('.chip-input')?.focus();
    } else if (e.key === 'Backspace' && !tagInput.value && model.tags.length) {
      model.tags.pop();
      drawChips();
      chips.querySelector('.chip-input')?.focus();
    }
  });

  /* ---- 关联文件夹/文件 ---- */
  const folderInput = el('input', { class: 'tm-input', id: 'tmFolder', placeholder: '绝对路径，如 E:\\合同\\2026', 'aria-label': '关联文件夹或文件' });
  const pickInto = async (kind, btn) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '选择中…';
    try {
      const r = await api.post(kind === 'file' ? '/api/pick-file' : '/api/pick-folder', {});
      if (r?.path) {
        folderInput.value = r.path;
        folderInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (err) { showErr(err); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
  const browseBtn = el('button', {
    type: 'button', class: 'btn small', text: '文件夹…', title: '在弹出的窗口里选择文件夹',
    onclick: () => pickInto('folder', browseBtn),
  });
  const browseFileBtn = el('button', {
    type: 'button', class: 'btn small', text: '文件…', title: '在弹出的窗口里选择文件',
    onclick: () => pickInto('file', browseFileBtn),
  });

  /* ---- 笔记 ---- */
  const notes = el('textarea', { class: 'tm-notes', rows: '3', placeholder: '笔记（可选，Markdown 会写进归档文件）', 'aria-label': '笔记' });
  if (presetNotes) notes.value = presetNotes;

  /* ---- 底部 ---- */
  const okBtn = el('button', { type: 'submit', class: 'btn primary', id: 'tmOk', form: 'tmForm', text: '创建' });
  const cancelBtn = el('button', { type: 'button', class: 'btn', id: 'tmCancel', text: '取消', onclick: () => close() });
  const globalErr = el('p', { class: 'tm-err tm-err-global', hidden: true });

  form.append(
    el('div', { class: 'tm-head' },
      el('h2', { class: 'tm-heading', text: '新建待办', tabindex: '-1' }),
      el('button', { type: 'button', class: 'tm-x', text: '✕', title: '关闭（Esc）', 'aria-label': '关闭', onclick: () => close() })
    ),
    titleField,
    el('div', { class: 'tm-card' },
      catRow, catPop,
      el('div', { class: 'tm-row' }, el('span', { class: 'tm-label', text: '优先级' }), prio),
      dueRow, calBox,
      el('div', { class: 'tm-row tm-row-check' },
        el('label', { class: 'tm-recur-toggle', for: 'tmRecur' }, recurInput, el('span', { text: '重复' })),
        el('span', { class: 'tm-note', text: '到期后自动生成下一次' })
      ),
      recurPanel,
      el('div', { class: 'tm-row' }, el('span', { class: 'tm-label', text: '时间' }), timeInput),
      el('div', { class: 'tm-row' },
        el('span', { class: 'tm-label', text: '预估' }),
        el('span', { class: 'tm-suffix' },
          el('input', { type: 'number', class: 'tm-input tm-num', id: 'tmEst', min: '1', max: '1440', step: '1', placeholder: '—', 'aria-label': '预估耗时（分钟）' }),
          el('span', { class: 'tm-unit', text: '分钟' })
        )
      )
    ),
    el('div', { class: 'tm-card' },
      el('div', { class: 'tm-row tm-row-block' }, el('span', { class: 'tm-label', text: '标签' }), chips)
    ),
    el('div', { class: 'tm-card' },
      el('div', { class: 'tm-row tm-row-block' }, el('span', { class: 'tm-label', text: '关联文件' }),
        el('div', { class: 'tm-folder' }, folderInput, browseBtn, browseFileBtn))
    ),
    el('div', { class: 'tm-card tm-card-notes' }, notes),
    globalErr
  );

  // 操作条放在滚动区之外：日历/例行展开后内容再长，取消/创建也始终可见
  const actions = el('div', { class: 'tm-actions' },
    el('span', { class: 'tm-hint', text: 'Enter 创建 · Shift+Enter 换行 · Esc 取消' }),
    cancelBtn, okBtn
  );
  modal.append(actions);

  mask.append(modal);
  root.append(mask);

  drawCatValue();
  drawDueValue();
  drawChips();
  drawRecur();

  let busy = false;

  const overlay = {
    kind: 'new-task',
    onEsc() {
      if (!catPop.hidden) { toggleCatDrawer(); return; }
      if (!calBox.hidden) { closeCal(); return; }
      close();
    },
    onTab(e) {
      // 焦点困在弹窗内（shim 无浏览器原生 trap）
      const items = $$('input, select, textarea, button', modal).filter((n) => !n.disabled);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey ? items[(i - 1 + items.length) % items.length] : items[(i + 1) % items.length];
      e.preventDefault();
      next?.focus();
    },
  };
  state.overlay = overlay;

  function setErr(msg) {
    globalErr.hidden = !msg;
    globalErr.textContent = msg || '';
  }
  function close() {
    if (state.overlay !== overlay) return;
    state.overlay = null;
    mask.remove();
  }

  function validate(m) {
    if (!m.title) return '先写一句待办内容';
    if (m.title.length > 200) return '标题最多 200 个字';
    if (m.dueTime && !m.dueOn) return '设了时间就要先选日期';
    if (m.recurrence) {
      const r = m.recurrence;
      if (r.rule === 'monthly' && !(Number.isInteger(r.day_of_month) && r.day_of_month >= 1 && r.day_of_month <= 31)) {
        return '每月重复要选 1–31 号中的一天';
      }
      if (r.rule !== 'monthly' && !(Number.isInteger(r.interval_n) && r.interval_n >= 1 && r.interval_n <= 60)) {
        return '间隔要写 1–60';
      }
    }
    if (m.estimateMin != null && (!Number.isInteger(m.estimateMin) || m.estimateMin < 1 || m.estimateMin > 1440)) return '预估耗时写 1–1440 分钟';
    if (m.folder && !/^([a-zA-Z]:[\\/]|\\\\)/.test(m.folder)) return '文件夹要填绝对路径，比如 E:\\合同\\2026';
    return '';
  }

  async function submit() {
    if (busy) return;
    const estRaw = $('#tmEst').value;
    // 例行：首期必须是今天或之后的这一号，不能从过去的日期开始铺
    let dueOn = model.dueOn || null;
    let recurrence = null;
    if (recur.on) {
      if (recur.rule === 'monthly') {
        dueOn = dueOn && dueOn >= todayStr() ? dueOn : nextOccurrence(recur.day);
        model.dueOn = dueOn;
        recurrence = { rule: 'monthly', day_of_month: recur.day, start_month: monthOf(dueOn), horizon_months: recur.horizon };
      } else {
        // 每日/每周：起始日就是这一期的日期，服务端只建一条活行，完成时自己滚
        const start = dueOn && dueOn >= todayStr() ? dueOn : todayStr();
        dueOn = start;
        model.dueOn = start;
        recurrence = recur.rule === 'daily'
          ? { rule: 'daily', start_date: start, interval_n: recur.interval }
          : { rule: 'weekly', start_date: start, interval_n: recur.interval, weekday: recur.weekday };
      }
    }
    const m = {
      title: title.value.trim(),
      categoryId: model.categoryId,
      priority: model.priority,
      dueOn,
      dueTime: dueOn && timeInput.value ? timeInput.value : null,
      estimateMin: estRaw ? Number(estRaw) : null,
      notesMd: notes.value,
      tags: model.tags,
      folder: folderInput.value.trim() || null,
      recurrence,
    };
    const bad = validate(m);
    if (bad) {
      setErr(bad);
      if (!m.title) title.focus();
      return;
    }
    setErr('');
    busy = true;
    okBtn.disabled = true;
    okBtn.textContent = '创建中…';

    // 序号列表拆多条：一次把「1. 报价 2. 对账」建成两条待办
    const parts = recurrence ? null : splitNumberedList(m.title);
    if (parts && parts.length >= 2) {
      const made = [];
      const failed = [];
      for (const part of parts) {
        try {
          const r = await api.post('/api/tasks', { ...m, title: part.slice(0, 200), recurrence: null });
          made.push(r.task.id);
        } catch (err) {
          failed.push(err?.message || '创建失败');
        }
      }
      state.flashTaskId = made[0] || null;
      close();
      if (['done', 'archive', 'stats'].includes(state.view) || isDoneDay()) await setView('focus');
      else await refresh();
      if (made.length) {
        toast(`已拆成 ${made.length} 条待办${failed.length ? `，${failed.length} 条失败：${failed[0]}` : ''}`, {
          actionLabel: '打开第一条',
          onAction: () => selectTask(made[0]),
          ms: 7000,
        });
      } else {
        toast('一条都没建成：' + (failed[0] || '未知错误'));
      }
      setTimeout(() => {
        state.flashTaskId = null;
        $$('.row.flash').forEach((n) => n.classList.remove('flash'));
      }, 1800);
      return;
    }
    try {
      const r = await api.post('/api/tasks', m);
      const id = r.task.id;
      const needSwitch = ['done', 'archive', 'stats'].includes(state.view) || isDoneDay();
      state.flashTaskId = id;
      close();
      if (r.series) {
        await loadSeries();
        if (needSwitch) await setView('focus');
        else await refresh();
        const label = r.series.rule_label || `每月 ${r.series.day_of_month} 号`;
        toast(r.series.rule === 'monthly'
          ? `已建例行：${label}，铺了 ${r.seriesOccurrences} 期`
          : `已建例行：${label}，从 ${r.task?.due_on || todayStr()} 开始滚动`, {
          actionLabel: '查看',
          onAction: () => setView('series'),
          ms: 7000,
        });
        return;
      }
      if (needSwitch) await setView('focus');
      else await refresh();
      const row = $$('.row').find((n) => String(n.dataset.id) === String(id));
      row?.scrollIntoView?.({ block: 'center' });
      const warn = r.linkError ? `（文件夹没关联上：${r.linkError}）` : '';
      toast(`已创建：${m.title}${warn}`, { actionLabel: '打开', onAction: () => selectTask(id) });
      if (!row) toast('已创建，但当前视图的筛选条件看不到它');
      setTimeout(() => {
        state.flashTaskId = null;
        $$('.row.flash').forEach((n) => n.classList.remove('flash'));
      }, 1800);
    } catch (err) {
      setErr(err?.message || '创建失败');
      okBtn.disabled = false;
      okBtn.textContent = '创建';
      busy = false;
    }
  }

  // 标题里回车即创建（Shift+Enter 换行），输入法组字时不提交
  title.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  title.focus();
  return overlay;
}

/* ------------------------------ 联系作者 ------------------------------ */
function openQrModal(spec) {
  if ($('#' + spec.id)) return;
  openModal((modal, close) => {
    modal.className = `modal qr-modal ${spec.className || 'contact-modal'}`;
    modal.setAttribute('id', spec.id);
    const img = el('img', {
      class: 'qr-img', src: spec.src, alt: spec.alt,
      width: String(spec.width || 300), height: String(spec.height || 300), draggable: 'false',
    });
    if (spec.imgClass) img.className = `qr-img ${spec.imgClass}`;
    modal.append(
      el('div', { class: 'tm-head' },
        el('h2', { class: 'tm-heading', text: spec.title }),
        el('button', { type: 'button', class: 'tm-x', text: '✕', title: '关闭（Esc）', 'aria-label': '关闭', onclick: () => close() })
      ),
      el('div', { class: 'qr-wrap' }, img),
      ...spec.tips.map((t) => el('p', { class: 'qr-tip', text: t })),
      el('div', { class: 'qr-foot' }, el('button', { type: 'button', class: 'btn primary', text: '知道了', onclick: () => close() }))
    );
  });
}

function openContactModal() {
  openQrModal({
    id: 'contactModal',
    className: 'modal contact-modal',
    title: '联系作者',
    src: '/assets/contact-qr.png',
    alt: '作者微信二维码',
    tips: ['微信扫码加我，反馈问题、提需求都可以。'],
  });
}

function openRewardModal() {
  openQrModal({
    id: 'rewardModal',
    className: 'modal contact-modal',
    title: '激励作者',
    src: '/assets/reward-qr.png',
    alt: '支付宝收款二维码',
    tips: ['您的支持，是我继续开发的动力！', '完全自愿，不影响任何功能。'],
  });
}

/* ------------------------------ 分类 / 设置 ------------------------------ */
const COLORS = ['#2563EB', '#7C3AED', '#0E9F6E', '#D97706', '#DB2777', '#0891B2', '#6B7280', '#C81E1E'];

function openCategoryModal(cat) {
  let color = cat?.color || COLORS[0];
  openModal((modal, close) => {
    const nameInput = el('input', { value: cat?.name || '', placeholder: '比如：物业运营、合同与法务' });
    const sw = el('div', { class: 'swatches' });
    const paint = () => {
      sw.innerHTML = '';
      for (const c of COLORS) {
        sw.append(el('button', { class: c === color ? 'active' : '', style: { background: c }, onclick: () => { color = c; paint(); } }));
      }
    };
    paint();
    modal.append(
      el('h2', { text: cat ? '编辑分类' : '新建分类' }),
      el('div', { class: 'm-field' }, el('label', { text: '名称' }), nameInput),
      el('div', { class: 'm-field' }, el('label', { text: '颜色' }), sw),
      cat ? el('div', { class: 'm-field' }, el('button', {
        class: 'btn danger small', text: '删除这个分类',
        onclick: async () => {
          try {
            await api.del('/api/categories/' + cat.id);
            close(); toast('分类已删除，任务已迁回收件箱'); refresh();
          } catch (err) { showErr(err); }
        },
      })) : null,
      el('div', { class: 'm-actions' },
        el('button', { class: 'btn', text: '取消', onclick: close }),
        el('button', {
          class: 'btn primary', text: cat ? '保存' : '创建',
          onclick: async () => {
            const name = nameInput.value.trim();
            if (!name) { toast('分类名不能为空'); return; }
            try {
              if (cat) await api.patch('/api/categories/' + cat.id, { name, color });
              else await api.post('/api/categories', { name, color });
              close(); toast(cat ? '已保存' : '分类已创建'); refresh();
            } catch (err) { showErr(err); }
          },
        })
      )
    );
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') modal.querySelector('.btn.primary').click(); });
  });
}

async function openMaintenance() {
  let info;
  try {
    info = await api.get('/api/maintenance');
  } catch (err) {
    toast(`体检失败：${err.message}`);
    return;
  }
  openModal((modal, close) => {
    modal.classList.add('wide');
    const row = (label, value, hint) => el('div', { class: 'mnt-row' },
      el('span', { class: 'mnt-k', text: label }),
      el('span', { class: 'mnt-v', text: value }),
      hint ? el('span', { class: 'mnt-h', text: hint }) : null
    );
    const orphanList = info.archive.orphans.length
      ? el('div', { class: 'mnt-list' }, ...info.archive.orphans.slice(0, 12).map((o) =>
          el('div', { class: 'mnt-item', text: o.rel })))
      : el('div', { class: 'hint', text: '没有孤儿文件' });
    const missingList = info.archive.missing.length
      ? el('div', { class: 'mnt-list' }, ...info.archive.missing.slice(0, 12).map((o) =>
          el('div', { class: 'mnt-item', text: `${o.title} · ${o.rel}` })))
      : el('div', { class: 'hint', text: '每个已完成任务都有归档文件' });

    modal.append(
      el('h2', { text: '体检与清理' }),
      el('div', { class: 'hint', text: '只读检查；清理需要你点按钮确认。' }),
      el('div', { class: 'mnt-card' },
        row('数据库', `${info.db.size_mb} MB`, `WAL ${info.db.wal_size_mb} MB · 完整性 ${info.db.integrity}`),
        row('归档', `${info.archive.files} 个文件 / ${info.archive.size_mb} MB`, '普通 Markdown，直接复制走就是备份'),
        row('待办', `未完成 ${info.tasks.open} · 已完成 ${info.tasks.done} · 已删 ${info.tasks.deleted}`, `速记 ${info.tasks.memos} 条`),
        row('失效关联', `${info.links.missing} 个`, '文件被移动或删掉后，关联会标成「丢失」'),
        row('服务进程', info.pid.pid ? `${info.pid.pid}${info.pid.alive ? '（在跑）' : '（已退出）'}` : '没有 pidfile', 'pidfile 过期不影响使用，只会让停止脚本多找一次'),
        row('备份', `${info.backups.length} 份`, info.backups[0] ? `最近：${info.backups[0].name}` : '还没备份过')
      ),
      el('div', { class: 'm-field' },
        el('label', { text: `孤儿归档（${info.archive.orphans.length}）` }),
        el('div', { class: 'hint' }, '库里的任务已经没了，但文件还留在 archive 目录里。'),
        orphanList,
        info.archive.orphans.length
          ? el('button', {
              class: 'btn',
              text: `删掉这 ${info.archive.orphans.length} 个孤儿文件`,
              onclick: async () => {
                if (!window.confirm(`确定删掉 ${info.archive.orphans.length} 个孤儿归档文件？删了就找不回来了。`)) return;
                try {
                  const r = await api.post('/api/maintenance/clean-orphans', {});
                  toast(`已清理 ${r.removed} 个${r.failed.length ? `，${r.failed.length} 个没删成` : ''}`);
                  close();
                  openMaintenance();
                } catch (err) { showErr(err); }
              },
            })
          : null
      ),
      el('div', { class: 'm-field' },
        el('label', { text: `缺失归档（${info.archive.missing.length}）` }),
        el('div', { class: 'hint' }, '任务还在、但标记的归档文件不在了；重新完成一次或点「重新生成归档」可以补齐。'),
        missingList
      ),
      el('div', { class: 'm-actions' },
        el('button', { class: 'btn', text: '重新检查', onclick: () => { close(); openMaintenance(); } }),
        el('button', { class: 'btn', text: '打开归档目录', onclick: () => api.post('/api/open-directory', { target: 'archive' }).catch(showErr) }),
        el('button', { class: 'btn primary', text: '关闭', onclick: close })
      )
    );
  });
}

// ---- 版本与更新 ----------------------------------------------------------
// 只走 api.github.com：检查版本、下载安装包、校验 sha256。替换程序留给安装包自己。
function updRetry(box, label = '重试') {
  return el('button', { class: 'btn', text: label, style: { marginLeft: '8px' }, onclick: () => runUpdateCheck(box) });
}

async function runUpdateCheck(box) {
  box.replaceChildren(el('span', { class: 'hint', text: '正在检查…' }));
  let info;
  try {
    info = await api.get('/api/update?force=1');
  } catch (err) {
    box.replaceChildren(
      el('span', { class: 'hint', text: '检查失败：' + err.message }),
      updRetry(box)
    );
    return;
  }
  if (!info.ok) {
    box.replaceChildren(
      el('span', { class: 'hint', text: info.error || '检查失败' }),
      updRetry(box)
    );
    return;
  }
  if (!info.has_update) {
    box.replaceChildren(
      el('span', { class: 'hint', text: `已经是最新版本 v${info.current}` }),
      updRetry(box, '再检查一次')
    );
    return;
  }

  const dl = el('button', {
    class: 'btn primary',
    text: `下载安装包（${info.suggested?.size_mb ?? '?'} MB）`,
    onclick: () => startUpdateDownload(box, info),
  });
  const notes = String(info.notes || '').split('\n').slice(0, 24).join('\n');
  box.replaceChildren(
    el('div', { class: 'upd-title', text: `发现新版本 v${info.latest}` }),
    el('div', { class: 'hint', text: `当前 v${info.current}${info.cached ? ' · 这份信息来自缓存' : ''}` }),
    el('pre', { class: 'upd-notes', text: notes || '（这个版本没有写说明）' }),
    el('div', { class: 'upd-actions' }, dl,
      el('a', { class: 'btn', href: info.page_url, target: '_blank', rel: 'noreferrer', text: '在浏览器里看' }))
  );
}

async function startUpdateDownload(box, info) {
  box.replaceChildren(el('span', { class: 'hint', text: '正在开始下载…' }));
  try {
    await api.post('/api/update/download', { asset: info.suggested?.name });
  } catch (err) {
    box.replaceChildren(el('span', { class: 'hint', text: '下载失败：' + err.message }), updRetry(box));
    return;
  }
  const bar = el('span');
  const line = el('div', { class: 'hint', text: '下载中…' });
  const wrap = el('div', {},
    el('div', { class: 'upd-bar' }, bar),
    line
  );
  box.replaceChildren(wrap);

  const tick = async () => {
    let st;
    try {
      st = (await api.get('/api/update/download')).download;
    } catch {
      setTimeout(tick, 1200);
      return;
    }
    if (st.phase === 'running') {
      bar.style.width = Math.max(2, st.percent) + '%';
      line.textContent = `下载中 ${st.percent}% · ${st.received_mb} / ${st.total_mb} MB`;
      setTimeout(tick, 700);
      return;
    }
    if (st.phase === 'done') {
      bar.style.width = '100%';
      const name = String(st.file || '').split(/[\\/]/).pop();
      const verify = st.digestOk === true ? 'sha256 校验通过' : st.digestOk === false ? 'sha256 不一致' : '未提供校验值';
      box.replaceChildren(
        el('div', { class: 'upd-title', text: '安装包已下载' }),
        el('div', { class: 'hint', text: `${name} · ${st.total_mb} MB · ${verify}` }),
        el('div', { class: 'hint', text: '关掉工作台（托盘里退出），再运行这个安装包就能升级；数据在独立目录，不会被覆盖。' }),
        el('div', { class: 'upd-actions' },
          el('button', { class: 'btn', text: '打开所在文件夹', onclick: () => api.post('/api/update/reveal', {}).catch(showErr) }),
          updRetry(box, '重新检查'))
      );
      return;
    }
    box.replaceChildren(
      el('span', { class: 'hint', text: '下载失败：' + (st.error || '未知错误') }),
      updRetry(box)
    );
  };
  setTimeout(tick, 600);
}

function openSettings() {
  openModal((modal, close) => {
    modal.classList.add('wide');
    const s = state.bootstrap?.settings || {};
    const num = (key, label, hint) => {
      const input = el('input', { type: 'number', min: '0', max: '90', value: s[key] ?? '' });
      return el('div', { class: 'm-field' }, el('label', { text: label }), input,
        hint ? el('div', { class: 'hint', text: hint }) : null);
    };
    const lead = num('leadDays', '多少天内算「即将逾期」', '逾期、今天到期，以及这天数内到期的待办都会进「即将逾期」');
    const stale = num('staleDays', '无日期任务的“沉睡”阈值', '超过这么多天没动过的 P0/P1 会被推进「即将逾期」');
    const week = num('weekDays', '多少天内算「本周」', '超过上面「即将逾期」的天数、又在这天数内的，进「本周」');
    const themeSel = el('select', {},
      el('option', { value: 'light', text: '浅色' }), el('option', { value: 'dark', text: '深色' }));
    themeSel.value = document.documentElement.dataset.theme || 'light';

    const getVal = (wrap) => wrap.querySelector('input')?.value;

    modal.append(
      el('h2', { text: '设置' }),
      el('div', { class: 'm-field' }, el('label', { text: '外观' }), themeSel),
      lead, stale, week,
      el('div', { class: 'm-field' },
        el('label', { text: '到期提醒' }),
        el('div', { class: 'hint' }, '页面开着时每 20 秒检查一次；到点弹系统通知，页面里也留一条提示。'),
        el('button', { class: 'btn', style: { marginTop: '6px' }, text: '开启系统通知', onclick: requestNotifyPermission })
      ),
      el('div', { class: 'm-field' },
        el('label', { text: '数据位置' }),
        el('div', { class: 'hint' }, `数据库：${state.bootstrap?.dbPathHint || 'workbench/data/workbench.db'}`),
        el('div', { class: 'hint' }, `归档目录：${state.bootstrap?.archiveRoot || ''}`),
        el('div', { class: 'hint', style: { marginTop: '6px' } },
          '归档是普通文件夹，直接复制走就是备份。'),
        el('div', { class: 'hint', id: 'autoBackupHint', text: '自动备份：每天第一次启动时留一份，只保留最近 7 份。' })
      ),
      (() => {
        const updBox = el('div', { class: 'upd-box', id: 'updBox' },
          el('button', { class: 'btn', text: '检查更新', onclick: () => runUpdateCheck(updBox) }),
          el('span', { class: 'hint', text: '只连 api.github.com，不走网页直链' })
        );
        return el('div', { class: 'm-field' },
          el('label', { text: '版本与更新' }),
          el('div', { class: 'hint' }, `当前版本：${state.bootstrap?.version || '未知'}`),
          updBox
        );
      })(),
      el('div', { class: 'm-actions' },
        el('button', { class: 'btn', text: '立即备份', onclick: doBackup }),
        el('button', { class: 'btn', text: '体检与清理', title: '看看库里、归档里有没有对不上的地方', onclick: () => { close(); openMaintenance(); } }),
        el('button', { class: 'btn', text: '重新生成归档', onclick: rerenderArchive }),
        el('button', { class: 'btn', text: '打开数据目录', onclick: () => api.post('/api/open-directory', { target: 'data' }).catch(showErr) }),
        el('button', { class: 'btn primary', text: '保存', onclick: async () => {
          try {
            applyTheme(themeSel.value);
            await api.put('/api/settings', {
              settings: { leadDays: Number(getVal(lead)), staleDays: Number(getVal(stale)), weekDays: Number(getVal(week)), theme: themeSel.value },
            });
            close(); toast('设置已保存'); refresh();
          } catch (err) { showErr(err); }
        } })
      )
    );
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));

    // 启动时的静默检查已经拿到结果时，直接把结果展开；否则保持「检查更新」按钮，别一开面板就连网
    const box = $('#updBox');
    if (box && state.pendingUpdate) runUpdateCheck(box).catch(() => {});

    // 顺手把「上次自动备份」填进数据位置那一段
    api.get('/api/maintenance').then((m) => {
      const hint = $('#autoBackupHint');
      if (!hint || !m || !m.backup || !m.backup.auto_at) return;
      const at = String(m.backup.auto_at).replace('T', ' ').slice(0, 16);
      hint.textContent = `自动备份：每天第一次启动时留一份，只保留最近 7 份（上次：${at}）。`;
    }).catch(() => {});
  });
}

/* 每天第一次打开时给一条今日摘要；不想看就点掉，第二天再出现 */
async function showDailyDigestOnce() {
  try {
    if (localStorage.getItem('wb-digest-day') === todayStr()) return;
    const d = await api.get('/api/digest');
    if (!d || (!d.open && !d.overdue)) {
      localStorage.setItem('wb-digest-day', todayStr());
      return;
    }
    const bits = [];
    if (d.due_today) bits.push(`今天 ${d.due_today} 件`);
    if (d.overdue) bits.push(`逾期 ${d.overdue} 件`);
    if (d.waiting) bits.push(`等他人 ${d.waiting} 件`);
    if (d.minutes) bits.push(`预计 ${minuteText(d.minutes)}`);
    toast(`今日摘要：${bits.join(' · ') || `未完成 ${d.open} 件`}`, {
      ms: 7000,
      actionLabel: '看今天',
      onAction: () => setView('today'),
    });
    localStorage.setItem('wb-digest-day', todayStr());
  } catch {
    /* 摘要失败不打扰用户 */
  }
}

/* 每天第一次打开时静默查一次更新；有新版本只在顶栏齿轮上点一颗小圆点 */
async function checkUpdateSilently() {
  try {
    const day = localStorage.getItem('wb-update-day') || '';
    if (day === todayStr()) return;
    localStorage.setItem('wb-update-day', todayStr());
    const r = await api.get('/api/update');
    if (r && r.has_update) markUpdateBadge(r);
  } catch {
    /* 联不上就不提，用户手动点设置里的「检查更新」会看到原因 */
  }
}

function markUpdateBadge(info) {
  state.pendingUpdate = info;
  const btn = $('#btnSettings');
  if (!btn) return;
  btn.classList.add('has-update');
  btn.title = `有新版本 v${info.latest || ''}，点开设置查看`;
}

async function doBackup() {
  try {
    const r = await api.post('/api/backup', {});
    toast('已备份：' + (r.file || '').split(/[\\/]/).pop());
  } catch (err) { showErr(err); }
}

async function rerenderArchive() {
  try {
    const r = await api.post('/api/archive/rerender', {});
    toast(`已重新生成 ${r.count ?? r.total ?? ''} 个归档文件`);
    refresh();
  } catch (err) { showErr(err); }
}

/* 导出：把「现在看到的筛选」原样拼成查询串，服务端和 listTasks 同构 */
function exportParams() {
  const p = new URLSearchParams();
  if (state.view === 'day' && state.day) {
    if (isDoneDay()) { p.set('status', 'done'); p.set('doneOn', state.day); }
    else { p.set('status', 'open'); p.set('due', state.day); }
    return p;
  }
  p.set('status', 'open');
  if (state.filter.cat) p.set('category', state.filter.cat);
  if (state.filter.tag) p.set('tag', state.filter.tag);
  if (state.filter.q) p.set('q', state.filter.q);
  return p;
}

async function exportCurrent() {
  try {
    const res = await fetch(`/api/export.md?${exportParams().toString()}`, { headers: { 'x-wb-token': TOKEN } });
    if (!res.ok) throw new Error('导出失败');
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `待办导出-${todayStr()}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    toast('已导出当前筛选');
  } catch (err) {
    showErr(err);
  }
}

async function downloadBriefing() {
  try {
    const res = await fetch('/api/briefing.md', { headers: { 'x-wb-token': TOKEN } });
    if (!res.ok) throw new Error('简报生成失败');
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `今日简报-${todayStr()}.md` });
    document.body.append(a); a.click(); a.remove();
    toast('今日简报已下载');
  } catch (err) { showErr(err); }
}

/* --------------------------- 到期提醒（轮询） --------------------------- */
// 服务端用 remind_fired 抢占：页面和托盘谁先轮到谁发。这里只负责把抢到的弹出来。
/* 速记：一句话进收件箱；解析规则和新建弹窗共用 parseQuick */
/* 速记：回车即存，独立于待办（便签/备忘录语义）。要变待办在速记列表里点「转成待办」。 */
async function captureQuick(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const input = $('#captureInput');
  try {
    const r = await api.post('/api/memos', { body: text });
    if (input) input.value = '';
    await loadMemos();
    if (state.view === 'memo') renderAll();
    else renderNav();
    const first = text.split('\n')[0];
    toast(`已记下：${first.length > 16 ? `${first.slice(0, 16)}…` : first}`, {
      actionLabel: '转成待办',
      onAction: () => { if (r?.memo) memoToTask(r.memo); },
    });
  } catch (err) {
    showErr(err);
  }
}

/* 速记 → 待办：拿正文第一行当标题，剩下的当备注，走新建弹窗让用户补日期分类 */
function memoToTask(memo) {
  const lines = String(memo?.body || '').split('\n');
  const title = (lines[0] || '').trim();
  const notes = lines.slice(1).join('\n').trim();
  openNewTaskModal({ prefill: title, notes, memoId: memo?.id });
}

/* 键盘上下选择：把当前选中挪到相邻一行，并跟着滚动 */
async function moveSelection(delta) {
  const rows = Array.from(document.querySelectorAll('#list .row'));
  if (!rows.length) return;
  const ids = rows.map((r) => r.dataset.id);
  const at = ids.indexOf(state.selectedId);
  let next = at < 0 ? (delta > 0 ? 0 : ids.length - 1) : at + delta;
  next = Math.max(0, Math.min(ids.length - 1, next));
  const id = ids[next];
  if (!id || id === state.selectedId) return;
  await selectTask(id);
  document.querySelector(`#list .row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

/* 时钟只在聚焦页存在时每秒走一格；不在这个视图就不做任何事 */
function tickFocusClock() {
  if (state.view !== 'focus') return;
  const time = $('#fwTime');
  if (!time) return;
  const d = new Date();
  time.textContent = clockText(d);
  const dateEl = $('#fwDate');
  if (dateEl) dateEl.textContent = mdLabel(todayStr());
  const greet = $('#fwGreet');
  if (greet) greet.textContent = greetText(d);
}

async function pollReminders() {
  try {
    const r = await api.get('/api/reminders');
    for (const item of r.reminders || []) notifyReminder(item);
  } catch {
    /* 服务没起来就下一轮再来，别弹错误打扰人 */
  }
}

function notifyReminder(item) {
  toast(`⏰ ${item.title}`, {
    ms: 9000,
    actions: [
      { label: '稍后 10 分钟', onClick: () => snoozeReminder(item.id, 10) },
      { label: '稍后 1 小时', onClick: () => snoozeReminder(item.id, 60) },
      { label: '打开', onClick: () => selectTask(item.id) },
    ],
  });
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const when = item.remind_at ? item.remind_at.replace('T', ' ') : '';
    const body = [item.category_name || '未分类', item.due_on ? `截止 ${item.due_on}` : '无截止日期', when ? `提醒 ${when}` : '']
      .filter(Boolean).join(' · ');
    const n = new Notification(`待办提醒：${item.title}`, { body, tag: `wb-${item.id}` });
    n.onclick = () => { window.focus(); selectTask(item.id); n.close(); };
  } catch {
    /* 浏览器不支持系统通知时，页面 toast 已经提示过了 */
  }
}

async function snoozeReminder(id, minutes) {
  try {
    const r = await api.post(`/api/tasks/${id}/snooze`, { minutes });
    if (state.detail?.task?.id === id) {
      state.detail.task.remind_at = r.remind_at;
      renderDetail();
    }
    toast(`好的，${minutes >= 60 ? `${Math.round(minutes / 60)} 小时后` : `${minutes} 分钟后`}再提醒你`);
  } catch (err) {
    toast(`没改成：${err.message}`);
  }
}

async function requestNotifyPermission() {
  if (!('Notification' in window)) {
    toast('这个浏览器不支持系统通知，到点只会在页面里提示');
    return;
  }
  if (Notification.permission === 'granted') { toast('系统通知已经开着'); return; }
  if (Notification.permission === 'denied') {
    toast('系统通知被拒绝过，要在地址栏左侧手动改成「允许」');
    return;
  }
  try {
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? '系统通知已开启' : '没拿到通知权限，到点只在页面里提示');
  } catch (err) {
    showErr(err);
  }
}

/* ------------------------------ 视图切换 ------------------------------ */
function setView(view) {
  state.view = view;
  state.filter.q = '';
  if (view !== 'day') state.day = null;
  refresh();
}

/* ------------------------------ 重复（例行系列） ------------------------------ */
/* ------------------------------ 速记视图 ------------------------------ */
function memoRow(m) {
  const row = el('article', { class: 'memo', 'data-id': m.id });
  const bodyBox = el('div', { class: 'memo-body' });
  const paintBody = () => {
    bodyBox.innerHTML = '';
    if (m._editing) {
      const ta = el('textarea', {
        class: 'memo-edit',
        rows: String(Math.min(10, Math.max(2, m.body.split('\n').length))),
        'aria-label': '编辑速记',
      });
      ta.value = m.body;
      let done = false;
      const save = async () => {
        if (done) return;
        done = true;
        const next = ta.value.trim();
        m._editing = false;
        if (!next || next === m.body) { paintBody(); return; }
        try {
          await api.patch(`/api/memos/${m.id}`, { patch: { body: next }, rev: m.rev });
          await loadMemos();
          renderAll();
        } catch (err) { showErr(err); }
      };
      ta.addEventListener('blur', save);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { done = true; m._editing = false; e.stopPropagation(); ta.blur(); loadMemos().then(renderAll); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
      });
      bodyBox.append(ta);
      setTimeout(() => ta.focus(), 0);
      return;
    }
    bodyBox.append(el('div', {
      class: 'memo-text',
      text: m.body,
      title: '点击修改',
      onclick: () => { m._editing = true; paintBody(); },
    }));
  };
  paintBody();

  const meta = el('div', { class: 'memo-meta' },
    el('span', { class: 'memo-time', text: memoTime(m.created_at) }),
    el('span', { class: 'memo-acts' },
      el('button', {
        class: `memo-act${m.pinned ? ' on' : ''}`,
        title: m.pinned ? '取消置顶' : '置顶',
        text: '📌',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await api.patch(`/api/memos/${m.id}`, { patch: { pinned: !m.pinned }, rev: m.rev });
            await loadMemos();
            renderAll();
          } catch (err) { showErr(err); }
        },
      }),
      el('button', {
        class: 'memo-act',
        title: '转成待办（正文第一行做标题）',
        text: '转成待办',
        onclick: (e) => { e.stopPropagation(); memoToTask(m); },
      }),
      el('button', {
        class: 'memo-act danger',
        title: '删除',
        text: '✕',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await api.del(`/api/memos/${m.id}`);
            await loadMemos();
            renderAll();
            toast('速记已删除', {
              actionLabel: '撤销',
              onAction: async () => {
                try { await api.post(`/api/memos/${m.id}/restore`, {}); await loadMemos(); renderAll(); } catch (err) { showErr(err); }
              },
            });
          } catch (err) { showErr(err); }
        },
      })));

  row.append(bodyBox, meta);
  return row;
}

function renderMemo() {
  const list = $('#list');
  list.innerHTML = '';
  const rows = state.memos || [];
  const search = el('input', {
    class: 'memo-search',
    id: 'memoSearch',
    placeholder: '搜速记里的字…',
    'aria-label': '搜索速记',
  });
  search.value = state.memoQ;
  search.addEventListener('input', debounce(() => {
    state.memoQ = search.value.trim();
    loadMemos().then(renderAll);
  }, 220));
  list.append(el('div', { class: 'memo-head' }, search,
    el('span', { class: 'memo-count', text: rows.length ? `${rows.length} 条` : '' })));

  if (!rows.length) {
    const box = el('div', { class: 'memo-empty' });
    box.append(
      el('strong', { text: state.memoQ ? '没有匹配的速记' : '还没有速记' }),
      el('div', {
        text: state.memoQ
          ? '换个词试试，或者清空搜索框看全部。'
          : '上面那条「速记」输入框，随手写一句回车就存在这里。它不会变成待办，也不会催你；哪天想做了，点「转成待办」。',
      }));
    list.append(box);
    return;
  }
  const card = el('div', { class: 'card memo-card' });
  for (const m of rows) card.append(memoRow(m));
  list.append(card);
}

/* 回收站：删掉的东西先放这里，能还原也能彻底删掉 */
function renderTrash() {
  const list = $('#list');
  list.innerHTML = '';
  const tasks = state.trash?.tasks || [];
  const memos = state.trash?.memos || [];

  if (!tasks.length && !memos.length) {
    const box = el('div', { class: 'memo-empty' });
    box.append(
      el('strong', { text: '回收站是空的' }),
      el('div', { text: '删掉的待办和速记会先放这里，7 天内都能还原；想立刻腾空间也可以在这里彻底删掉。' }),
    );
    list.append(box);
    return;
  }

  const head = el('div', { class: 'trash-head' },
    el('span', { class: 'muted', text: `待办 ${tasks.length} 条 · 速记 ${memos.length} 条` }));
  if (tasks.length) {
    head.append(el('button', {
      class: 'btn small ghost', text: '清空待办回收站',
      onclick: async () => {
        if (!window.confirm(`彻底删掉这 ${tasks.length} 条待办？删了就找不回来了。`)) return;
        try {
          for (const t of tasks) await api.post(`/api/tasks/${t.id}/purge`);
          await refresh();
          toast(`已彻底删掉 ${tasks.length} 条待办`);
        } catch (err) { showErr(err); }
      },
    }));
  }
  list.append(head);

  if (tasks.length) {
    const card = el('div', { class: 'card' });
    for (const t of tasks) {
      card.append(el('div', { class: 'row trash-row' },
        el('span', { class: 'bar' }),
        el('span', { class: 'tick ghost' }),
        el('div', { class: 'rt' },
          el('span', { class: 'rt-text', text: t.title }),
          el('span', { class: 'trash-meta', text: `${t.category_name || '未分类'} · 删除于 ${memoTime(t.deleted_at)}` })),
        el('div', { class: 'meta' }),
        el('div', { class: 'row-actions' },
          el('button', {
            class: 'btn small ghost', text: '还原',
            onclick: async () => {
              try {
                await api.post(`/api/tasks/${t.id}/restore`);
                await refresh();
                toast(`已还原：${t.title}`);
              } catch (err) { showErr(err); }
            },
          }),
          el('button', {
            class: 'btn small ghost danger', text: '彻底删',
            onclick: async () => {
              if (!window.confirm(`彻底删掉「${t.title}」？删了就找不回来了。`)) return;
              try {
                await api.post(`/api/tasks/${t.id}/purge`);
                await refresh();
                toast('已彻底删除');
              } catch (err) { showErr(err); }
            },
          })))) ;
    }
    list.append(card);
  }

  if (memos.length) {
    const card = el('div', { class: 'card' });
    for (const m of memos) {
      const first = String(m.body || '').split('\n')[0];
      card.append(el('div', { class: 'row trash-row' },
        el('span', { class: 'bar' }),
        el('span', { class: 'tick ghost' }),
        el('div', { class: 'rt' },
          el('span', { class: 'rt-text', text: first.length > 40 ? first.slice(0, 40) + '…' : first }),
          el('span', { class: 'trash-meta', text: `速记 · 删除于 ${memoTime(m.deleted_at)}` })),
        el('div', { class: 'meta' }),
        el('div', { class: 'row-actions' },
          el('button', {
            class: 'btn small ghost', text: '还原',
            onclick: async () => {
              try {
                await api.post(`/api/memos/${m.id}/restore`);
                await refresh();
                toast('速记已还原');
              } catch (err) { showErr(err); }
            },
          }),
          el('button', {
            class: 'btn small ghost danger', text: '彻底删',
            onclick: async () => {
              if (!window.confirm('彻底删掉这条速记？删了就找不回来了。')) return;
              try {
                await api.post(`/api/memos/${m.id}/purge`);
                await refresh();
                toast('已彻底删除');
              } catch (err) { showErr(err); }
            },
          }))));
    }
    list.append(card);
  }
}

function renderSeries() {
  const list = $('#list');
  list.innerHTML = '';
  const rows = state.series || [];
  if (!rows.length) {
    showEmpty('还没有例行待办', '点右上角「＋ 添加」，勾上「重复」，可以选每月某日、每 N 天或每 N 周。');
    return;
  }
  const card = el('div', { class: 'card series-card' });
  for (const s of rows) {
    const off = s.status !== 'active';
    card.append(el('div', { class: `series-row${off ? ' off' : ''}` },
      el('span', { class: 'series-icon', text: '↻', title: '例行待办' }),
      el('div', { class: 'series-main' },
        el('div', { class: 'series-title', text: s.title }),
        el('div', { class: 'series-meta' },
          el('span', { text: s.rule_label || `每月 ${s.day_of_month} 号` }),
          s.next_on ? el('span', { text: `下一期 ${s.next_on}` }) : el('span', { text: '没有未完成的期了' }),
          el('span', {
            text: s.rule === 'monthly'
              ? `待办 ${s.open_count} · 已排期 ${s.scheduled_count || 0} · 已完成 ${s.done_count} · 共 ${s.total_count} 期`
              : `待办 ${s.open_count} · 已滚 ${s.repeat_done_count || 0} 轮`,
          }),
          off ? el('span', { class: 'series-badge', text: '已取消' }) : null
        )
      ),
      el('div', { class: 'series-actions' },
        el('button', {
          class: 'tool-btn', text: '看下一期', disabled: !s.next_on ? '' : undefined,
          onclick: () => openNextOccurrence(s),
        }),
        off
          ? el('button', { class: 'tool-btn', text: '恢复', onclick: () => seriesAction(s, 'resume') })
          : el('button', { class: 'tool-btn', text: '取消未来', title: '今天之后的期作废，已完成的保留', onclick: () => seriesAction(s, 'cancel') }),
        !off
          ? el('button', {
              class: 'tool-btn', text: '跳过这一期',
              title: s.rule === 'monthly'
                ? '这一期不做了，系列里这一期标为已跳过，后面的期次不受影响'
                : '这一期不做了，系列继续往后滚（不会留下已完成记录）',
              onclick: () => seriesAction(s, 'skip'),
            })
          : null,
        el('button', { class: 'tool-btn danger-text', text: '删除', title: '连同所有期一起删掉', onclick: () => seriesAction(s, 'delete') })
      )
    ));
  }
  list.append(card);
}

async function openNextOccurrence(s) {
  try {
    const r = await api.get('/api/tasks?status=open&limit=1000');
    const hit = r.tasks
      .filter((t) => t.series_id === s.id)
      .sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)))[0];
    if (!hit) { toast('这个系列暂时没有未完成的期'); setView('series'); return; }
    if (state.view !== 'series') setView('series');
    await selectTask(hit.id);
  } catch (err) { showErr(err); }
}

async function seriesAction(s, kind) {
  if (kind === 'delete') {
    const ok = window.confirm(`删除例行「${s.title}」？会连同它生成的 ${s.total_count} 期一起删掉，已完成的历史也会消失。`);
    if (!ok) return;
    try {
      await api.del(`/api/series/${s.id}`);
      toast('例行已删除');
      await loadSeries();
      refresh();
    } catch (err) { showErr(err); }
    return;
  }
  if (kind === 'cancel') {
    const ok = window.confirm(`取消「${s.title}」今天之后的期？已完成的记录会保留。`);
    if (!ok) return;
    try {
      const r = await api.post(`/api/series/${s.id}/cancel`, { scope: 'future' });
      toast(`已取消 ${r.cancelled} 期`);
      await loadSeries();
      refresh();
    } catch (err) { showErr(err); }
    return;
  }
  if (kind === 'skip') {
    try {
      const r = await api.post(`/api/series/${s.id}/skip`, {});
      toast(`这一期（${r.skipped}）跳过，下一期 ${r.next}`);
      await loadSeries();
      refresh();
    } catch (err) { showErr(err); }
    return;
  }
  try {
    const r = await api.post(`/api/series/${s.id}/resume`, {});
    toast(`已恢复 ${r.resumed} 期`);
    await loadSeries();
    refresh();
  } catch (err) { showErr(err); }
}

/* ------------------------------ 总渲染 ------------------------------ */
function renderAll() {
  renderNav();
  renderCats();
  renderSeriesSidebar();
  renderTags();
  renderViewHead();
  if (state.view === 'focus') renderFocus();
  else if (state.view === 'today') renderToday();
  else if (state.view === 'day') renderDay();
  else if (state.view === 'all') renderAllList();
  else if (state.view === 'series') renderSeries();
  else if (state.view === 'done') renderDone();
  else if (state.view === 'archive') renderArchive();
  else if (state.view === 'stats') renderStats();
  else if (state.view === 'calendar') renderCalendarView();
  else if (state.view === 'memo') renderMemo();
  else if (state.view === 'trash') renderTrash();
  renderStatusBar();
  renderBulkBar();
  document.body.querySelector('.body').classList.toggle('no-detail', !state.selectedId);
  renderDetail();
  if (state.detail) syncDetailSnapshot();
}

/** 详情面板每次重渲染后，用最新列表数据刷新一下标题外的状态 */
function syncDetailSnapshot() {
  const row = state.tasks.find((t) => t.id === state.selectedId) || state.done.find((t) => t.id === state.selectedId);
  if (row) state.detail.task = { ...state.detail.task, ...row };
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindEvents() {
  // 唯一的添加入口：直接开完整表单（分类/日期/优先级/例行都在里面）
  $('#qaAdd').addEventListener('click', () => openNewTaskModal());
  // 速记：回车即走，不打断手上动作
  $('#captureForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    captureQuick($('#captureInput')?.value);
  });
  // 速记框里 Esc 直接退出：不进全局 Esc 的层级逻辑，也不清空已经写了一半的字
  $('#captureInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.target.blur();
    }
  });
  $('#btnAddSeries').addEventListener('click', () => openNewTaskModal({ recurring: true }));
  $('#searchTrigger').addEventListener('click', openPalette);
  $('#btnAddCat').addEventListener('click', () => openCategoryModal());
  $('#tagManage').addEventListener('click', () => openTagManager());
  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnContact').addEventListener('click', openContactModal);
  $('#btnReward').addEventListener('click', openRewardModal);
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnBriefing').addEventListener('click', downloadBriefing);
  $('#btnOpenArchive').addEventListener('click', () => api.post('/api/open-directory', { target: 'archive' }).catch(showErr));
  $('#btnCalendar').addEventListener('click', () => (state.cal.open ? closeCalendar() : openCalendar()));
  // 左上角日期也是月历入口
  $('#todayLabel').addEventListener('click', () => (state.cal.open ? closeCalendar() : openCalendar()));
  // 点浮层外面关掉月历
  document.addEventListener('click', (e) => {
    if (!state.cal.open) return;
    if (e.target.closest('#calendar') || e.target.closest('#btnCalendar') || e.target.closest('#todayLabel')) return;
    closeCalendar();
  });

  // 命令面板
  const palInput = $('#paletteInput');
  palInput.addEventListener('input', () => { paletteIndex = 0; renderPalette(palInput.value); });
  palInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePalette(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      paletteIndex = (paletteIndex + dir + paletteItems.length) % Math.max(1, paletteItems.length);
      $$('.p-item', $('#paletteList')).forEach((n, i) => n.classList.toggle('active', i === paletteIndex));
      $$('.p-item', $('#paletteList'))[paletteIndex]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      const it = paletteItems[paletteIndex];
      if (it) { closePalette(); it.run(); }
    }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#palette').hidden ? openPalette() : closePalette();
      return;
    }
    if (e.key === 'Escape') {
      // 新建待办弹窗优先：先收抽屉/月历，再关弹窗
      if (state.overlay) { e.preventDefault(); return state.overlay.onEsc(); }
      if (state.cal.open) return closeCalendar();
      if (!$('#palette').hidden) return closePalette();
      if ($('#modalRoot').children.length) return $('#modalRoot').innerHTML = '';
      if (state.selectedId) return closeDetail();
    }
    // Tab 焦点困在弹窗里
    if (e.key === 'Tab' && state.overlay) return state.overlay.onTab(e);
    // 月历打开时翻月
    if (state.cal.open && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      state.cal.ym = addMonths(state.cal.ym, e.key === 'PageUp' ? -1 : 1);
      loadCalendarMonth(state.cal.ym);
      return;
    }
    // 某一天的视图里左右键切前后一天（保持当前口径）
    if (!inField && state.view === 'day' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setDay(addDays(state.day, e.key === 'ArrowLeft' ? -1 : 1), state.dayMode);
      return;
    }
    if (!inField && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openNewTaskModal();
      return;
    }
    // 键盘流：C 速记、/ 搜索、E 完成、P 置顶、Del 删除、[ ] 上下选择
    if (inField || e.ctrlKey || e.altKey || e.metaKey) return;
    // 弹窗开着时不吃这些键；用真实存在的遮罩判断，别用 #modalRoot 里有没有残留节点
    if (state.overlay || $('.modal-mask')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'c') {
      const input = $('#captureInput');
      if (input && !$('#captureForm').hidden) {
        e.preventDefault();
        input.focus();
      }
      return;
    }
    if (key === '/') {
      e.preventDefault();
      openPalette();
      return;
    }
    const sel = state.detail?.task;
    if (key === 'e' && sel) {
      e.preventDefault();
      completeTask(sel);
      return;
    }
    if (key === 'p' && sel) {
      e.preventDefault();
      togglePin(sel);
      return;
    }
    if (key === 'Delete' && sel) {
      e.preventDefault();
      deleteTask(sel);
      return;
    }
    if (key === '[' || key === ']') {
      e.preventDefault();
      moveSelection(key === ']' ? 1 : -1);
    }
  });

  // 搜索框实时过滤（全部待办视图）
  window.addEventListener('beforeunload', () => {});
}

/* ------------------------------ 启动 ------------------------------ */
(async function boot() {
  try {
    if (!TOKEN || TOKEN === '__WB_TOKEN__' || TOKEN === '@@WB_TOKEN@@') {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">令牌未注入，请通过 http://127.0.0.1 打开本页面（不要直接用文件方式打开）。</div>';
      return;
    }
    // 支持 ?view=archive&theme=dark 这类深链：方便直接打开某个视图，也方便做截图自查
    let q = null;
    try { q = new URLSearchParams(location.search); } catch { q = null; }
    const qTheme = q?.get('theme');
    if (qTheme === 'dark' || qTheme === 'light') {
      // 深链里的主题只影响这一次渲染，不写进 localStorage / 设置
      document.documentElement.dataset.theme = qTheme;
    }
    const qView = q?.get('view');
    // 白名单直接取自 VIEWS，新增视图不用再改这里（'day' 是临时视图，不在 VIEWS 里）
    if (qView === 'day' || VIEWS.some((v) => v.id === qView)) state.view = qView;
    if (state.view === 'day') {
      const qDate = q?.get('date') || '';
      state.day = /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : localDate();
      const qMode = q?.get('mode');
      // 深链的 mode 做白名单校验，脏值退回默认规则（未来看到期，今天与过去看完成）
      state.dayMode = qMode === 'due' || qMode === 'done'
        ? qMode
        : (state.day > todayStr() ? 'due' : 'done');
    }
    applyTheme(localStorage.getItem('wb-theme') || 'light');
    if (qTheme === 'dark' || qTheme === 'light') document.documentElement.dataset.theme = qTheme;
    await loadBootstrap();
    bindEvents();
    await refresh();
    // 每秒刷新一次「今天」判断，跨零点不至于卡在旧日期
    setInterval(() => { if (state.bootstrap && state.bootstrap.today !== localDate()) refresh(); }, 60000);
    // 到期提醒：20 秒一轮，服务端用 remind_fired 抢占，托盘和页面不会重复弹
    pollReminders();
    setInterval(pollReminders, 20000);
    // 每天第一次打开时后台查一次更新：失败静默，只在顶栏齿轮上点一个小圆点
    checkUpdateSilently();
    // 每天第一次打开时给一条今日摘要（今天几件、预计多久、有没有逾期）
    showDailyDigestOnce();
    // 聚焦页的时钟每秒走一格（不在这个视图时代价只有一次判断）
    setInterval(tickFocusClock, 1000);
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#B91C1C">启动失败：${err.message}</div>`;
  }
})();
