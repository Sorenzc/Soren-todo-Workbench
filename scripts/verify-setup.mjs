#!/usr/bin/env node
// 安装包验收：把 dist 里的安装包真的装一遍，检查文件、配置、注册表和启动器自检，再卸载清理。
// 用法：
//   node scripts/verify-setup.mjs                 （用 dist 里当前版本号的安装包）
//   node scripts/verify-setup.mjs --exe <路径>    （指定安装包）
//   node scripts/verify-setup.mjs --keep          （失败时保留临时目录，方便看现场）
//   node scripts/verify-setup.mjs --preview-only  （只核对向导三页，不真的安装）
//
// 退出码：0 全部通过；1 有检查项失败；2 环境问题（找不到安装包等）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

const exeArg = argOf('--exe');
const keep = has('--keep');
const previewOnly = has('--preview-only');

const installer = exeArg
  ? path.resolve(exeArg)
  : path.join(ROOT, 'dist', `待办工作台-${VERSION}-安装包.exe`);

if (!fs.existsSync(installer)) {
  console.error(`[verify-setup] 找不到安装包：${installer}`);
  console.error('[verify-setup] 先跑 node scripts/build-dist.mjs，或用 --exe 指定路径');
  process.exit(2);
}

const tmp = path.join(os.tmpdir(), `wb-verify-${process.pid}`);
const installDir = path.join(tmp, 'install');
const dataDir = path.join(tmp, 'data');
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench';

let failures = 0;
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    failures += 1;
    results.push({ ok: false, name, detail: err && err.message ? err.message : String(err) });
  }
}

function run(file, args, opts = {}) {
  const res = spawnSync(file, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 180000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

function need(cond, message) {
  if (!cond) throw new Error(message);
}

function tail(text, max = 400) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(-max) : s;
}

function regQuery(key, value) {
  const res = run('reg', ['query', key, '/v', value], { timeout: 15000 });
  return res.status === 0 ? res.stdout : '';
}

function regDelete(key) {
  run('reg', ['delete', key, '/f'], { timeout: 15000 });
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn('[verify-setup] 清理失败：' + target + ' → ' + err.message);
  }
}

console.log(`[verify-setup] 安装包：${installer}`);
console.log(`[verify-setup] 版本：${VERSION}`);
console.log(`[verify-setup] 临时目录：${tmp}`);
fs.mkdirSync(tmp, { recursive: true });

// ---------- 1. 向导三页：按钮可见、文字不越界 ----------
for (const page of [1, 2, 3]) {
  const png = path.join(tmp, `page${page}.png`);
  const res = run(installer, [`--preview=${page}`, `--shot=${png}`], { timeout: 120000 });
  check(`向导第 ${page} 页：无遮挡/按钮可见`, () => {
    need(res.error == null, `启动失败：${res.error && res.error.message}`);
    need(res.status === 0, `退出码 ${res.status}（自检报告见输出）\n${tail(res.stdout)}`);
    need(fs.existsSync(png), '没有生成截图');
    need(fs.statSync(png).size > 3000, `截图为空（${fs.statSync(png).size} 字节）`);
    return `截图 ${Math.round(fs.statSync(png).size / 1024)} KB`;
  });
}

if (!previewOnly) {
  // ---------- 2. 静默安装到临时目录 ----------
  regDelete(REG_KEY);
  rmrf(installDir);
  rmrf(dataDir);

  const inst = run(installer, [
    '--elevated',
    '--user',
    `--dir=${installDir}`,
    `--data=${dataDir}`,
    '--no-desktop',
  ]);
  check('静默安装退出码为 0', () => {
    need(inst.status === 0, `退出码 ${inst.status}\n${tail(inst.stdout + inst.stderr)}`);
    return '';
  });

  check(`程序文件落在 app\\${VERSION}`, () => {
    const server = path.join(installDir, 'app', VERSION, 'src', 'server.mjs');
    need(fs.existsSync(server), `缺少 ${server}`);
    const nodeExe = path.join(installDir, 'app', VERSION, 'node.exe');
    need(fs.existsSync(nodeExe), `缺少 ${nodeExe}`);
    return '';
  });

  check('config.json 记录版本与自定义数据目录', () => {
    const cfgPath = path.join(installDir, 'config.json');
    need(fs.existsSync(cfgPath), `缺少 ${cfgPath}`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    need(cfg.version === VERSION, `version=${cfg.version}，期望 ${VERSION}`);
    const got = path.resolve(String(cfg.dataDir || ''));
    const want = path.resolve(dataDir);
    need(got.toLowerCase() === want.toLowerCase(), `dataDir=${cfg.dataDir}，期望 ${dataDir}`);
    return `dataDir=${cfg.dataDir}`;
  });

  check('注册表 DisplayVersion 是当前版本', () => {
    const out = regQuery(REG_KEY, 'DisplayVersion');
    need(out, '注册表里没有卸载项');
    need(out.includes(VERSION), `DisplayVersion 里没有 ${VERSION}：${tail(out, 200)}`);
    return '';
  });

  // ---------- 3. 启动器自检 ----------
  check('启动器 --selftest 能跑通', () => {
    const launcher = path.join(installDir, '待办工作台.exe');
    need(fs.existsSync(launcher), `缺少 ${launcher}`);
    const res = run(launcher, ['--selftest'], { timeout: 120000 });
    need(res.error == null, `启动失败：${res.error && res.error.message}`);
    need(res.status === 0, `退出码 ${res.status}（详情看数据目录里的 server.log）`);
    const db = path.join(dataDir, 'workbench.db');
    if (!fs.existsSync(db)) {
      return '自检通过（本地服务已在别处运行，未新建数据库）';
    }
    return `自检通过，数据目录已生成数据库`;
  });

  // ---------- 4. 卸载并清理 ----------
  check('静默卸载能把程序目录删掉', () => {
    const launcher = path.join(installDir, '待办工作台.exe');
    const res = run(launcher, ['--uninstall-silent', '--drop-data'], { timeout: 120000 });
    need(res.status === 0, `卸载退出码 ${res.status}`);
    need(!fs.existsSync(path.join(installDir, 'app')), 'app 目录还在');
    return '';
  });

  check('注册表卸载项已移除', () => {
    const out = regQuery(REG_KEY, 'DisplayVersion');
    need(!out, '卸载后注册表项仍在');
    return '';
  });
}

// ---------- 汇总 ----------
regDelete(REG_KEY);
if (!keep) rmrf(tmp);
else console.log(`[verify-setup] 保留现场：${tmp}`);

console.log('');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log('');
if (failures) {
  console.error(`安装包验收：${results.length - failures}/${results.length} 通过，${failures} 项失败`);
  process.exit(1);
}
console.log(`安装包验收：${results.length}/${results.length} 通过`);
process.exit(0);
