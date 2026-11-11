#!/usr/bin/env node
// 一条命令发布：清演示数据 → 提交 → 推送（github.com 不通时走 Git Data API 重放）→ 打 tag
//              → 打包 → 安装包验收 → 建 release 并上传固定名资产 → 校验。
//
// 用法：
//   node scripts/release.mjs --notes docs/release-notes-v1.9.5.md
//   node scripts/release.mjs --notes <文件> --title "v1.9.5 · 一句话" --message "feat: ..."
//   node scripts/release.mjs --dry-run          # 只检查前置条件，不动数据、不提交、不发布
//   node scripts/release.mjs --no-build         # 用 dist 里已有的包
//   node scripts/release.mjs --skip-verify      # 跳过安装包验收（不建议）
//
// 退出码：0 成功；1 某一步失败；2 前置条件不满足。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = `v${VERSION}`;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

const dryRun = has('--dry-run');
const noBuild = has('--no-build');
const skipVerify = has('--skip-verify');
const notesFile = path.resolve(argOf('--notes') || path.join(ROOT, 'docs', `release-notes-${TAG}.md`));
const title = argOf('--title') || `${TAG} · 待办工作台`;
const commitMessage = argOf('--message') || `chore: 发布 ${TAG}`;

const FIXED_ASSETS = [
  ['todo-workbench-setup.exe', `待办工作台-${VERSION}-安装包.exe`],
  ['todo-workbench-portable.zip', '待办工作台-便携版.zip'],
];

function say(step, message) {
  console.log(`\n[${step}] ${message}`);
}

function fail(step, message, extra) {
  console.error(`\n✗ [${step}] ${message}`);
  if (extra) console.error(String(extra).trim());
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 600000,
    input: opts.input,
  });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error,
  };
}

function gh(args, body) {
  const full = ['api', ...args];
  if (body !== undefined) full.push('--input', '-');
  return sh('gh', full, { input: body !== undefined ? JSON.stringify(body) : undefined });
}

function repoSlug() {
  const res = sh('git', ['remote', 'get-url', 'origin']);
  if (res.status !== 0) fail('repo', '读不到 origin 远程地址', res.stderr);
  const m = res.stdout.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) fail('repo', `无法从 ${res.stdout} 解析出 owner/repo`);
  return { owner: m[1], repo: m[2] };
}

// ---------- 前置检查 ----------
say('检查', `版本 ${VERSION}，tag ${TAG}`);
if (!fs.existsSync(notesFile)) fail('检查', `找不到发布说明：${notesFile}`);
console.log(`  发布说明：${notesFile}`);
console.log(`  标题：${title}`);
console.log(`  提交信息：${commitMessage}`);

if (dryRun) {
  console.log('\n[dry-run] 只做检查：不动数据、不提交、不推送、不打包、不发布');
  const missing = [];
  for (const [, file] of FIXED_ASSETS) {
    if (!fs.existsSync(path.join(ROOT, 'dist', file))) missing.push(file);
  }
  if (missing.length) {
    console.log(`  提醒：dist 里还缺 ${missing.join('、')}（正式发布会重新打包）`);
  }
  console.log('  ✓ 前置条件满足');
  process.exit(0);
}

// ---------- 1. 清演示数据 ----------
say('清数据', '停服务、清空任务/速记/归档');
sh('node', ['scripts/stop.mjs'], { timeout: 120000 });
const reset = sh('node', ['scripts/reset.mjs'], { timeout: 120000 });
console.log(reset.status === 0 ? '  ✓ reset 完成' : `  ! reset 退出码 ${reset.status}：${reset.stderr}`);

for (const rel of ['data/backups', 'data/shots', 'data/updates', 'data/edge-cdp-profile']) {
  fs.rmSync(path.join(ROOT, rel), { recursive: true, force: true });
}
const archiveDir = path.join(ROOT, 'archive');
if (fs.existsSync(archiveDir)) {
  for (const entry of fs.readdirSync(archiveDir)) {
    fs.rmSync(path.join(archiveDir, entry), { recursive: true, force: true });
  }
}

const counted = sh('node', ['-e', `
import('node:sqlite').then(({ DatabaseSync }) => {
  const db = new DatabaseSync(${JSON.stringify(path.join(ROOT, 'data', 'workbench.db'))});
  const one = (sql) => db.prepare(sql).get();
  const rows = {
    task: one("select count(*) as n from task").n,
    memo: one("select count(*) as n from memo").n,
    series: one("select count(*) as n from task_series").n,
  };
  console.log(JSON.stringify(rows));
  db.close();
});
`], { timeout: 60000 });
if (counted.status === 0) {
  const rows = JSON.parse(counted.stdout);
  console.log(`  库里：task=${rows.task} memo=${rows.memo} task_series=${rows.series}`);
  if (rows.task || rows.memo || rows.series) fail('清数据', '清空后库里还有数据，先处理干净再发布');
} else {
  console.log(`  ! 没读到库计数：${counted.stderr}`);
}
const archiveCount = fs.existsSync(archiveDir)
  ? fs.readdirSync(archiveDir).reduce((n, d) => n + fs.readdirSync(path.join(archiveDir, d), { recursive: true }).length, 0)
  : 0;
console.log(`  archive 文件数：${archiveCount}`);

// ---------- 2. 提交 ----------
say('提交', '把工作区改动提交成一个版本提交');
sh('git', ['add', '-A']);
const staged = sh('git', ['diff', '--cached', '--name-only']);
if (!staged.stdout) {
  console.log('  工作区没有改动，跳过提交');
} else {
  const commit = sh('git', ['commit', '-m', commitMessage]);
  if (commit.status !== 0) fail('提交', 'git commit 失败', commit.stderr || commit.stdout);
  console.log('  ✓ ' + commit.stdout.split('\n')[0]);
}

// ---------- 3. 推送（失败则用 Git Data API 重放） ----------
say('推送', 'git push origin main');
let remoteSha = '';
const push = sh('git', ['push', 'origin', 'main'], { timeout: 300000 });
if (push.status === 0) {
  console.log('  ✓ 已推送');
  remoteSha = sh('git', ['rev-parse', 'HEAD']).stdout;
} else {
  console.log('  ! 直连推送失败，改用 Git Data API 重放提交');
  const { owner, repo } = repoSlug();
  const headRef = gh([`repos/${owner}/${repo}/git/ref/heads/main`]);
  if (headRef.status !== 0) fail('推送', '读不到远程 main', headRef.stderr);
  const base = JSON.parse(headRef.stdout).object.sha;
  const list = sh('git', ['rev-list', '--reverse', `${base}..HEAD`]);
  const commits = list.stdout ? list.stdout.split('\n') : [];
  if (!commits.length) fail('推送', '本地没有领先远程的提交，但推送仍失败？');
  console.log(`  远程 ${base.slice(0, 8)} 之后有 ${commits.length} 个提交要重放`);

  let tree = null;
  for (const sha of commits) {
    const changed = sh('git', ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', sha]);
    const parts = changed.stdout.split('\0').filter(Boolean);
    const entries = [];
    for (let i = 0; i < parts.length; i += 2) {
      const status = parts[i];
      const file = parts[i + 1];
      if (!file) continue;
      if (status === 'D') {
        entries.push({ path: file, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const modeOut = sh('git', ['ls-tree', sha, '--', file]).stdout;
      const mode = (modeOut.split(' ')[0] || '100644').trim();
      const blob = spawnSync('git', ['cat-file', 'blob', `${sha}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
      if (blob.status !== 0) fail('推送', `读不到 ${file} 的内容`);
      const created = gh([`repos/${owner}/${repo}/git/blobs`, '-f', 'encoding=base64', '-f', `content=${blob.stdout.toString('base64')}`]);
      if (created.status !== 0) fail('推送', `建 blob 失败：${file}`, created.stderr);
      entries.push({ path: file, mode, type: 'blob', sha: JSON.parse(created.stdout).sha });
    }
    const treeBody = { tree: entries };
    if (tree) treeBody.base_tree = tree;
    const madeTree = gh([`repos/${owner}/${repo}/git/trees`], treeBody);
    if (madeTree.status !== 0) fail('推送', `建 tree 失败：${sha}`, madeTree.stderr);
    tree = JSON.parse(madeTree.stdout).sha;

    const meta = sh('git', ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', sha]);
    const [an, ae, date, ...rest] = meta.stdout.split('\0');
    const message = rest.join('\0');
    const madeCommit = gh([`repos/${owner}/${repo}/git/commits`], {
      message,
      tree,
      parents: [base],
      author: { name: an, email: ae, date },
      committer: { name: an, email: ae, date },
    });
    if (madeCommit.status !== 0) fail('推送', `建 commit 失败：${sha}`, madeCommit.stderr);
    remoteSha = JSON.parse(madeCommit.stdout).sha;
    console.log(`  重放 ${sha.slice(0, 8)} → ${remoteSha.slice(0, 8)}`);
  }
  const moved = gh([`repos/${owner}/${repo}/git/refs/heads/main`, '-X', 'PATCH', '-f', `sha=${remoteSha}`, '-f', 'force=false']);
  if (moved.status !== 0) fail('推送', '更新 main 失败', moved.stderr);
  console.log(`  ✓ 远程 main 现在指向 ${remoteSha.slice(0, 8)}`);
}

// ---------- 4. 打 tag 并推送 ----------
say('tag', TAG);
sh('git', ['tag', '-f', TAG]);
const tagPush = sh('git', ['push', 'origin', `refs/tags/${TAG}`], { timeout: 120000 });
if (tagPush.status === 0) {
  console.log('  ✓ tag 已推送');
} else {
  const { owner, repo } = repoSlug();
  const head = remoteSha || sh('git', ['rev-parse', 'HEAD']).stdout;
  const made = gh([`repos/${owner}/${repo}/git/refs`, '-f', `ref=refs/tags/${TAG}`, '-f', `sha=${head}`, '-f', 'force=true']);
  if (made.status !== 0) fail('tag', '建远程 tag 失败', made.stderr);
  console.log(`  ✓ 远程 tag 指向 ${head.slice(0, 8)}（本地 tag 指向 ${sh('git', ['rev-parse', 'HEAD']).stdout.slice(0, 8)}）`);
}

// ---------- 5. 打包 ----------
if (noBuild) {
  say('打包', '跳过（--no-build）');
} else {
  say('打包', 'node scripts/build-dist.mjs');
  const build = sh('node', ['scripts/build-dist.mjs'], { timeout: 1800000 });
  process.stdout.write(build.stdout);
  if (build.status !== 0) fail('打包', '打包失败', build.stderr);
}

// ---------- 6. 安装包验收 ----------
if (skipVerify) {
  say('验收', '跳过（--skip-verify）');
} else {
  say('验收', 'node scripts/verify-setup.mjs');
  const verify = sh('node', ['scripts/verify-setup.mjs'], { timeout: 900000 });
  process.stdout.write(verify.stdout);
  if (verify.status !== 0) fail('验收', '安装包验收没通过', verify.stderr);
}

// ---------- 7. 建 release 并上传固定名资产 ----------
say('发布', `建 release ${TAG}`);
const assets = path.join(os.tmpdir(), `wb-assets-${VERSION}-${process.pid}`);
fs.mkdirSync(assets, { recursive: true });
const assetPaths = [];
for (const [fixed, local] of FIXED_ASSETS) {
  const src = path.join(ROOT, 'dist', local);
  if (!fs.existsSync(src)) fail('发布', `缺少产物：${src}`);
  const dst = path.join(assets, fixed);
  fs.copyFileSync(src, dst);
  assetPaths.push(dst);
}

const existing = gh([`repos/${repoSlug().owner}/${repoSlug().repo}/releases/tags/${TAG}`]);
if (existing.status === 0) {
  console.log('  release 已存在，改为覆盖上传资产');
  const up = sh('gh', ['release', 'upload', TAG, '--clobber', ...assetPaths], { timeout: 1800000 });
  if (up.status !== 0) fail('发布', '覆盖上传失败', up.stderr);
} else {
  const made = sh('gh', [
    'release', 'create', TAG,
    '--verify-tag',
    '--title', title,
    '--notes-file', notesFile,
    '--latest',
    ...assetPaths,
  ], { timeout: 1800000 });
  if (made.status !== 0) fail('发布', 'gh release create 失败', made.stderr || made.stdout);
  console.log('  ' + made.stdout);
}

// ---------- 8. 校验 ----------
say('校验', '确认资产已上传');
const { owner, repo } = repoSlug();
const info = gh([`repos/${owner}/${repo}/releases/tags/${TAG}`]);
if (info.status !== 0) fail('校验', '读不到 release', info.stderr);
const rel = JSON.parse(info.stdout);
for (const a of rel.assets) {
  console.log(`  ${a.name}  ${a.size} B  ${a.state}`);
}
if (rel.assets.some((a) => a.state !== 'uploaded')) fail('校验', '有资产不是 uploaded 状态');
console.log(`\n✓ 发布完成：${rel.html_url}`);
fs.rmSync(assets, { recursive: true, force: true });
process.exit(0);
