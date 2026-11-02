// 演示数据：给界面自查/截图用的一组真实感数据（只写入本地库，可随时清空 data 目录重来）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.WB_URL || 'http://127.0.0.1:7871';
const token = fs.readFileSync(path.join(root, 'data', 'token.txt'), 'utf8').trim();

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(j)}`);
  return j;
}

const today = (await call('GET', '/api/bootstrap')).today;
const d = (n) => {
  const t = new Date(today + 'T00:00:00');
  t.setDate(t.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const seeds = [
  { title: '确认 A 座消防年检整改回执并归档', category: 'cat-property', priority: 1, due_on: d(-2), tags: ['消防', '合规'], notes: '## 背景\n消防维保单位 10-15 提交整改单，需要物业盖章回执。\n\n## 待确认\n- 整改照片是否齐全\n- 回执抬头写公司还是项目' },
  { title: '把《会议室使用管理办法》定稿发全员', category: 'cat-policy', priority: 0, due_on: d(0), tags: ['制度'] },
  { title: '与律所沟通 B 座租赁合同补充协议条款', category: 'cat-contract', priority: 1, due_on: d(1), tags: ['合同'], notes: '重点看第 7 条免责范围和免租期表述。' },
  { title: '月度例会材料：9 月能耗与费用对比', category: 'cat-meeting', priority: 2, due_on: d(3) },
  { title: '整理第三季度供应商评估表', category: 'cat-admin', priority: 2, due_on: d(5), tags: ['供应商'] },
  { title: '下周物业开放日的场地与物料清单', category: 'cat-property', priority: 2, due_on: d(7) },
  { title: '个人：体检预约', category: 'cat-personal', priority: 3, due_on: d(12) },
  { title: '梳理档案室历史合同电子化清单', category: 'cat-contract', priority: 1, due_on: null, tags: ['档案'] },
  { title: '更新应急预案联系人名单', category: 'cat-property', priority: 2, due_on: null },
  { title: '月度办公用品采购比价', category: 'cat-admin', priority: 3, due_on: d(20) },
];

const cats = (await call('GET', '/api/categories')).categories;
const byName = Object.fromEntries(cats.map((c) => [c.id, c]));

for (const s of seeds) {
  const r = await call('POST', '/api/tasks', {
    title: s.title,
    category_id: s.category,
    priority: s.priority,
    due_on: s.due_on,
    tags: s.tags,
    notes_md: s.notes,
  });
  // 给前两条关联文件夹，演示「查阅时调用」
  if (s.tags?.includes('消防')) {
    await call('POST', `/api/tasks/${r.task.id}/links`, {
      path: path.join(root, 'archive'),
      kind: 'folder',
      is_primary: true,
      label: '消防整改资料',
    });
  }
}

// 一条每月例行，给「例行」视图铺点底（会铺 36 期，只有本月/下月算待办）
await call('POST', '/api/tasks', {
  title: '每月 28 号提交月度总结',
  category_id: 'cat-admin',
  priority: 1,
  recurrence: { rule: 'monthly', day_of_month: 28, horizon_months: 36 },
});

// 一条已完成，给「已完成 / 归档」视图铺点底
const done = await call('POST', '/api/tasks', {
  title: '10 月物业交接会议纪要归档',
  category_id: 'cat-meeting',
  priority: 1,
  tags: ['会议'],
  notes_md: '参会：物业、工程、客服。\n\n决议：\n1. 交接清单 10/12 前确认\n2. 遗留问题由工程口对接',
});
await call('POST', `/api/tasks/${done.task.id}/complete`, { done_note: '纪要已发给参会人，纸质件归档到档案室。' });

console.log('演示数据已写入：', seeds.length + 1, '条 + 1 个每月例行');
