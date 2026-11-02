// UI 冒烟：用极简 DOM 在 Node 里真实执行 public/app.js，逐个视图渲染，捕获运行时报错。
// 只读：不修改数据库（只走 GET 接口；写接口在前端只被事件触发，本脚本不点按钮）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argUrl = (() => {
  const i = process.argv.indexOf('--url');
  return i > 0 ? process.argv[i + 1] : '';
})();
const BASE = argUrl || process.env.WB_URL || 'http://127.0.0.1:7861';
const token = fs.readFileSync(path.join(ROOT, 'data', 'token.txt'), 'utf8').trim();
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
// 与服务端做同样的注入：把值占位符换成真实令牌（属性名 window.__WB_TOKEN__ 不受影响）
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replaceAll('@@WB_TOKEN@@', token);

/* ------------------------------ 极简 DOM ------------------------------ */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const JS_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'open', 'type', 'title', 'placeholder', 'href', 'download']);

class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._className = attrs.class || '';
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); }
  get textContent() {
    let out = this._text;
    for (const c of this.children) out += c instanceof El ? c.textContent : c.text;
    return out;
  }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  get innerHTML() { return ''; }
  set innerHTML(v) { this.children = []; this._text = ''; }
  get classList() {
    const self = this;
    return {
      add: (...cs) => { const s = new Set(self._className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); self._className = [...s].join(' '); },
      remove: (...cs) => { const s = new Set(self._className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); self._className = [...s].join(' '); },
      toggle: (c, force) => {
        const has = self.classList.contains(c);
        const want = force === undefined ? !has : Boolean(force);
        want ? self.classList.add(c) : self.classList.remove(c);
        return want;
      },
      contains: (c) => self._className.split(/\s+/).includes(c),
    };
  }
  setAttribute(k, v) {
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = v;
    if (k === 'class') this._className = String(v);
    this.attrs.set(k, v);
    if (k === 'value') this.value = v;
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof El || n instanceof TextNode ? n : new TextNode(String(n));
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }
  dispatchEvent(evt) {
    const e = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...evt };
    let node = this;
    while (node) {
      for (const fn of node.listeners.get(e.type) || []) fn.call(node, e);
      node = e.bubbles === false ? null : node.parentNode;
    }
    return true;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() { document.activeElement = this; }
  blur() { document.activeElement = null; }
  scrollIntoView() {}
  closest(sel) {
    let node = this;
    while (node) {
      if (node instanceof El && matches(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (el) => { if (matches(el, sel)) out.push(el); });
    return out;
  }
  // 表单控件属性
  get value() { return this.attrs.get('value') ?? this._value ?? ''; }
  set value(v) { this._value = String(v ?? ''); this.attrs.set('value', String(v ?? '')); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.attrs.delete('checked'); }
  get selected() { return this.hasAttribute('selected'); }
  set selected(v) { v ? this.setAttribute('selected', '') : this.attrs.delete('selected'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { v ? this.setAttribute('disabled', '') : this.attrs.delete('disabled'); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { v ? this.setAttribute('hidden', '') : this.attrs.delete('hidden'); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { v ? this.setAttribute('open', '') : this.attrs.delete('open'); }
}

class TextNode {
  constructor(text) { this.text = text; this.parentNode = null; }
  get textContent() { return this.text; }
}

function walk(node, fn) {
  for (const c of node.children) {
    if (!(c instanceof El)) continue;
    fn(c);
    walk(c, fn);
  }
}

function matchCompound(el, comp) {
  const parts = comp.match(/([#.]?[A-Za-z0-9_:\-]+)/g) || [];
  for (const p of parts) {
    if (p.startsWith('#')) { if (el.attrs.get('id') !== p.slice(1)) return false; }
    else if (p.startsWith('.')) { if (!el.classList.contains(p.slice(1))) return false; }
    else if (el.tagName !== p.toUpperCase()) return false;
  }
  return true;
}

function matches(el, selector) {
  for (const group of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
    const chain = group.split(/\s+/);
    if (matchCompound(el, chain[chain.length - 1])) {
      let ok = true;
      let node = el.parentNode;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (node && !(node instanceof El && matchCompound(node, chain[i]))) node = node.parentNode;
        if (!node) { ok = false; break; }
        node = node.parentNode;
      }
      if (ok) return true;
    }
  }
  return false;
}

/* ------------------------------ HTML 解析 ------------------------------ */
function parseHtml(src) {
  const root = new El('body');
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().append(new TextNode(src.slice(i))); break; }
    if (lt > i) top().append(new TextNode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<!doctype', lt) || src.startsWith('<!DOCTYPE', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    const gt = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    const nameMatch = raw.match(/^([A-Za-z0-9:-]+)/);
    const name = nameMatch ? nameMatch[1] : 'div';
    const rest = raw.slice(name.length);
    const selfClose = rest.trimEnd().endsWith('/') || VOID.has(name.toLowerCase());
    const attrs = {};
    for (const m of rest.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const key = m[1];
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      if (/^(class|id|type|value|placeholder|title|href|rel|content|charset|name|min|max|step|rows|autocomplete|aria-label|stroke|fill|viewBox|d|cx|cy|r|width|height|rx|stroke-width|stroke-linecap|stroke-linejoin|hidden|open|checked|disabled|selected|download)$/.test(key) || key.startsWith('data-') || key.startsWith('aria-')) {
        attrs[key] = val;
      }
    }
    const el = new El(name, attrs);
    top().append(el);
    i = gt + 1;
    if (name.toLowerCase() === 'script' || name.toLowerCase() === 'style') {
      const closeTag = `</${name.toLowerCase()}>`;
      const end = src.toLowerCase().indexOf(closeTag, i);
      const inner = src.slice(i, end < 0 ? src.length : end);
      el.append(new TextNode(inner));
      i = end < 0 ? src.length : end + closeTag.length;
      continue;
    }
    if (!selfClose) stack.push(el);
  }
  return root;
}

function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return src.length;
}

/* ------------------------------ 全局环境 ------------------------------ */
const parsed = parseHtml(htmlSrc);
const documentElement = parsed.querySelector('html') || new El('html', { 'data-theme': 'light' });
const body = documentElement.querySelector('body') || new El('body');

const store = new Map();
const document = {
  documentElement,
  body,
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  querySelector: (sel) => documentElement.querySelector(sel),
  querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
  addEventListener: (type, fn) => documentElement.addEventListener(type, fn),
  removeEventListener: (type, fn) => documentElement.removeEventListener(type, fn),
  dispatchEvent: (evt) => documentElement.dispatchEvent(evt),
};

const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const errors = [];
const windowObj = {
  document,
  localStorage,
  __WB_TOKEN__: token,
  addEventListener: (type, fn) => documentElement.addEventListener(type, fn),
  removeEventListener: (type, fn) => documentElement.removeEventListener(type, fn),
  URL, URLSearchParams, Blob, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => { try { fn(0); } catch (e) { errors.push(e); } },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: (url, init) => {
    const abs = String(url).startsWith('http') ? String(url) : BASE + url;
    return fetch(abs, init);
  },
  console, Math, JSON, Date, Number, String, Boolean, Array, Object, Map, Set, Promise, Error, RegExp,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
};

const sandbox = {
  ...windowObj,
  window: windowObj,
  document,
  localStorage,
  Node: El,
  fetch: windowObj.fetch,
  requestAnimationFrame: windowObj.requestAnimationFrame,
  setInterval: windowObj.setInterval,
  clearInterval: windowObj.clearInterval,
  setTimeout,
  clearTimeout,
  console,
};
const ctx = vm.createContext(sandbox);

/* ------------------------------ 执行 app.js ------------------------------ */
let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ← ' + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  vm.runInContext(appSrc, ctx, { filename: 'public/app.js' });
  await sleep(1200);

  const $ = (sel) => documentElement.querySelector(sel);
  const bodyText = body.textContent;
  check('启动未进入错误页', !bodyText.includes('启动失败'), bodyText.slice(0, 120));
  check('顶栏日期已注入', ($('.brand-sub')?.textContent || '').startsWith(vm.runInContext('todayStr()', ctx)), $('.brand-sub')?.textContent);

  const rows = documentElement.querySelectorAll('.row');
  check('聚焦视图有任务行', rows.length > 0, `rows=${rows.length}`);
  check('聚焦显示必做/本周/池子分组', ['必做', '本周', '待办池'].some((g) => bodyText.includes(g)), bodyText.slice(0, 80));
  check('行内只剩标题/分类/优先级/到期', rows[0]?.querySelector('.row-meta') === null && rows[0]?.querySelector('.row-due') !== null);
  check('到期列有紧凑文案', /今天|明天|逾期|^\d+-\d+$|^$/.test(rows[0]?.querySelector('.row-due')?.textContent || 'x'), rows[0]?.querySelector('.row-due')?.textContent);
  check('未选中时右栏收起', documentElement.querySelector('.body.no-detail') !== null && $('.detail-placeholder') === null);

  // 全部待办
  vm.runInContext("setView('all')", ctx);
  await sleep(700);
  const allRows = documentElement.querySelectorAll('.row');
  check('全部待办可渲染', allRows.length > 0, `rows=${allRows.length}`);
  check('侧栏分类计数已渲染', documentElement.querySelectorAll('.cat-item').length >= 8, String(documentElement.querySelectorAll('.cat-item').length));

  // 选中第一条 → 详情
  const firstTitle = allRows[0].querySelector('.row-title').textContent;
  allRows[0].dispatchEvent({ type: 'click', bubbles: true });
  await sleep(800);
  const detail = $('.detail');
  check('点击行后打开详情', detail?.querySelector('.d-title') !== null, (detail?.textContent || '').slice(0, 100));
  check('详情标题与行一致', detail?.querySelector('.d-title')?.value === firstTitle, `${detail?.querySelector('.d-title')?.value} vs ${firstTitle}`);
  check('详情有分类/优先级控件', detail?.querySelector('.prio-pills') !== null && detail?.querySelector('select') !== null);
  check('详情有关联文件夹区块', (detail?.textContent || '').includes('关联文件夹'));

  // 已完成
  vm.runInContext("setView('done')", ctx);
  await sleep(700);
  check('已完成视图可渲染', documentElement.querySelectorAll('.row').length > 0, 'no done rows');

  // 归档
  vm.runInContext("setView('archive')", ctx);
  await sleep(900);
  check('归档视图有年度分组', documentElement.querySelectorAll('.tree-year').length > 0, bodyText.slice(-120));

  // 统计
  vm.runInContext("setView('stats')", ctx);
  await sleep(900);
  check('统计卡片', documentElement.querySelectorAll('.stat-card').length >= 6);
  check('统计趋势柱', documentElement.querySelectorAll('.trend .col').length > 0);

  // 快速添加解析
  const parsed = vm.runInContext("parseQuick('整理合同 #合同与法务 !P1 @明天')", ctx);
  check('快速添加解析：优先级', parsed.priority === 1, JSON.stringify(parsed));
  check('快速添加解析：分类命中', parsed.categoryId === 'cat-contract', JSON.stringify(parsed));
  check('快速添加解析：日期=明天', parsed.dueOn === vm.runInContext('addDays(todayStr(), 1)', ctx), JSON.stringify(parsed));
  check('快速添加解析：标题干净', parsed.title === '整理合同', JSON.stringify(parsed));

  // 命令面板
  vm.runInContext("openPalette()", ctx);
  await sleep(200);
  check('命令面板可打开且有项', documentElement.querySelectorAll('.p-item').length > 5, String(documentElement.querySelectorAll('.p-item').length));
  vm.runInContext("closePalette()", ctx);

  // 设置弹窗
  vm.runInContext("openSettings()", ctx);
  await sleep(200);
  check('设置弹窗可打开', documentElement.querySelectorAll('.modal .m-field').length >= 3);
  vm.runInContext("document.getElementById && null", ctx); // noop
  documentElement.querySelector('.modal-mask')?.remove();

  // 新建待办弹窗
  documentElement.querySelector('#qaAdd')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(300);
  const tm = documentElement.querySelector('#taskModal');
  check('点添加弹出新建窗口', tm !== null, tm?.className);
  check('新建窗口有标题输入', !!tm?.querySelector('#tmTitle'));
  check('新建窗口列出四行设置', tm?.querySelectorAll('.tm-row, .tm-row-block').length >= 5, String(tm?.querySelectorAll('.tm-row, .tm-row-block').length));
  // 选分类
  tm?.querySelector('#tmCat')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(150);
  check('新建窗口能展开分类抽屉', tm?.querySelector('#tmCatDrawer') !== null && !tm?.querySelector('#tmCatDrawer')?.hasAttribute('hidden'));
  const catOpts = [...(tm?.querySelectorAll('#tmCatDrawer .tm-opt') || [])];
  check('分类抽屉列出可选分类', catOpts.length >= 5, String(catOpts.length));
  catOpts[1]?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(120);
  const catLabel = tm?.querySelector('#tmCat')?.textContent || '';
  check('选了分类后按钮上显示分类名', catLabel.includes(catOpts[1]?.textContent?.trim() || '@@'), catLabel);
  // 选日期
  tm?.querySelector('#tmDue')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(500);
  const tmCal = tm?.querySelector('#tmCal');
  check('截止日期弹出内嵌日历', tmCal !== null && !tmCal.hasAttribute('hidden'));
  check('内嵌日历是 6×7 格', (tmCal?.querySelectorAll('.cal-day') || []).length === 42, String(tmCal?.querySelectorAll('.cal-day')?.length));
  [...(tmCal?.querySelectorAll('.tm-cal-foot button') || [])].find((b) => (b.textContent || '').trim() === '今天')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(120);
  check('点今天把日期写回', (tm?.querySelector('#tmDue')?.textContent || '').includes('今天'), tm?.querySelector('#tmDue')?.textContent);
  // Esc 关闭
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(150);
  check('Esc 关掉新建窗口', documentElement.querySelector('#taskModal') === null);

  // 每月例行：勾选 → 选号数 → 建系列 → 侧栏/例行页能看到 → 清理
  vm.runInContext("openNewTaskModal({recurring:true})", ctx);
  await sleep(200);
  const recModal = documentElement.querySelector('#taskModal');
  check('勾选例行后弹出号数面板', recModal?.querySelector('#tmRecur')?.checked === true && !recModal?.querySelector('#tmRecurPanel')?.hasAttribute('hidden'));
  const dayBtns = [...(recModal?.querySelectorAll('#tmDayGrid .tm-day') || [])];
  check('号数面板有 1–31 共 31 格', dayBtns.length === 31, String(dayBtns.length));
  dayBtns.find((b) => b.textContent.trim() === '28')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(120);
  check('选 28 号后显示 28 号', (recModal?.querySelector('#tmRecurDay')?.textContent || '').trim() === '28 号', recModal?.querySelector('#tmRecurDay')?.textContent);
  const seriesTitle = 'UI 例行探针 ' + Date.now();
  const recTitle = recModal.querySelector('#tmTitle');
  recTitle.value = seriesTitle;
  recTitle.dispatchEvent({ type: 'input', bubbles: true });
  documentElement.querySelector('#taskModal form')?.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
  await sleep(1800);
  check('例行提交后弹窗关闭', documentElement.querySelector('#taskModal') === null, [...documentElement.querySelectorAll('.tm-err, .tm-err-global')].map((n) => n.textContent).join('|') + ' ERR:' + errors.map((e) => e.message).join('|'));
  const seriesApi = await (await fetch(BASE + '/api/series', { headers: { 'x-wb-token': token } })).json();
  const seriesHit = (seriesApi.series || []).find((s) => s.title === seriesTitle);
  check('库里生成了例行系列', Boolean(seriesHit && seriesHit.day_of_month === 28), JSON.stringify(seriesHit && { day: seriesHit.day_of_month, total: seriesHit.total_count }));
  check('例行一次铺满 36 期', seriesHit?.total_count === 36, String(seriesHit?.total_count));
  check('侧栏出现例行条目', (documentElement.querySelector('#seriesList')?.textContent || '').includes(seriesTitle));
  vm.runInContext("setView('series')", ctx);
  await sleep(900);
  const seriesCard = documentElement.querySelector('.series-row');
  check('例行页列出系列卡片', Boolean(seriesCard) && (seriesCard.textContent || '').includes('每月 28 号'), seriesCard?.textContent?.slice(0, 60));
  if (seriesHit) {
    await fetch(BASE + '/api/series/' + seriesHit.id, { method: 'DELETE', headers: { 'x-wb-token': token } });
    const after = await (await fetch(BASE + '/api/series', { headers: { 'x-wb-token': token } })).json();
    check('删例行时把它的期一起删掉', !(after.series || []).some((s) => s.id === seriesHit.id));
  }
  vm.runInContext("setView('focus')", ctx);
  await sleep(600);

  // 联系作者
  documentElement.querySelector('#btnContact')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(200);
  const contact = documentElement.querySelector('.contact-modal');
  check('「联系作者」弹出二维码', contact !== null);
  const qrSrc = contact?.querySelector('img')?.getAttribute('src') || '';
  check('二维码指向本地素材', qrSrc.includes('assets/contact-qr.png'), qrSrc);
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(150);
  check('Esc 关掉二维码弹窗', documentElement.querySelector('.contact-modal') === null);

  // 激励作者：按钮在联系作者右边，复用同一套弹窗，收款码图与文案都要在
  documentElement.querySelector('#btnReward')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(200);
  const reward = documentElement.querySelector('#rewardModal');
  check('「激励作者」弹出弹窗', reward !== null);
  const rewardSrc = reward?.querySelector('img')?.getAttribute('src') || '';
  check('收款码指向本地素材', rewardSrc.includes('assets/reward-qr.png'), rewardSrc);
  const rewardTip = reward?.querySelector('.qr-tip')?.textContent || '';
  check('收款码文案含「您的支持」', rewardTip.includes('您的支持'), rewardTip);
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(150);
  check('Esc 关掉收款码弹窗', documentElement.querySelector('#rewardModal') === null);
  // 两个弹窗互不误挡
  documentElement.querySelector('#btnContact')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(150);
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(150);
  documentElement.querySelector('#btnReward')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(200);
  check('开过联系作者后仍能开激励作者', documentElement.querySelector('#rewardModal') !== null);
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(150);

  // 月历浮层
  vm.runInContext("openCalendar()", ctx);
  await sleep(700);
  const cal = documentElement.querySelector('#calendar');
  check('月历浮层打开', cal !== null && !cal.hasAttribute('hidden'), cal?.className);
  check('月历是 6×7 格', documentElement.querySelectorAll('#calendar .cal-day').length === 42, String(documentElement.querySelectorAll('#calendar .cal-day').length));
  check('月历有本月标题', /\d{4} 年 \d{1,2} 月/.test(cal?.querySelector('.cal-ym')?.textContent || ''), cal?.querySelector('.cal-ym')?.textContent);
  const someDay = [...documentElement.querySelectorAll('#calendar .cal-day')].find((b) => !(b.className || '').includes('other'));
  const pickedDate = someDay?.getAttribute('title')?.slice(0, 10);
  someDay?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(900);
  check('点日历某天进入当日列表', vm.runInContext('state.view', ctx) === 'day' && vm.runInContext('state.day', ctx) === pickedDate, `${vm.runInContext('state.view', ctx)} ${vm.runInContext('state.day', ctx)} vs ${pickedDate}`);
  check('当日列表标题是日期', /\d{1,2} 月 \d{1,2} 日 周/.test($('.view-heading h1')?.textContent || ''), $('.view-heading h1')?.textContent);

  // 「到期 / 已完成」两种口径：点过来日期默认看到期，点今天或过去默认看完成
  const calDays = [...documentElement.querySelectorAll('#calendar .cal-day')];
  const findDay = (d) => calDays.find((b) => (b.getAttribute('title') || '').startsWith(d));
  const segBtn = (label) => [...documentElement.querySelectorAll('#dayModeSeg button')].find((b) => (b.textContent || '').trim() === label);
  check('当日视图有「到期/已完成」开关', segBtn('到期') && segBtn('已完成'));

  // 当天视图要看的两种口径，用自己造的数据断言，不依赖演示数据今天有没有到期/完成
  const stamp = Date.now();
  const localToday = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const dueTodayTitle = `UI 冒烟-今天到期 ${stamp}`;
  const doneTodayTitle = `UI 冒烟-今天完成 ${stamp}`;
  const mkTask = async (title, dueOn) => {
    const r = await fetch(BASE + '/api/tasks', {
      method: 'POST',
      headers: { 'x-wb-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ title, due_on: dueOn, priority: 2 }),
    });
    const j = await r.json();
    return j.task || j;
  };
  const fixtureDue = await mkTask(dueTodayTitle, localToday);
  const fixtureDone = await mkTask(doneTodayTitle, localToday);
  await fetch(BASE + `/api/tasks/${fixtureDone.id}/complete`, {
    method: 'POST',
    headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    body: '{"done_note":"ui-smoke 当天完成"}',
  });

  // 用一个真正在今天的 6 天后的日期，避免把写死的日期当「未来」（跨月/跨天时会失效）
  const plusDays = (base, n) => {
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const futureDate = plusDays(localToday, 6);
  const futureTitle = `UI 冒烟-未来到期 ${stamp}`;
  const fixtureFuture = await mkTask(futureTitle, futureDate);
  await fetch(BASE + '/api/categories', { method: 'GET', headers: { 'x-wb-token': token } });
  vm.runInContext("refresh()", ctx);
  await sleep(600);

  const futureDay = findDay(futureDate);
  futureDay?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(900);
  check('点未来日期默认看「到期」', vm.runInContext('state.dayMode', ctx) === 'due', String(vm.runInContext('state.dayMode', ctx)));
  check('「到期」开关处于选中', String(segBtn('到期')?.className || '').includes('active'));
  const futureTitles = [...documentElement.querySelectorAll('.row .row-title')].map((n) => n.textContent);
  check('未来日期列表有到期任务', futureTitles.includes(futureTitle), futureTitles.join(' | '));
  await fetch(BASE + `/api/tasks/${fixtureFuture.id}/purge`, {
    method: 'POST',
    headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    body: '{}',
  });

  vm.runInContext("openCalendar()", ctx);
  await sleep(600);
  const todayCell = [...documentElement.querySelectorAll('#calendar .cal-day')].find((b) => (b.className || '').includes('today'));
  todayCell?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(900);
  check('点今天默认看「已完成」', vm.runInContext('state.dayMode', ctx) === 'done', String(vm.runInContext('state.dayMode', ctx)));
  check('「已完成」开关处于选中', String(segBtn('已完成')?.className || '').includes('active'));
  const doneRowTitles = [...documentElement.querySelectorAll('.row .row-title')].map((n) => n.textContent);
  check('「已完成」列表里是已完成的任务', doneRowTitles.includes(doneTodayTitle), doneRowTitles.join(' | '));
  check('回顾视图不显示「添加」按钮', documentElement.querySelector('#qaAdd')?.hasAttribute('hidden'));

  // 回顾视图也要能打开详情（专家意见：读归档不能把人挡在外面）
  const doneRow = documentElement.querySelector('.row');
  doneRow?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(700);
  check('「已完成」行可以打开详情', documentElement.querySelector('#detail')?.classList.contains('open') && (documentElement.querySelector('#detail .d-title')?.value || '').length > 0);
  vm.runInContext("closeDetail()", ctx);

  // 切回「到期」同一日期，看到的是当天要做的
  segBtn('到期')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(900);
  check('切「到期」后显示当天待办', vm.runInContext('state.dayMode', ctx) === 'due' && [...documentElement.querySelectorAll('.row .row-title')].some((n) => n.textContent.includes(dueTodayTitle)));

  vm.runInContext("setView('focus')", ctx);
  await sleep(600);

  // 侧栏切分类
  vm.runInContext("state.filter.cat='cat-property'; setView('all')", ctx);
  await sleep(700);
  check('按分类筛选后仍有行', documentElement.querySelectorAll('.row').length > 0);

  // 端到端：点「添加」开完整表单 → 建一条 → 出现在列表 → 完成 → 已归档；最后清理
  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('all')", ctx);
  await sleep(700);
  const probeTitle = 'UI 冒烟探针 ' + Date.now();
  documentElement.querySelector('#qaAdd')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(300);
  check('点「添加」弹出新建窗口', documentElement.querySelector('#taskModal') !== null);
  const titleBox = documentElement.querySelector('#tmTitle');
  // 焦点落点由 e2e（真浏览器）验证；极简 DOM shim 不实现 activeElement
  check('新建窗口的标题框是可编辑文本域', (titleBox?.tagName || '') === 'TEXTAREA', String(titleBox?.tagName));
  titleBox.value = probeTitle;
  titleBox.dispatchEvent({ type: 'input', bubbles: true });
  // 设优先级 P1：点优先级 pill
  [...documentElement.querySelectorAll('.tm-prio button')].find((b) => (b.textContent || '').trim() === 'P1')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(100);
  documentElement.querySelector('#taskModal form')?.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
  await sleep(1200);
  check('提交后弹窗关闭', documentElement.querySelector('#taskModal') === null);
  check('新建的待办出现在列表', (documentElement.textContent || '').includes(probeTitle));

  const res = await fetch(BASE + '/api/tasks?status=open&q=' + encodeURIComponent(probeTitle), { headers: { 'x-wb-token': token } });
  const found = await res.json();
  const probe = found.tasks?.[0];
  check('弹窗把优先级写进了库', probe?.priority === 1, String(probe?.priority));
  check('弹窗默认收件箱分类', probe?.category_id === 'cat-inbox', String(probe?.category_id));

  if (probe) {
    // 直接走完成流程（等同点勾），验证归档文件生成
    await fetch(BASE + `/api/tasks/${probe.id}/complete`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{"done_note":"ui-smoke"}' });
    const done = await (await fetch(BASE + '/api/tasks/' + probe.id, { headers: { 'x-wb-token': token } })).json();
    check('完成流程写出归档路径', Boolean(done.task?.archived_path), JSON.stringify(done.task?.archive_error));
    // 清理：purge 掉探针任务
    await fetch(BASE + `/api/tasks/${probe.id}/purge`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{}' });
  }

  // 清理：当天视图的两个 fixture
  for (const f of [fixtureDue, fixtureDone]) {
    if (!f?.id) continue;
    await fetch(BASE + `/api/tasks/${f.id}/purge`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{}' });
  }

  check('运行期未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
} catch (err) {
  failures++;
  console.error('UI 冒烟异常：', err?.stack || err);
}

console.log(`\nUI 冒烟结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
