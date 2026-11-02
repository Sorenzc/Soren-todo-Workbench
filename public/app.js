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
};

/* ------------------------------ Toast ------------------------------ */
function toast(msg, opts = {}) {
  const root = $('#toasts');
  const box = el('div', { class: 'toast' },
    el('span', { class: 'toast-msg', text: msg }),
    opts.actionLabel ? el('button', { text: opts.actionLabel, onclick: () => { opts.onAction?.(); dismiss(); } }) : null,
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
    { kind: '命令', text: '新建每月例行', run: () => { closePalette(); openNewTaskModal({ recurring: true }); } },
    { kind: '命令', text: '联系作者（扫码反馈）', run: () => { closePalette(); openContactModal(); } },
    { kind: '命令', text: '激励作者（支付宝扫码）', run: () => { closePalette(); openRewardModal(); } },
    { kind: '命令', text: '新建分类', run: () => { closePalette(); openCategoryModal(); } },
    { kind: '命令', text: '打开设置', run: () => { closePalette(); openSettings(); } },
    { kind: '命令', text: '今日简报（Markdown）', run: () => { closePalette(); downloadBriefing(); } },
    { kind: '命令', text: '打开归档文件夹', run: () => { closePalette(); api.post('/api/open-directory', { target: 'archive' }).catch(showErr); } },
    { kind: '命令', text: '立即备份数据库', run: () => { closePalette(); doBackup(); } },
    { kind: '命令', text: '切换深浅色', run: () => { closePalette(); toggleTheme(); } },
    { kind: '命令', text: '重新生成全部归档文件', run: () => { closePalette(); rerenderArchive(); } },
  ];
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
    if (state.cal.open) await loadCalendarMonth(state.cal.ym);
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
  { id: 'series', label: '例行', icon: '↻' },
  { id: 'done', label: '已完成', icon: '✓' },
  { id: 'archive', label: '归档', icon: '▤' },
  { id: 'stats', label: '统计', icon: '▦' },
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
        el('span', { class: 'cat-n', text: `每月${s.day_of_month}` })
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
}

/* ------------------------------ 主列表 ------------------------------ */
// 一行只留四类信息：标题 / 分类 / 优先级 / 到期。色条只表示紧迫度，
// 其余（标签、评分、原因、关联）挪到详情面板，避免一行 8 个元素抢注意力。
function taskRow(t, opts = {}) {
  const isDone = t.status === 'done';
  const dl = t.due_on ? daysLeft(t.due_on) : null;
  const urgency = isDone || dl === null ? '' : dl < 0 ? 'overdue' : dl === 0 ? 'today' : '';
  const folder = t.primary_link_state === 'missing'
    ? el('span', { class: 'row-folder missing', title: '关联的文件夹找不到了', text: '⚠' })
    : t.link_count ? el('span', { class: 'row-folder', title: '已关联文件夹', text: '📁' }) : null;
  const dueText = isDone
    ? (t.completed_at ? (isDoneDay() ? t.completed_at.slice(11, 16) : t.completed_at.slice(5, 10)) : '')
    : dl === null ? ''
      : dl < 0 ? `逾期 ${-dl} 天`
        : dl === 0 ? '今天'
          : `${parseDate(t.due_on).getMonth() + 1}-${parseDate(t.due_on).getDate()}`;
  const tips = [t.title, t.category_name && `分类：${t.category_name}`, t.due_on && `到期：${t.due_on}`,
    t.tag_names && `标签：${t.tag_names}`, t.why, t.archived_path && `归档：${t.archived_path}`].filter(Boolean).join('\n');
  return el('article', {
    class: `row${isDone ? ' done' : ''}${state.selectedId === t.id ? ' selected' : ''}${state.flashTaskId === t.id ? ' flash' : ''}`,
    dataset: { id: t.id }, title: tips,
    onclick: (e) => { if (!e.target.closest('button')) selectTask(t.id); },
  },
    el('span', { class: `bar ${urgency}` }),
    isDone
      ? el('button', { class: 'tick', title: '重新打开', text: '✓', onclick: () => reopenTask(t) })
      : el('button', { class: 'tick', title: '标记完成', text: '✓', onclick: () => completeTask(t) }),
    el('span', { class: 'row-title' }, t.title, t.series_id ? el('span', { class: 'row-recur', title: '每月例行', text: '↻' }) : null),
    t.category_name
      ? el('span', { class: 'row-cat', style: { '--c': t.category_color || 'var(--text-3)' } },
          el('span', { class: 'd' }), t.category_name)
      : el('span'),
    el('span', { class: `row-prio p${t.priority}`, text: t.priority <= 1 ? PRIO_SHORT[t.priority] : '' }),
    el('span', { class: `row-due ${isDone ? 'done-time' : urgency}`, text: dueText }),
    folder || el('span'),
    el('div', { class: 'row-actions' },
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

function renderFocus() {
  const list = $('#list');
  list.innerHTML = '';
  const f = state.focus;
  const items = state.tasks;
  if (!f || !items.length) {
    showEmpty('今天没有必须处理的事项', '按 N 记一条，或切到「全部待办」看看还有什么。');
    return;
  }
  const must = f.must || [];
  const week = f.week || [];
  const mustIds = new Set(must.map((t) => t.id));
  const weekIds = new Set(week.map((t) => t.id));
  const pool = items.filter((t) => !mustIds.has(t.id) && !weekIds.has(t.id));

  if (must.length) {
    // 「即将逾期」比「必做」更好懂：这里放的就是逾期 + 快到期 + 久未处理的硬骨头
    const breakdown = [
      f.overdue_count ? `逾期 ${f.overdue_count}` : '',
      f.today_count ? `今天 ${f.today_count}` : '',
    ].filter(Boolean).join(' · ');
    const hint = breakdown || '拖了很久的 P0/P1';
    list.append(groupHead('即将逾期', must.length, f.overdue_count ? 'overdue' : '', hint));
    list.append(rowCard(must));
  }
  if (week.length) {
    list.append(groupHead('本周', week.length, '', '7 天内到期'));
    list.append(rowCard(week));
  }
  const poolShow = pool.slice(0, 60);
  if (poolShow.length) {
    list.append(groupHead('待办池', pool.length, '', '无日期或 7 天以后'));
    list.append(rowCard(poolShow));
    if (pool.length > poolShow.length) {
      list.append(el('div', { class: 'list-foot', text: `还有 ${pool.length - poolShow.length} 条在池子里，用搜索或「全部待办」查看` }));
    }
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
    list.append(groupHead('逾期', overdue.length, 'overdue', '补完就清掉'));
    list.append(rowCard(overdue));
  }
  if (today.length) {
    list.append(groupHead('今天到期', today.length, 'today', ''));
    list.append(rowCard(today));
  }
}

const SORT_LABEL = { score: '智能', due: '到期时间', priority: '优先级', created: '创建时间' };

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
  const flag = state.filter.q ? `搜索「${state.filter.q}」` : `按${SORT_LABEL[state.filter.sort] || '智能'}排序`;
  list.append(groupHead('待办', items.length, '', flag));
  list.append(rowCard(items));
}

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

async function renderArchive() {
  const list = $('#list');
  list.innerHTML = '';
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
  const canAdd = !['archive', 'stats', 'series'].includes(state.view) && !isDoneDay();
  $('#qaAdd').hidden = !canAdd;
  const f = state.focus;
  if (state.view === 'focus') {
    t.textContent = '聚焦';
    sub.textContent = f ? `今天到期 ${f.today_count ?? 0} 件 · 逾期 ${f.overdue_count ?? 0} 件` : '正在计算…';
  } else if (state.view === 'today') {
    const overdue = state.tasks.filter((x) => daysLeft(x.due_on) < 0).length;
    t.textContent = '今天';
    sub.textContent = `逾期 ${overdue} 件 · 今天到期 ${state.tasks.length - overdue} 件`;
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
      el('button', { class: 'tool-btn', text: '后一天 ›', title: '后一天（→）', onclick: () => setDay(addDays(state.day, 1), state.dayMode) })
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
  } else if (state.view === 'series') {
    const alive = (state.series || []).filter((s) => s.status === 'active').length;
    t.textContent = '每月例行';
    sub.textContent = `共 ${(state.series || []).length} 个系列 · ${alive} 个在跑`;
    tools.append(el('button', {
      class: 'tool-btn', text: '＋ 新建例行', title: '新建一个每月重复的待办',
      onclick: () => openNewTaskModal({ recurring: true }),
    }));
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
    el('span', {}, el('kbd', { text: 'Ctrl K' }), ' 搜索/跳转'),
    el('span', {}, el('kbd', { text: 'Esc' }), ' 关闭详情')
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
  const estInput = el('input', { type: 'number', min: '1', step: '5', value: t.estimate_min ?? '', placeholder: '分钟', onchange: () => queuePatch({ estimateMin: estInput.value ? Number(estInput.value) : null }) });

  root.append(el('div', { class: 'd-section' },
    el('div', { class: 'd-label', text: '安排' }),
    el('div', { class: 'd-grid' },
      el('label', { class: 'field' }, el('span', { text: '分类' }), catSelect),
      el('div', { class: 'field' }, el('span', { text: '优先级' }), prio),
      el('label', { class: 'field' }, el('span', { text: '截止日期' }), dueInput),
      el('label', { class: 'field' }, el('span', { text: '时间' }), dueTime),
      el('label', { class: 'field' }, el('span', { text: '预估耗时' }), estInput)
    )
  ));

  // 完成说明（已完成才有）
  if (isDone) {
    const note = el('input', { type: 'text', placeholder: '写了一两句完成说明？', value: t.done_note || '', onchange: () => queuePatch({ doneNote: note.value }) });
    root.append(el('div', { class: 'd-section' }, el('div', { class: 'd-label', text: '完成说明' }), el('label', { class: 'field' }, note)));
  }

  // 每月例行：让某一期能回溯到整个系列
  if (t.series_id) {
    const s = (state.series || []).find((x) => x.id === t.series_id);
    root.append(el('div', { class: 'd-section' },
      el('div', { class: 'd-label', text: '每月例行' }),
      el('button', {
        class: 'd-link', title: '打开例行列表',
        onclick: () => setView('series'),
      }, el('span', { class: 'series-icon', text: '↻' }),
        el('span', { text: s ? `${s.title} · 每月 ${s.day_of_month} 号` : '属于一个每月例行' }),
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
  // 每月例行：默认每月今天这个号，跑未来 36 期（3 年）
  const recur = {
    on: Boolean(opts.recurring),
    day: state.bootstrap?.today ? Number(state.bootstrap.today.slice(8, 10)) : new Date().getDate(),
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

  /* ---- 每月例行 ---- */
  const recurInput = el('input', { type: 'checkbox', class: 'tm-box', id: 'tmRecur', 'aria-label': '每月例行' });
  recurInput.checked = recur.on;
  const recurDay = el('span', { class: 'tm-recur-day', id: 'tmRecurDay', text: `${recur.day} 号` });
  const dayGrid = el('div', { class: 'tm-daygrid', id: 'tmDayGrid' });
  const recurHint = el('p', { class: 'tm-sub', id: 'tmRecurHint', text: '' });
  const horizonSel = el('select', { class: 'tm-input', id: 'tmHorizon', 'aria-label': '例行范围' },
    [12, 24, 36, 48, 60].map((n) => el('option', { value: String(n), text: `未来 ${n} 期` }))
  );
  horizonSel.value = String(recur.horizon);
  horizonSel.addEventListener('change', () => { recur.horizon = Number(horizonSel.value); drawRecur(); });
  const recurPanel = el('div', { class: 'tm-recur', id: 'tmRecurPanel' },
    el('div', { class: 'tm-row' },
      el('span', { class: 'tm-label', text: '每月' }),
      recurDay
    ),
    dayGrid,
    el('div', { class: 'tm-row' },
      el('span', { class: 'tm-label', text: '范围' }),
      horizonSel,
      el('span', { class: 'tm-unit', text: '期' })
    ),
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
  function drawRecur() {
    recurInput.checked = recur.on;
    recurPanel.hidden = !recur.on;
    recurDay.textContent = `${recur.day} 号`;
    horizonSel.value = String(recur.horizon);
    drawDayGrid();
    if (recur.on) {
      const first = model.dueOn && model.dueOn >= todayStr() ? model.dueOn : nextOccurrence(recur.day);
      recurHint.textContent = `会从 ${first} 开始，一次铺出未来 ${recur.horizon} 期；之后每次打开工作台自动往后补。可在「例行」里取消整个系列。`;
    }
  }
  recurInput.addEventListener('change', () => {
    recur.on = recurInput.checked;
    if (recur.on) {
      // 勾上例行就把截止日期自动补上：这个月还没到这个号就用这个月，过了就用下个月
      if (!model.dueOn || model.dueOn < todayStr()) model.dueOn = nextOccurrence(recur.day);
      else recur.day = Number(model.dueOn.slice(8, 10));
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
        el('label', { class: 'tm-recur-toggle', for: 'tmRecur' }, recurInput, el('span', { text: '每月例行' })),
        el('span', { class: 'tm-note', text: '到期后按月重复' })
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
    if (m.recurrence && !(Number.isInteger(m.recurrence.day_of_month) && m.recurrence.day_of_month >= 1 && m.recurrence.day_of_month <= 31)) return '每月例行要选 1–31 号中的一天';
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
      dueOn = dueOn && dueOn >= todayStr() ? dueOn : nextOccurrence(recur.day);
      model.dueOn = dueOn;
      recurrence = { rule: 'monthly', day_of_month: recur.day, start_month: monthOf(dueOn), horizon_months: recur.horizon };
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
        toast(`已建例行：每月 ${r.series.day_of_month} 号，铺了 ${r.seriesOccurrences} 期`, {
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
        el('label', { text: '数据位置' }),
        el('div', { class: 'hint' }, `数据库：${state.bootstrap?.dbPathHint || 'workbench/data/workbench.db'}`),
        el('div', { class: 'hint' }, `归档目录：${state.bootstrap?.archiveRoot || ''}`),
        el('div', { class: 'hint', style: { marginTop: '6px' } },
          '归档是普通文件夹，直接复制走就是备份。')
      ),
      el('div', { class: 'm-actions' },
        el('button', { class: 'btn', text: '立即备份', onclick: doBackup }),
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
  });
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

/* ------------------------------ 视图切换 ------------------------------ */
function setView(view) {
  state.view = view;
  state.filter.q = '';
  if (view !== 'day') state.day = null;
  refresh();
}

/* ------------------------------ 每月例行 ------------------------------ */
function renderSeries() {
  const list = $('#list');
  list.innerHTML = '';
  const rows = state.series || [];
  if (!rows.length) {
    showEmpty('还没有每月例行的事', '点右上角「＋ 添加」，勾上「每月例行」，填个号数就行。');
    return;
  }
  const card = el('div', { class: 'card series-card' });
  for (const s of rows) {
    const off = s.status !== 'active';
    card.append(el('div', { class: `series-row${off ? ' off' : ''}` },
      el('span', { class: 'series-icon', text: '↻', title: '每月例行' }),
      el('div', { class: 'series-main' },
        el('div', { class: 'series-title', text: s.title }),
        el('div', { class: 'series-meta' },
          el('span', { text: `每月 ${s.day_of_month} 号` }),
          s.next_on ? el('span', { text: `下一期 ${s.next_on}` }) : el('span', { text: '没有未完成的期了' }),
          el('span', { text: `待办 ${s.open_count} · 已排期 ${s.scheduled_count || 0} · 已完成 ${s.done_count} · 共 ${s.total_count} 期` }),
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
  renderStatusBar();
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
  $('#btnAddSeries').addEventListener('click', () => openNewTaskModal({ recurring: true }));
  $('#searchTrigger').addEventListener('click', openPalette);
  $('#btnAddCat').addEventListener('click', () => openCategoryModal());
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
    if (['focus', 'today', 'all', 'series', 'done', 'archive', 'stats', 'day'].includes(qView)) state.view = qView;
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
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#B91C1C">启动失败：${err.message}</div>`;
  }
})();
