// 打包：只出两样东西——安装包（exe）+ 便携包（zip）。单文件版已停止发布。
// 用法：node scripts/build-dist.mjs [--skip-setup]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(BUILD, 'out');
const DIST = path.join(ROOT, 'dist');
const NAME = '待办工作台';
// 版本只在 package.json 里改一处，打包脚本跟着走
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// 便携版目录放在 build/ 下：dist 只放要发给同事的成品（exe / 安装包 / zip / 使用说明）
const PORTABLE = path.join(BUILD, 'portable', NAME);
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const skipSetup = process.argv.includes('--skip-setup');

const log = (msg) => console.log(msg);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function rm(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    // 输入法/杀软偶尔会在 dist 里写 debug.log 并短暂占住文件；占住的跳过，别让整次打包失败
    log(`  ! 跳过无法删除的 ${p}: ${err.code || err.message}`);
  }
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function ps(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: 'ignore' });
  if (r.status !== 0) throw new Error('powershell 失败：' + command);
}
function csc(args) {
  const r = spawnSync(CSC, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('编译失败：\n' + (r.stdout || '') + (r.stderr || ''));
}
// 源码按目录收集：build\src\launcher、build\src\setup（每个类型一个 .cs）
function listCs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cs')) out.push(p);
    }
  };
  walk(dir);
  if (!out.length) throw new Error('没找到 C# 源码：' + dir);
  return out;
}

// build\app.ico 被 .gitignore 排除了（二进制素材），干净 clone 里可能没有；
// 有就用，没有就编个不带图标的 exe，别让整次打包因为一个图标失败。
const iconFile = path.join(BUILD, 'app.ico');
const iconArg = fs.existsSync(iconFile) ? [`/win32icon:${iconFile}`] : [];
if (!iconArg.length) log('  ! 没找到 build\\app.ico，这次打出来的 exe 用系统默认图标');

const cscBase = [
  '/nologo', '/target:winexe', '/langversion:5', '/platform:anycpu', '/codepage:65001', '/utf8output', '/optimize+',
  ...iconArg,
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  '/r:System.Web.Extensions.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
];
const launcherSrc = listCs(path.join(BUILD, 'src', 'launcher'));
// 安装向导的版本号由打包时生成的文件提供；仓库里那份 SetupVersion.cs 只是开发默认值，编译时排除
const setupSrc = listCs(path.join(BUILD, 'src', 'setup')).filter((p) => !p.endsWith('SetupVersion.cs'));

/* 1) 启动器（便携版和安装包共用） */
rm(OUT);
fs.mkdirSync(OUT, { recursive: true });
// dist/ 被 .gitignore 排除了，干净 clone 里没有这个目录，先建出来
fs.mkdirSync(DIST, { recursive: true });
// 安装向导的版本号：每次打包现场生成，避免向导里写死版本
{
  const setupVersionFile = path.join(OUT, 'SetupVersion.g.cs');
  fs.writeFileSync(setupVersionFile, [
    'namespace TodoWorkbenchSetup',
    '{',
    '\tinternal static class SetupVersion',
    '\t{',
    `\t\tpublic const string Value = "${VERSION}";`,
    '\t}',
    '}',
    '',
  ].join('\r\n'), 'utf8');
  setupSrc.push(setupVersionFile);
}
// 清掉 dist 里以前跑测试 / 早期版本留下的目录，只留最终产物
for (const stale of ['setup-test.exe', 'setup.log', 'debug.log', '.app', 'logs', '工作台数据', NAME, '_test-install', '_inst2', '_inst3', '_data2', '_data3']) {
  rm(path.join(DIST, stale));
}
log('· 编译启动器');
csc([...cscBase, `/out:${path.join(OUT, 'Launcher-plain.exe')}`, ...launcherSrc]);
csc([...cscBase, `/out:${path.join(OUT, 'Launcher.exe')}`, ...launcherSrc]);
log('   ' + (fs.statSync(path.join(OUT, 'Launcher.exe')).size / 1024).toFixed(0) + ' KB');

/* 2) 便携版目录 */
log('· 组装便携版');
rm(PORTABLE);
fs.mkdirSync(PORTABLE, { recursive: true });
copyDir(path.join(ROOT, 'src'), path.join(PORTABLE, 'src'));
copyDir(path.join(ROOT, 'public'), path.join(PORTABLE, 'public'));
fs.copyFileSync(process.execPath, path.join(PORTABLE, 'node.exe'));
fs.copyFileSync(path.join(OUT, 'Launcher-plain.exe'), path.join(PORTABLE, NAME + '.exe'));
log('   node.exe ' + mb(fs.statSync(path.join(PORTABLE, 'node.exe')).size));

const readme = `待办工作台 · 便携版 ${VERSION}
==============================

这一版的新东西
  · 聚焦页三张卡常驻：时钟 / 迷你月历 / 本周节奏；待办一多自动收窄，但不会消失。
  · 速记独立成一库：回车即存，可置顶、转成待办、删除可撤销，和待办不混在一起。
  · 多选批量：Shift 连选后一次完成 / 改到明天 / 打标签 / 移分类。
  · 打印今日清单：一页 A4，逾期排在前面，打印出来可以直接打勾。
  · 每天第一次启动自动备份（留最近 7 份），并静默检查更新。
  · 另有体检与清理、归档全文搜索、重复待办、日历视图、子待办与到期提醒。
  · 双击启动器窗口会自己关，服务留在后台；托盘菜单里可以退出。

怎么用
  双击「${NAME}.exe」——窗口会先出现，然后自动打开浏览器。
  没打开浏览器时，窗口里有「没反应？点这里」，可以复制地址手动打开。
  关闭窗口不影响服务；右下角托盘图标可以再次打开，也能停止服务。

数据在哪
  程序旁边的「工作台数据」文件夹：
    工作台数据\\workbench.db      数据库（拷走它 = 备份全部待办）
    工作台数据\\archive\\          完成的待办存成 Markdown，按年月分文件夹
    工作台数据\\backups\\          备份
    工作台数据\\server.log        出问题先看这个
    工作台数据\\..\\logs\\launcher.log  启动器日志（打不开浏览器时看这个）
  如果程序放在只读目录（比如 Program Files），数据会自动改存到
  %LOCALAPPDATA%\\TodoWorkbench\\data。

换电脑 / 分享给同事
  把整个「${NAME}」文件夹压缩发过去，对方解压后双击 exe 即可。
  不需要装 Node、不需要联网、数据只存在本机。

注意
  · 只监听 127.0.0.1，同一局域网里别人打不开，数据不外发。
  · 首次双击 Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」。
  · 想让同事装得更省心，用「${NAME}-${VERSION}-安装包.exe」，可以选安装目录、
    自动建快捷方式、能在「设置 → 应用」里卸载。

安装版（${NAME}-${VERSION}-安装包.exe）怎么用
  1. 双击安装包 → 选「仅为我安装（推荐）」或「所有用户」→ 选安装位置 → 安装。
  2. 安装位置默认：%LOCALAPPDATA%\\Programs\\TodoWorkbench（仅为自己）
                     C:\\Program Files\\TodoWorkbench（所有用户）
     数据目录固定放 %LOCALAPPDATA%\\TodoWorkbench\\data，不跟程序放一起，
     这样卸载重装、升级都不会丢待办。
  3. 装完可以勾「立即启动」。开始菜单里会有两个快捷方式：
     「待办工作台」= 双击就自动开浏览器；
     「待办工作台（不自动开浏览器）」= 只起服务，浏览器自己开。
  4. 卸载：开始菜单「卸载」或「设置 → 应用」里卸载。卸载默认保留数据，
     想连数据一起删，在卸载窗口里勾「同时删除数据」。
  5. 装新版：直接跑新安装包，会装到 app\\<版本> 下，数据沿用；旧版本目录可以之后手工删。
`;
fs.writeFileSync(path.join(PORTABLE, '使用说明.txt'), readme, 'utf8');

/* 3) 安装程序：bundle.zip = 程序文件 + 启动器 */
if (!skipSetup) {
  log('· 打 bundle.zip（安装包用）');
  const bundle = path.join(OUT, 'bundle.zip');
  rm(bundle);
  {
    const src = path.join(OUT, 'bundle');
    rm(src);
    fs.mkdirSync(src, { recursive: true });
    copyDir(path.join(PORTABLE, 'src'), path.join(src, 'src'));
    copyDir(path.join(PORTABLE, 'public'), path.join(src, 'public'));
    fs.copyFileSync(path.join(PORTABLE, 'node.exe'), path.join(src, 'node.exe'));
    fs.copyFileSync(path.join(OUT, 'Launcher.exe'), path.join(src, 'Launcher.exe'));
    fs.copyFileSync(path.join(PORTABLE, '使用说明.txt'), path.join(src, '使用说明.txt'));
    ps(`Compress-Archive -Path '${src}\\*' -DestinationPath '${bundle}' -CompressionLevel Optimal -Force`);
    rm(src);
  }
  log('   ' + mb(fs.statSync(bundle).size));

  log('· 编译安装程序');
  const setup = path.join(DIST, `${NAME}-${VERSION}-安装包.exe`);
  rm(setup);
  csc([...cscBase, '/resource:' + bundle + ',bundle.zip', `/out:${setup}`, ...setupSrc]);
  log('   ' + mb(fs.statSync(setup).size));
}

/* 6) 分享用 zip（便携版整包） */
log('· 打分享包');
const shareZip = path.join(DIST, `${NAME}-便携版.zip`);
rm(shareZip);
ps(`Compress-Archive -Path '${PORTABLE}' -DestinationPath '${shareZip}' -CompressionLevel Optimal -Force`);
log('   ' + mb(fs.statSync(shareZip).size));

log('\n完成：');
for (const f of fs.readdirSync(DIST)) {
  const p = path.join(DIST, f);
  if (fs.statSync(p).isFile()) log('  ' + f + '  ' + mb(fs.statSync(p).size));
}
