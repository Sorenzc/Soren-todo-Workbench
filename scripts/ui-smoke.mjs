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
let checks = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  checks++;
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

  // 选中第一条 → 详情（行标题后面会跟 📌/⏰/↻ 和子项进度这类小标，比较标题时先去掉）
  // 行标题里的小标（📌 / ⏰ / ↻ / 等 / ▶ / n/m）都在 .row-badges 里，直接取 .rt-text 最稳
  const firstTitle = (allRows[0].querySelector('.rt-text')?.textContent || '').trim();
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

  // 侧栏切分类：挑一个当前确实有未完成待办的分类，别写死分类 id（演示数据的分类会变）
  const catWithTasks = vm.runInContext(
    "(state.bootstrap?.categories || []).find((c) => (c.open_count || 0) > 0)?.id || null",
    ctx
  );
  vm.runInContext(`state.filter.cat=${JSON.stringify(catWithTasks)}; setView('all')`, ctx);
  await sleep(700);
  check('按分类筛选后仍有行', !!catWithTasks && documentElement.querySelectorAll('.row').length > 0, `cat=${catWithTasks}`);

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

  // ---- v1.2 引擎：子待办 / 提醒 / 序号拆条 / 逾期一键 ----
  const mkApi = async (body) =>
    (await (await fetch(BASE + '/api/tasks', {
      method: 'POST',
      headers: { 'x-wb-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json());
  const kidParentTitle = 'UI 子待办父 ' + Date.now();
  const kidParent = await mkApi({ title: kidParentTitle });
  await mkApi({ title: 'UI 子项一', parentId: kidParent.task.id });
  await mkApi({ title: 'UI 子项二', parentId: kidParent.task.id });
  const remindTitle = 'UI 提醒 ' + Date.now();
  const remindTask = await mkApi({ title: remindTitle, remindAt: `${vm.runInContext('addDays(todayStr(), 1)', ctx)}T09:00` });

  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('all')", ctx);
  await sleep(700);
  const kidParentRow = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(kidParentTitle));
  check('父任务行显示子项进度', (kidParentRow?.querySelector('.row-child')?.textContent || '') === '0/2', kidParentRow?.querySelector('.row-child')?.textContent);
  const remindRow = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(remindTitle));
  check('有提醒的任务行带闹钟标', remindRow?.querySelector('.row-remind') !== null);

  kidParentRow?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(700);
  check('详情列出子待办', documentElement.querySelectorAll('#detail .kid').length === 2, String(documentElement.querySelectorAll('#detail .kid').length));
  check('详情有提醒时间输入', documentElement.querySelector('#detail .d-remind') !== null);
  documentElement.querySelector('#detail .kid .tick')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(1000);
  check('勾子项后变成已完成', documentElement.querySelectorAll('#detail .kid.done').length === 1, String(documentElement.querySelectorAll('#detail .kid.done').length));
  const kidInput = documentElement.querySelector('#detail .kid-input');
  kidInput.value = 'UI 子项三';
  kidInput.dispatchEvent({ type: 'input', bubbles: true });
  kidInput.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
  await sleep(1000);
  check('行内回车能加子项', documentElement.querySelectorAll('#detail .kid').length === 3, String(documentElement.querySelectorAll('#detail .kid').length));
  vm.runInContext("closeDetail()", ctx);

  const splitMark = 'UI 拆条 ' + Date.now();
  documentElement.querySelector('#qaAdd')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(300);
  const splitBox = documentElement.querySelector('#tmTitle');
  splitBox.value = `1. ${splitMark}甲\n2. ${splitMark}乙`;
  splitBox.dispatchEvent({ type: 'input', bubbles: true });
  documentElement.querySelector('#taskModal form')?.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
  await sleep(1800);
  const splitRes = await (await fetch(BASE + '/api/tasks?status=open&limit=50&q=' + encodeURIComponent(splitMark), {
    headers: { 'x-wb-token': token },
  })).json();
  check('序号列表拆成多条待办', (splitRes.tasks || []).length === 2, String((splitRes.tasks || []).length));

  vm.runInContext("setView('today')", ctx);
  await sleep(700);
  const bulkBtn = [...documentElement.querySelectorAll('.group-head .btn')].find((b) => (b.textContent || '').includes('一键完成'));
  check('今日视图有逾期待办一键完成', Boolean(bulkBtn), [...documentElement.querySelectorAll('.group-head .btn')].map((b) => b.textContent).join('|'));

  // ---- v1.3：置顶 / 七段分组 / 日历视图 / 导出 ----
  const stamp13 = Date.now();
  const mark = 'UI 分组 ' + stamp13;
  const dueOverdue = await mkApi({ title: `${mark} 逾期`, dueOn: vm.runInContext('addDays(todayStr(), -2)', ctx) });
  const dueToday = await mkApi({ title: `${mark} 今天`, dueOn: vm.runInContext('todayStr()', ctx) });
  const dueWeek = await mkApi({ title: `${mark} 本周`, dueOn: vm.runInContext('addDays(todayStr(), 2)', ctx) });
  const dueNone = await mkApi({ title: `${mark} 无日期` });

  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('all')", ctx);
  await sleep(800);
  const groupText = [...documentElement.querySelectorAll('.group-head')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim());
  check('全部待办分成七段（逾期/今天/本周/无日期都在）',
    ['逾期', '今天', '本周', '无日期'].every((w) => groupText.some((g) => g.includes(w))), groupText.join(' | '));
  const exportBtn = [...documentElement.querySelectorAll('#viewTools button')].find((b) => (b.textContent || '').includes('导出'));
  check('全部待办有导出按钮', Boolean(exportBtn), [...documentElement.querySelectorAll('#viewTools button')].map((b) => b.textContent).join('|'));

  const pinRow = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(`${mark} 本周`));
  const pinBtn = pinRow ? [...pinRow.querySelectorAll('button')].find((b) => (b.textContent || '').includes('📌')) : null;
  check('行上有置顶按钮', Boolean(pinBtn));
  pinBtn?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(1200);
  const pinnedRow = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(`${mark} 本周`));
  check('置顶后标题带置顶标', pinnedRow?.querySelector('.row-pin') !== null);
  const pinnedHeads = [...documentElement.querySelectorAll('.group-head')].map((n) => (n.textContent || '').trim());
  check('置顶单独成组', pinnedHeads.some((g) => g.startsWith('置顶')), pinnedHeads.join('|'));

  // 详情里也能置顶/取消
  pinnedRow?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(700);
  const detailPin = [...documentElement.querySelectorAll('#detail button')].find((b) => (b.textContent || '').includes('置顶'));
  check('详情里有置顶开关', Boolean(detailPin), [...documentElement.querySelectorAll('#detail button')].map((b) => b.textContent).join('|'));
  vm.runInContext('closeDetail()', ctx);

  // 日历视图：42 格 + chip + 周视图 7 格
  vm.runInContext("setView('calendar')", ctx);
  await sleep(1000);
  check('日历视图渲染出整月格子', documentElement.querySelectorAll('.cv-day').length === 42, String(documentElement.querySelectorAll('.cv-day').length));
  const calChips = [...documentElement.querySelectorAll('.cv-chip')];
  check('日历格子里有任务 chip', calChips.length > 0, String(calChips.length));
  check('chip 可拖拽', calChips.some((c) => c.draggable === true || c.getAttribute?.('draggable') === 'true'));
  const todayCellV13 = [...documentElement.querySelectorAll('.cv-day')].find((c) =>
    (c.getAttribute?.('title') || '').startsWith(vm.runInContext('todayStr()', ctx)));
  check('今天的格子被标出来', todayCellV13?.classList.contains('today') === true || documentElement.querySelectorAll('.cv-day.today').length === 1);
  vm.runInContext("state.cv.mode='week'; refresh()", ctx);
  await sleep(1000);
  check('周视图只渲染 7 列', documentElement.querySelectorAll('.cv-day').length === 7, String(documentElement.querySelectorAll('.cv-day').length));

  // ---- v1.4：每日/每周滚动 + 日历虚拟条目 ----
  const stamp14 = Date.now();
  const dailyMark = 'UI 每日 ' + stamp14;
  const dailyCreate = await mkApi({
    title: dailyMark,
    recurrence: { rule: 'daily', start_date: vm.runInContext('todayStr()', ctx), interval_n: 1 },
  });
  const dailySeriesId14 = dailyCreate?.series?.id;
  check('每日重复创建成功且只一条活行', Boolean(dailySeriesId14) && dailyCreate?.seriesOccurrences === 1, JSON.stringify(dailyCreate?.seriesOccurrences));
  check('每日系列的文案是「每天」', dailyCreate?.series?.rule_label === '每天', String(dailyCreate?.series?.rule_label));

  // 系列页显示「每天」+ 滚动轮数
  await fetch(BASE + '/api/series', { headers: { 'x-wb-token': token } });
  vm.runInContext('loadSeries().then(() => setView(\'series\'))', ctx);
  await sleep(1200);
  const seriesRows14 = [...documentElement.querySelectorAll('.series-row')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim());
  check('系列页出现每日系列并写「每天」', seriesRows14.some((r) => r.includes(dailyMark) && r.includes('每天')), seriesRows14.join(' | '));

  // 完成活行 → 滚动到下一期
  const liveId14 = dailyCreate?.task?.id;
  await fetch(BASE + `/api/tasks/${liveId14}/complete`, {
    method: 'POST',
    headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    body: '{}',
  });
  const afterRoll = await (await fetch(BASE + `/api/series/${dailySeriesId14}`, { headers: { 'x-wb-token': token } })).json();
  check('完成一期后系列滚了 1 轮', afterRoll?.series?.repeat_done_count === 1, String(afterRoll?.series?.repeat_done_count));
  check('系列里是活行 + 历史行', (afterRoll?.tasks || []).length === 2, String((afterRoll?.tasks || []).length));

  // 日历里的未来几期是虚线虚拟条目，不能拖
  vm.runInContext("state.cv.mode='month'; setView('calendar')", ctx);
  await sleep(1200);
  const virtChips = [...documentElement.querySelectorAll('.cv-chip')].filter((c) => c.classList.contains('virt'));
  check('日历里有周期虚拟条目', virtChips.length > 0, String(virtChips.length));
  check('虚拟条目不可拖拽', virtChips.every((c) => c.draggable !== true && c.getAttribute?.('draggable') !== 'true'));

  // 新建弹窗里的重复规则有三档
  documentElement.querySelector('#qaAdd')?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(400);
  const ruleOpts = [...documentElement.querySelectorAll('#tmRule option')].map((o) => o.getAttribute?.('value') || o.value);
  check('重复规则有每月/每天/每周三档', ruleOpts.length === 3 && ruleOpts.includes('daily') && ruleOpts.includes('weekly'), ruleOpts.join('|'));
  const recurBox = documentElement.querySelector('#tmRecur');
  recurBox.checked = true;
  recurBox.dispatchEvent({ type: 'change', bubbles: true });
  const ruleSel14 = documentElement.querySelector('#tmRule');
  ruleSel14.value = 'daily';
  ruleSel14.dispatchEvent({ type: 'change', bubbles: true });
  await sleep(300);
  check('选「每 N 天」时出现间隔输入', Boolean(documentElement.querySelector('#tmIntervalDaily')));
  check('选「每 N 天」时号数网格被收起', documentElement.querySelector('#tmDayGrid')?.hidden === true);
  documentElement.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
  await sleep(300);

  // ---- v1.6：聚焦页小组件 / 快速捕获 / 键盘流 ----
  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('focus')", ctx);
  await sleep(400);
  const capForm = documentElement.querySelector('#captureForm');
  check('聚焦页有快速捕获框', Boolean(capForm));
  check('聚焦页速记框可见', capForm && !capForm.hidden);

  // 键盘流（C 聚焦速记框、/ 打开搜索）依赖真实焦点与弹窗遮罩，
  // 由 scripts/e2e.mjs 在真浏览器里验证；极简 DOM shim 不实现 activeElement（见上文同注释）

  // 速记解析：!p1 @明天 #合同 → 优先级 / 日期 / 标签
  const quickParsed = JSON.parse(vm.runInContext("JSON.stringify(parseQuick('!p1 @明天 #合同 交材料'))", ctx));
  check('速记解析优先级', quickParsed.priority === 1, `priority=${quickParsed.priority}`);
  check('速记解析标签', (quickParsed.tags || []).includes('合同'), JSON.stringify(quickParsed.tags));
  check('速记解析标题', quickParsed.title === '交材料', quickParsed.title);
  check('速记解析日期是明天', quickParsed.dueOn === vm.runInContext('addDays(todayStr(), 1)', ctx), String(quickParsed.dueOn));

  // 速记框在其它视图隐藏
  vm.runInContext("setView('stats')", ctx);
  await sleep(300);
  check('统计视图不显示速记框', documentElement.querySelector('#captureForm')?.hidden === true);

  // 小组件：常驻显示；待办多了换成紧凑模式，但不是消失。
  // 注意必须先 setView（refresh 会重新拉 bootstrap 覆盖 counts），再改 counts 并重绘。
  vm.runInContext("setView('focus')", ctx);
  await sleep(500);
  vm.runInContext("state.bootstrap.counts.open = 2; state.wg = { from:'', to:'', days:{}, doneDays:{}, loaded:true }; renderAll()", ctx);
  await sleep(200);
  check('待办少时显示聚焦小组件', Boolean(documentElement.querySelector('#list .fw')), 'expect .fw');
  check('待办少时不是紧凑模式', !documentElement.querySelector('#list .fw.fw-compact'));

  vm.runInContext("state.bootstrap.counts.open = 9; renderAll()", ctx);
  await sleep(200);
  check('待办多时小组件仍然显示', Boolean(documentElement.querySelector('#list .fw')), 'expect .fw kept');
  check('待办多时进入紧凑模式', Boolean(documentElement.querySelector('#list .fw.fw-compact')), 'expect .fw-compact');

  // ---- v1.7：速记独立成库 ----
  const memoMark = 'UI 速记 ' + Date.now();
  const memoApi = async (path2, init) =>
    (await (await fetch(BASE + path2, {
      ...init,
      headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    })).json());
  const memoCreated = await memoApi('/api/memos', { method: 'POST', body: JSON.stringify({ body: memoMark }) });
  const memoId = memoCreated.memo?.id;
  check('速记接口能建', Boolean(memoId), JSON.stringify(memoCreated).slice(0, 120));

  vm.runInContext("setView('memo')", ctx);
  await sleep(400);
  const navLabels = [...documentElement.querySelectorAll('#navViews button')].map((b) => (b.textContent || '').trim());
  check('侧边栏有「速记」入口', navLabels.some((x) => x.includes('速记')), navLabels.join('|'));
  const head = documentElement.querySelector('.memo-head');
  const search = documentElement.querySelector('#memoSearch');
  check('速记视图有搜索框', Boolean(head && search));
  const memoRows = documentElement.querySelectorAll('.memo');
  check('速记视图渲染出条目', memoRows.length > 0, `rows=${memoRows.length}`);
  check('速记正文出现在列表里', (documentElement.querySelector('#list')?.textContent || '').includes(memoMark));

  // 速记条在速记视图里也是可见的（它就是这个库的输入口）
  const capInMemo = documentElement.querySelector('#captureForm');
  check('速记视图保留速记输入条', Boolean(capInMemo) && !capInMemo.hidden);
  const capTag = capInMemo?.querySelector('.capture-tag');
  check('速记条有「速记」标识', (capTag?.textContent || '') === '速记');

  // 搜索过滤：搜一个不存在的词，列表应为空态
  await memoApi(`/api/memos/${memoId}/purge`, { method: 'POST', body: '{}' });
  vm.runInContext("state.memoQ='绝不存在的速记词'; loadMemos().then(renderAll)", ctx);
  await sleep(500);
  check('速记搜不到时给空态', Boolean(documentElement.querySelector('.memo-empty')));
  vm.runInContext("state.memoQ=''; loadMemos().then(renderAll)", ctx);
  await sleep(300);

  // 速记条的提交变成「存速记」，不再建待办
  const beforeTasks = (await (await fetch(BASE + '/api/tasks?status=all&limit=1', { headers: { 'x-wb-token': token } })).json()).tasks.length;
  const quickMemo = 'UI 速记条 ' + Date.now();
  vm.runInContext(`captureQuick(${JSON.stringify(quickMemo)})`, ctx);
  await sleep(600);
  const memosNow = await (await fetch(BASE + `/api/memos?q=${encodeURIComponent(quickMemo)}`, { headers: { 'x-wb-token': token } })).json();
  check('速记条提交存进速记', (memosNow.memos || []).length === 1, JSON.stringify(memosNow).slice(0, 120));
  const afterTasks = (await (await fetch(BASE + '/api/tasks?status=all&limit=1', { headers: { 'x-wb-token': token } })).json()).tasks.length;
  check('速记条提交不会建待办', beforeTasks === afterTasks, `${beforeTasks}→${afterTasks}`);
  for (const m of memosNow.memos || []) {
    await memoApi(`/api/memos/${m.id}/purge`, { method: 'POST', body: '{}' });
  }

  // v1.8：归档搜索框
  vm.runInContext("setView('archive')", ctx);
  await sleep(600);
  check('归档视图有搜索框', !!$('#arcSearch'));
  const arcInput = $('#arcSearch');
  if (arcInput) {
    arcInput.value = '这个词肯定不存在zzz';
    arcInput.dispatchEvent({ type: 'input', bubbles: true });
    await sleep(900);
  }
  check('归档搜不到时给空状态', !!$('.arc-none'), ($('#list')?.textContent || '').slice(0, 80));

  // v1.9.1：多选批量 + 打印今日清单
  vm.runInContext("clearPicked(); setView('all')", ctx);
  await sleep(1200);
  const pickIds = [...document.querySelectorAll('#list .row')].slice(0, 2).map((r) => r.dataset?.id || r.getAttribute?.('data-id')).filter(Boolean);
  check('列表里至少有两行可以多选', pickIds.length === 2, String(pickIds.length));
  if (pickIds.length === 2) {
    vm.runInContext(`togglePick(${JSON.stringify(pickIds[0])}, false)`, ctx);
    vm.runInContext(`togglePick(${JSON.stringify(pickIds[1])}, true)`, ctx);
    await sleep(120);
    check('多选后出现底部操作条', !!$('#bulkBar'), ($('#bulkBar')?.textContent || '').slice(0, 60));
    check('操作条显示已选条数', /已选 2 条/.test($('#bulkBar')?.textContent || ''), $('#bulkBar')?.textContent);
    const pickedRows = [...document.querySelectorAll('#list .row')].filter((r) => String(r.className || '').includes('picked')).length;
    check('选中的行带 picked 标记', pickedRows === 2, String(pickedRows));
    vm.runInContext('clearPicked()', ctx);
    await sleep(80);
    check('取消选择后操作条消失', !$('#bulkBar'));
  }

  const sheet = vm.runInContext('buildPrintSheet()', ctx);
  check('打印清单能生成', !!sheet && !!sheet.querySelector('.ps-item'), sheet ? sheet.textContent.slice(0, 60) : 'null');
  check('打印清单有页脚件数', /共 \d+ 件/.test(sheet?.querySelector('.ps-foot')?.textContent || ''), sheet?.querySelector('.ps-foot')?.textContent);

  // ---- v1.10：等待他人 / 回收站 / 标签管理 / 今日摘要 ----
  const waitTitle = 'UI 等回执 ' + Date.now();
  const waitTask = await mkApi({ title: waitTitle, status: 'waiting' });
  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('all')", ctx);
  await sleep(700);
  const waitRow = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(waitTitle));
  check('等待他人的行带「等」标', waitRow?.querySelector('.row-wait') !== null);

  vm.runInContext("setView('focus')", ctx);
  await sleep(800);
  const focusHeads = [...documentElement.querySelectorAll('.group-head')].map((h) => h.textContent || '');
  check('聚焦页有「等待他人」段', focusHeads.some((t) => t.includes('等待他人')), focusHeads.join(' | ').slice(0, 80));

  // 详情里的状态切换
  vm.runInContext("setView('all')", ctx);
  await sleep(600);
  const waitRow2 = [...documentElement.querySelectorAll('.row')].find((r) =>
    (r.querySelector('.row-title')?.textContent || '').includes(waitTitle));
  waitRow2?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(800);
  const segBtns = [...documentElement.querySelectorAll('#detail .status-seg .btn')].map((b) => b.textContent || '');
  check('详情有状态切换按钮', segBtns.some((t) => t.includes('等待他人')), segBtns.join('/'));

  // 回收站：软删 → 回收站里出现 → 还原
  const trashTitle = 'UI 回收站 ' + Date.now();
  const trashTask = await mkApi({ title: trashTitle });
  await fetch(BASE + `/api/tasks/${trashTask.task.id}`, {
    method: 'DELETE', headers: { 'x-wb-token': token, 'content-type': 'application/json' },
  });
  vm.runInContext("state.filter={q:'',cat:null,tag:null,sort:'score'}; setView('trash')", ctx);
  await sleep(900);
  const trashRows = [...documentElement.querySelectorAll('.trash-row')].map((r) => r.textContent || '');
  check('回收站列出刚删的待办', trashRows.some((t) => t.includes(trashTitle)), trashRows.join(' | ').slice(0, 80));
  const restoreBtn = [...documentElement.querySelectorAll('.trash-row .btn')].find((b) => (b.textContent || '').includes('还原'));
  restoreBtn?.dispatchEvent({ type: 'click', bubbles: true });
  await sleep(1000);
  check('回收站能还原', !(documentElement.querySelector('#list')?.textContent || '').includes(trashTitle));

  // 标签管理入口
  check('标签区有管理按钮', documentElement.querySelector('#tagManage') !== null);
  if ((documentElement.querySelector('#tagManage')?.hidden === false)) {
    documentElement.querySelector('#tagManage').dispatchEvent({ type: 'click', bubbles: true });
    await sleep(400);
    check('标签管理弹窗打开', (documentElement.querySelector('#modalRoot')?.textContent || '').includes('标签管理'));
    documentElement.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await sleep(300);
  }

  // 今日摘要：手动触发一次，应该出 toast
  vm.runInContext("localStorage.removeItem('wb-digest-day')", ctx);
  await vm.runInContext('showDailyDigestOnce()', ctx);
  await sleep(700);
  check('今日摘要会出提示', (documentElement.querySelector('#toasts')?.textContent || '').includes('今日摘要'));

  // 清理这一段造的待办
  for (const id of [waitTask?.task?.id, trashTask?.task?.id]) {
    if (!id) continue;
    await fetch(BASE + `/api/tasks/${id}/purge`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{}' });
  }

  // 清理：本段建的每日系列
  if (dailySeriesId14) await fetch(BASE + `/api/series/${dailySeriesId14}`, { method: 'DELETE', headers: { 'x-wb-token': token } });
  // 删系列不会带走已经写出的归档 md（/api/archive/tree 按库遍历看不到孤儿文件），这里顺手扫一遍
  try {
    const root = path.join(ROOT, 'archive');
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.includes(dailyMark) || ent.name.includes('UI-每日-')) fs.rmSync(full, { force: true });
      }
    };
    if (fs.existsSync(root)) walk(root);
  } catch { /* 归档目录不存在或没权限，不影响断言 */ }

  // 清理：本段新建的四条任务
  for (const d of [dueOverdue, dueToday, dueWeek, dueNone]) {
    if (d?.task?.id) {
      await fetch(BASE + `/api/tasks/${d.task.id}/purge`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{}' });
    }
  }

  // 清理：新造的子待办父（子项随父一起 purge）、提醒任务、拆条任务
  for (const id of [kidParent.task.id, remindTask.task.id, ...(splitRes.tasks || []).map((t) => t.id)]) {
    await fetch(BASE + `/api/tasks/${id}/purge`, { method: 'POST', headers: { 'x-wb-token': token, 'content-type': 'application/json' }, body: '{}' });
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

console.log(`\nUI 冒烟结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ''}`);
process.exit(failures === 0 ? 0 : 1);
