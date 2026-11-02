# 待办工作台 · 启动器可靠性 + 安装程序设计

> 日期：2026-10-20　范围：`build/Launcher.cs`、`src/server.mjs`、`scripts/build-dist.mjs`，
> 新增 `build/Installer.cs`、`build/Uninstaller.cs`、`build/app.manifest`。
> 约束：不引入 WiX / Inno / NSIS 等第三方安装器，不联网，只用 `csc.exe` + `node.exe` + payload。

---

## 0. TL;DR

1. **"浏览器没打开"不是一个 bug，是四条独立链路里任一条断了都长这个样子**：进程没跑起来 / payload 没解开 / node 没起来 / 浏览器握手失败。现在这四条链路**全部静默**（日志路径可能压根没写成、`server.log` 每次启动被 `>` 清空、失败时弹的 MessageBox 不可复制且服务还在后台跑），所以没法定位。
   → 第一优先级不是"换一种开浏览器的方法"，而是**让每一级失败都留下可复制的证据**。
2. 开浏览器改成 **L1→L5 五级降级**，其中 **elevated 时跳过 L1 直接走 explorer.exe 转发**——这一条是装了 per-machine 版之后必然踩到的坑。
3. 安装程序：**默认 per-user（免 UAC），per-machine 作为可选项用 `runas` 自提权重启**。默认目录 `%LOCALAPPDATA%\Programs\TodoWorkbench`（ASCII，不带中文）。
4. 磁盘布局的关键决策：**启动器（~35KB）与 payload（node/node_modules/src/public）分离**，payload 按版本落在 `app\<ver>\`，升级 = 加新目录 + 切指针，**数据目录完全不在安装目录里**。
5. `%LOCALAPPDATA%` 不可写是一个**必须当正常情况处理**的现实（受限账户、漫游配置、沙箱、企业策略）——它已经在今天这台机器上发生了。

---

## 1. 现场取证（本机实测，2026-10-20 09:27–09:32）

这些不是推测，是这台机器上的实际状态：

| 观察 | 证据 | 结论 |
|---|---|---|
| 服务**能**正常起来并监听 | `node.exe` pid 24772，cmdline `"...\dist\.app\app-1.0.0.0\node.exe" "...\src\server.mjs"`；`Get-NetTCPConnection -LocalPort 7861` → 24772 | 启动链路后半段没问题 |
| 页面**能**正常返回 | `GET http://127.0.0.1:7861/` → 200，4547 字节，`window.__WB_TOKEN__` 已被真实 token 替换 | 服务端没问题 |
| `server.log` **曾经是 0 字节**，稍后变 192 字节 | 第一次 `Get-ChildItem` 报 0，`Get-Content` 读出「待办工作台已启动 → ...」 | 日志是 `cmd /c ... > log` 写出来的，**每次启动 `>` 截断**：失败那次的日志会被下一次双击清空 |
| **`launcher.log` 在整个用户目录里根本不存在** | `%LOCALAPPDATA%\TodoWorkbench`、`%APPDATA%\TodoWorkbench`、`%TEMP%\TodoWorkbench` **三个目录都不存在**；全盘搜 `launcher.log` 零命中 | `Log()`（`Launcher.cs:31-60`）**一个字都没写出去**，而且失败路径是 `return`，**静默** |
| payload 被解到了 **exe 旁边的 `.app`** | `dist\.app\app-1.0.0.0\` 存在（`.ready` @09:27:20），而 `%LOCALAPPDATA%` 目录不存在 | `ResolveAppDir`（`Launcher.cs:104-143`）的第 1/2/3 个根**全部判定不可写**，落到第 4 个根 `exeDir\.app` |
| 数据目录也落在 exe 旁 | `dist\工作台数据\`（db/wal/token/pid 齐全） | `ResolveDataDir` 同样判定 `%LOCALAPPDATA%` 不可用 |
| 默认浏览器 = Edge | `HKCU\...\UrlAssociations\http\UserChoice` → `MSEdgeHTM`；HKCR command = `"...\msedge.exe" --single-argument %1` | L1 ShellExecute 在正常情况下本应能开 |
| 当前进程非 elevated，explorer 在 session 2 运行 | `IsInRole('Administrators')` → False；explorer pid 18608/26352 | 这份现场不是"提权导致浏览器打不开"那一类 |
| exe 无 MOTW | `Get-Item -Stream *` 只有 `:$DATA` | 不是 SmartScreen/MOTW 拦的 |

**这两条放在一起只有一个解释**：那个进程运行时，`%LOCALAPPDATA%` / `%APPDATA%` / `%TEMP%` **对本进程不可写**（受限令牌、沙箱、AppContainer 任一），于是日志没写、payload 退到 exe 旁。

这恰恰是最有价值的一条：

> **一旦 `%LOCALAPPDATA%` 不可写，`Log()` 就彻底失声，而"浏览器没打开"最需要的就是日志。**
> 一个写不进去的日志路径，等于没有日志。

顺带暴露 4 个独立缺陷（见 2.2），每一个都能单独造成"双击后浏览器没打开、而且看不出为什么"。

---

## 2. ① 浏览器打不开：排查清单 + 最稳修复

### 2.1 排查决策树（按顺序问，每条都给出可直接粘的命令）

排查原则：**先分叉"exe 有没有跑起来"，再分叉"服务有没有起来"，最后才轮到浏览器。** 顺序反了就会在浏览器上瞎试。

**D0｜双击后有反应吗？**
- 有弹窗 → 直接看弹窗文字，跳 D3 / D4。
- 完全没反应（含任务栏没闪、任务管理器里 `待办工作台.exe` 一闪而过或根本不存在）→ D1。

**D1｜启动器有没有留下痕迹？（这一步决定后面所有分支）**

```powershell
foreach ($p in @("$env:LOCALAPPDATA\TodoWorkbench","$env:APPDATA\TodoWorkbench","$env:TEMP\TodoWorkbench")) {
  "$p  exists=" + (Test-Path $p)
  if (Test-Path $p) { Get-ChildItem $p -Force | Select-Object LastWriteTime,Length,Name }
}
Get-ChildItem $env:LOCALAPPDATA,$env:APPDATA,$env:TEMP -Filter 'launcher*.log' -Recurse -Depth 3 -ErrorAction SilentlyContinue
Get-ChildItem 'C:\ProgramData\TodoWorkbench' -Recurse -ErrorAction SilentlyContinue
```

- **三个目录都不存在、也没有 `launcher.log`** → exe 要么没执行，要么 `Log()` 全静默（今天就踩到了）。继续 D1a / D1b。
- 有 `launcher.log` → 直接读最后 20 行，按里面 `appDir=` / `port=` / `dataDir=` 的值跳对应分支。

**D1a｜exe 到底有没有被执行？**

```powershell
# 1) 是不是被"来自 Internet"标记 + SmartScreen 静默拦了
Get-Item '.\待办工作台.exe' -Stream * | Select-Object Stream,Length     # 有 Zone.Identifier 就是
# 2) Defender 有没有拦（事件 1116/1117）
Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 30 |
  Where-Object { $_.Id -in 1116,1117 } | Select-Object TimeCreated,Message
# 3) 应用错误日志（.NET 未处理异常 / 加载失败会在这里留 1026 / .NET Runtime）
Get-WinEvent -LogName Application -MaxEvents 40 |
  Where-Object { $_.ProviderName -match 'Application Error|\.NET Runtime|Application Hang' } |
  Select-Object TimeCreated,ProviderName,Id,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(400,$_.Message.Length))}}
# 4) 360/火绒/腾讯电脑管家 的拦截记录（各自客户端里有"防护日志"）
```
命中 → 让用户「更多信息 → 仍要运行」/ 加白名单；**这不是代码能修的**，只能靠文档 + 安装器剥 MOTW（见 3.11）。

**D1b｜进程在什么上下文里跑的？**（今天这台机器就是栽在这里）
```powershell
"session=" + (Get-Process -Id $PID).SessionId
"explorer=" + (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -Expand Id)
"elevated=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
"user=" + [Environment]::UserName
```
- 没有 explorer、或 session 与登录用户不一致（服务/SYSTEM/别的用户/远程会话）→ **ShellExecute 必然失败**（没有可委托的 shell）。这是 L2 存在的理由。
- `elevated=True` → **L1 会"成功"但没有窗口**（Edge/Chrome 拒绝以管理员令牌起实例，或复用已有实例时被静默丢弃）。这是装了 per-machine 版之后的新头号故障。

**D2｜payload 解到哪儿了？**
```powershell
Get-ChildItem "$env:LOCALAPPDATA\TodoWorkbench\app-*","$env:APPDATA\TodoWorkbench\app-*","$env:TEMP\TodoWorkbench\app-*","<exe所在目录>\.app\app-*" -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName; Get-ChildItem $_.FullName | Select-Object Length,Name }
```
- 找到 `app-<ver>` 但里面没有 `node.exe` 或 `src\server.mjs` → **`.ready` 标记撒谎**（`.ready` 存在但文件被杀软删了），`ResolveAppDir:123` 会直接复用这个残缺目录 → `LaunchServer:270` 返回 null → 静默失败。**这是今天代码里最阴的一个 bug**：`.ready` 只证明"曾经解开过"，不证明"现在是完整的"。

**D3｜服务起来了吗？**
```powershell
7861..7871 | ForEach-Object { try { $r = Invoke-WebRequest "http://127.0.0.1:$_/api/health" -TimeoutSec 1 -UseBasicParsing; "$_ OK " + $r.Content } catch {} }
Get-NetTCPConnection -State Listen -LocalPort 7861..7871 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
Get-Content "<exe所在目录>\工作台数据\server.log" -Tail 30
```
- 有人在听但 `/api/health` 不通 → 端口被别的程序占了（`server.mjs:602-635` 会 `+1` 重试，最多 10 次）。
- 完全没人听 → 读 `server.log`；读不到就用 D4 手工复现。

**D4｜手工把 node 跑起来看真话**
```powershell
$app = "<D2 找到的 app-<ver> 目录>"
cd $app
$env:WB_NO_OPEN=1
$env:WB_DB="$env:TEMP\wbprobe\workbench.db"
$env:WB_ARCHIVE="$env:TEMP\wbprobe\archive"
$env:WB_BACKUP="$env:TEMP\wbprobe\backups"
.\node.exe src\server.mjs
```
报 `Cannot find module` / `ERR_UNKNOWN_FILE_EXTENSION` / 语法错误 → 版本不匹配或文件损坏；报 `EACCES`/`EPERM` → 目录权限或杀软；`node.exe` 双击就消失 → 架构不符（x64 node 在 x86 系统）或缺 VC 运行库。

**D5｜手工测三级浏览器打开（确定是"服务没起来"还是"浏览器打不开"）**
```powershell
Start-Process 'http://127.0.0.1:7861/'                       # L1：ShellExecute
explorer.exe 'http://127.0.0.1:7861/'                        # L2：交给已有 shell
rundll32 url.dll,FileProtocolHandler 'http://127.0.0.1:7861/' # L3：注册的协议处理器
```
三条都开不出来 → 用户环境的 shell 关联坏了（D6）；L1 不行但 L2/L3 行 → 就是 elevated 或 shell 缺失。

**D6｜默认浏览器关联是不是坏了？**
```powershell
$uc = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
$progId = (Get-ItemProperty $uc -ErrorAction SilentlyContinue).ProgId
"ProgId=$progId"
if ($progId) { Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction SilentlyContinue }
```
- `ProgId` 为空 → 用户从没设过默认浏览器（新装的系统、或装了精简版）→ ShellExecute 抛 `Win32Exception 1155`「没有应用程序与此操作的指定文件有关联」。
- `ProgId` 有值但 HKCR 下没有 command → 关联是**孤儿**（浏览器被卸载/改名了）。国产清理工具常干这事。
- 这两类的修法：让用户「设置 → 应用 → 默认应用」重设一次；代码侧靠 L4 兜。

**D7｜有没有"看起来没开"？** Edge/Chrome 已有窗口时，新 URL 会进**后台标签页**，或者被开在另一个虚拟桌面上。这解释了相当一部分"没打开"的投诉。**代码侧无法验证"用户真的看见了"，所以必须给一个可复制的 URL**（2.4）。

**D8｜环境变量有没有被遗留？**
```powershell
"WB_SKIP_BROWSER=" + [Environment]::GetEnvironmentVariable('WB_SKIP_BROWSER','User') + " / " + [Environment]::GetEnvironmentVariable('WB_SKIP_BROWSER','Machine')
```
`Launcher.cs:98-101` 的 `SkipBrowser()` 命中时**直接不开浏览器、不弹窗、不写日志**。谁在机器上设过这个变量（自动化测试、上一次调试），这台机器就永久"浏览器打不开"且零症状。**这是最省事就能排除、却最容易被漏掉的一条。**

**D9｜端口/进程被安全软件拦？** Defender 规则、360「程序联网控制」。安全软件对"某进程要拉起某进程 + 监听本地端口"通常有弹窗，用户点过"阻止"就永久记住了。

**D10｜第二次双击的岔路**（`Launcher.cs:212-243`）：服务已在跑时会弹「是：打开界面 / 否：停止服务 / 取消：什么都不做」。用户按 Esc 或点"取消"（或被弹窗挡在别的窗口后面）→ **什么都不发生**，和"浏览器没打开"的症状一模一样。而且这三个按钮叫「是/否/取消」，中文提示写「是：打开界面」，**用户极容易点错**。

### 2.2 已定位的代码级缺陷（按严重度）

| # | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| B1 | `Launcher.cs:31-60` `Log()` | 三个候选根全失败时 `return`，**静默**；且日志路径与"能不能写"完全耦合 | `%LOCALAPPDATA%` 不可写时**一行日志都没有**，故障不可诊断（今天已实测发生） |
| B2 | `Launcher.cs:274` | `cmd /c "... > log 2>&1"` 用 `>` **每次截断** | **失败那次的日志被下一次双击清空**，用户第二次来报障时日志是空的 |
| B3 | `Launcher.cs:274` | 路径手工拼引号进 cmd 命令行 | 目录名含 `&` / `^` / `(` / `)` / `%` 时命令被拆错；`%` 还会被 cmd 当变量展开 |
| B4 | `Launcher.cs:123` | `.ready` 只标记"曾经解开过"，**不校验内容完整性** | 杀软删掉 `node.exe` 后永久复用残缺目录，`LaunchServer` 返回 null，报"启动失败"但看不出真因 |
| B5 | `server.mjs:582-584` vs `:253-255` | `/api/health` 有**两个返回点**：快捷分支只返回 `{ok,version}`，永远命中，`handleApi` 里带 `db/port/now` 的那个是死代码 | 启动器**无法确认这个端口上的服务是不是"我这一套数据"** → 可能打开另一个实例（旧版本/旧数据目录），用户以为"数据丢了" |
| B6 | `Launcher.cs:187-192` + `:74-75` | 只要 7861-7871 任一端口 `/api/health` OK 就判定"已在运行" | 同上，会把别的实例/旧版本误认成自己 |
| B7 | `Launcher.cs:222-237` | 停服务时 `Process.GetProcessById(pid).Kill()`，**不校验这个 pid 还是不是我们的 node** | pid 被系统复用后**杀掉无关进程** |
| B8 | `Launcher.cs:88` / `:219` | 只有 L1 一种开浏览器方式，异常直接被外层 catch 成"启动出错" | elevated / 无 shell / 关联损坏 三种情况全灭；且**服务还在后台跑，用户没有任何 UI 可以回到界面** |
| B9 | `Launcher.cs:286-291` | 注释写"最多等 20 秒"，实际 `100 次 × 11 端口 × 700ms` 最坏 **≈ 13 分钟** | 某个端口 TCP 能连但 HTTP 不应答时，双击后长时间无反应 |
| B10 | `Launcher.cs:98-101` | `WB_SKIP_BROWSER=1` 命中即静默跳过，无日志 | 见 D8，永久零症状故障 |
| B11 | `Launcher.cs:81-86` / `:141` | 失败提示把路径写死成「程序旁边的工作台数据\server.log」 | 数据目录已回退到 `%LOCALAPPDATA%\TodoWorkbench\data` 时，**指错地方** |
| B12 | 全局 | 版本号在 4 处重复：`Launcher.cs:18-20`、`server.mjs:204,254,583`、`package.json:3` | 升级后 `app-<ver>` 目录名、health 的 version、安装器显示版本会互相对不上 |

### 2.3 多级降级：`Browser.Open(url)` 五级实现

放在 `build/Browser.cs`（被 Launcher / Installer / Uninstaller 共用），**所有开浏览器的地方都只调这一个函数**（现在有 3 处：`Launcher.cs:88`、`:219`、以及新增的托盘菜单）。

```csharp
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

internal static class Browser
{
    // 返回值：成功使用的级别（1..4），全失败返回 0
    public static int Open(string url, Action<string> log)
    {
        bool elevated = IsElevated();
        log("browser: begin url=" + url + " elevated=" + elevated + " shell=" + ShellAvailable());

        // L1：ShellExecuteEx。elevated 时故意跳过——否则浏览器继承管理员令牌，
        //     Edge/Chrome 要么拒绝起实例，要么复用已有实例时静默丢弃 URL。
        if (!elevated && TryL1(url, log)) return 1;
        if (elevated) log("browser: L1 skipped (self elevated) -> go L2");

        // L2：把活儿交给已经存在的中等完整性 shell（explorer.exe）。
        //     这是 elevated 场景下业界通用的解法：explorer 收到命令后转给已有实例执行。
        if (TryL2(url, log)) return 2;

        // L3：走注册表里的 URL 协议处理器（server.mjs 现在用的就是这条）。
        if (TryL3(url, log)) return 3;

        // L4：自己按 UrlAssociations 反查默认浏览器 exe，直接带参启动。
        if (TryL4(url, log)) return 4;

        log("browser: ALL LEVELS FAILED url=" + url);
        return 0;
    }

    static bool TryL1(string url, Action<string> log)
    {
        try
        {
            // UseShellExecute=true 且不设 WorkingDirectory：设了会让某些浏览器把相对路径解错
            Process p = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true, Verb = "open" });
            log("browser: L1 ok pid=" + (p == null ? 0 : p.Id));
            return true;
        }
        catch (Win32Exception ex)
        {
            log("browser: L1 fail native=" + ex.NativeErrorCode +
                " hresult=0x" + ex.HResult.ToString("X8") + " msg=" + ex.Message);
            return false;
        }
        catch (Exception ex)
        {
            log("browser: L1 fail " + ex.GetType().Name + " " + ex.Message);
            return false;
        }
    }

    static bool TryL2(string url, Action<string> log)
    {
        try
        {
            // explorer.exe 在已有 shell 实例时会把参数转发过去并立刻退出，不占资源
            Process.Start(new ProcessStartInfo("explorer.exe", Quote(url)) { UseShellExecute = false });
            log("browser: L2 ok (explorer.exe forward)");
            return true;
        }
        catch (Exception ex) { log("browser: L2 fail " + ex.Message); return false; }
    }

    static bool TryL3(string url, Action<string> log)
    {
        try
        {
            Process.Start(new ProcessStartInfo("rundll32.exe", "url.dll,FileProtocolHandler " + Quote(url))
                          { UseShellExecute = false, CreateNoWindow = true });
            log("browser: L3 ok (rundll32 FileProtocolHandler)");
            return true;
        }
        catch (Exception ex) { log("browser: L3 fail " + ex.Message); return false; }
    }

    // L4：HKCU\...\UrlAssociations\http\UserChoice 的 ProgId → HKCR\<ProgId>\shell\open\command
    // 例："C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1
    static bool TryL4(string url, Action<string> log)
    {
        string progId = ReadHkcuDefault(
            @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice", "ProgId");
        if (string.IsNullOrEmpty(progId)) { log("browser: L4 no http UserChoice ProgId"); return false; }

        string command = ReadHkcrDefault(@"\" + progId + @"\shell\open\command");
        if (string.IsNullOrEmpty(command)) { log("browser: L4 no command for ProgId=" + progId); return false; }

        string exe, rest;
        if (!SplitCommand(command, out exe, out rest))
        {
            log("browser: L4 cannot parse command=" + command);
            return false;
        }
        if (!System.IO.File.Exists(exe)) { log("browser: L4 handler missing " + exe); return false; }

        // %1 / %L / %l 是协议处理器的 URL 占位符
        string args = rest.Replace("%1", Quote(url)).Replace("%L", Quote(url)).Replace("%l", Quote(url));
        if (rest.IndexOf("%1", StringComparison.Ordinal) < 0 && rest.IndexOf("%L", StringComparison.Ordinal) < 0)
            args = (args + " " + Quote(url)).Trim();

        try
        {
            Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false });
            log("browser: L4 ok exe=" + exe + " args=" + args);
            return true;
        }
        catch (Exception ex) { log("browser: L4 fail " + ex.Message); return false; }
    }

    /* ---------------- 小工具 ---------------- */

    public static bool IsElevated()
    {
        try
        {
            var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            return new System.Security.Principal.WindowsPrincipal(id)
                .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }

    // explorer.exe 在不在，直接决定 L1/L2 有没有戏；写进日志便于远程判断
    static bool ShellAvailable()
    {
        try { return Process.GetProcessesByName("explorer").Length > 0; }
        catch { return false; }
    }

    // 统一引号规则：含空格或特殊字符就整体加引号，内部 " 转 \"
    public static string Quote(string s)
    {
        if (string.IsNullOrEmpty(s)) return "\"\"";
        if (s.IndexOfAny(new[] { ' ', '\t', '"', '&', '|', '<', '>', '^', '(', ')' }) < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static string ReadHkcuDefault(string subKey, string name)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(subKey)) 
            return k == null ? null : (k.GetValue(name) as string);
    }

    static string ReadHkcrDefault(string subKey)
    {
        using (var k = Registry.ClassesRoot.OpenSubKey(subKey))
            return k == null ? null : (k.GetValue(null) as string);
    }

    // 从 "\"C:\a b\x.exe\" --single-argument %1" 里拆出 exe 和剩余参数
    static bool SplitCommand(string command, out string exe, out string rest)
    {
        exe = rest = null;
        command = command.Trim();
        if (command.Length == 0) return false;
        if (command[0] == '"')
        {
            int end = command.IndexOf('"', 1);
            if (end < 0) return false;
            exe = command.Substring(1, end - 1);
            rest = command.Substring(end + 1).Trim();
            return true;
        }
        int sp = command.IndexOf(' ');
        exe = sp < 0 ? command : command.Substring(0, sp);
        rest = sp < 0 ? "" : command.Substring(sp + 1).Trim();
        return true;
    }
}
```

**落地要点**

- 关键顺序不能乱：**elevated 时必须先跳过 L1**。否则 L1 返回"成功"（`Process.Start` 不抛异常），我们以为完事，用户却看不到窗口——这是最难查的一类。
- L1 失败后**不要**重试同一级；每一级只试一次，每次都写日志（含 `NativeErrorCode`）。
- L2/L3/L4 用 `UseShellExecute=false` 直接 CreateProcess，不依赖 shell 的 COM 激活，绕开"shell 坏了"这一类。
- L4 对 Edge 是重复劳动（`--single-argument` 就是 L1 干的事），但对 Chrome/Firefox/360 是有效的独立通道，成本很低，留着。
- 全失败**不抛异常**，返回 0，由调用方弹兜底 UI。

### 2.4 兜底 UI 规格（`build/FallbackForm.cs`）

原则：**失败必须是"看得见、能复制、能自己救"的**。`MessageBox` 三条都不满足（文字不能选中复制、只能点确定、没有可点的动作）。

**形态 A｜服务起来了，浏览器没开**

```
┌─ 待办工作台 ────────────────────────────────── [×]┐
│                                                     │
│  ⓘ  工作台已在后台运行，但没能自动打开浏览器。      │
│     把下面这个地址复制到浏览器里就能用。             │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ http://127.0.0.1:7861/                        │ │  ← 只读 TextBox，Consolas 12pt，打开时全选
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [ 复制网址 ]  [ 再试一次打开 ]  [ 打开数据文件夹 ]  │
│  [ 查看日志 ]  [ 停止服务 ]                          │
│                                                     │
│  关掉这个窗口不影响使用；要停服务请再双击程序图标。  │  ← 灰字
└─────────────────────────────────────────────────────┘
```

**形态 B｜服务没起来**

```
┌─ 待办工作台没能启动 ────────────────────────── [×]┐
│  原因：没能连上本地服务（node.exe 启动失败）        │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ 2026-10-20 09:27:29 [INFO] stage=launch ...   │ │  ← 只读多行 TextBox，等宽 9pt，20 行高
│  │ 2026-10-20 09:27:49 [ERROR] node exit=1 ...   │ │     直接内联日志尾部，用户不用去找文件
│  │ ...（server.log 最后 20 行 + launcher 最后 8 行）│ │
│  └───────────────────────────────────────────────┘ │
│  [ 复制全部诊断信息 ]  [ 打开日志文件夹 ]  [ 重试 ]  │
└─────────────────────────────────────────────────────┘
```

**"复制全部诊断信息"拼装的内容**（用户一键粘到微信，维护者拿到就能判断）：

```
待办工作台 诊断信息  2026-10-20 09:31:02
版本        1.0.0.0
launcher    E:\...\待办工作台.exe
appDir      E:\...\.app\app-1.0.0.0
dataDir     E:\...\工作台数据
logPath     C:\Users\lenovo\AppData\Local\TodoWorkbench\logs\launcher-20261020.log
用户        lenovo   session=2   elevated=False
shell       explorer=18608,26352
默认浏览器  MSEdgeHTM -> "C:\...\msedge.exe" --single-argument %1
端口探测    7861=OK(instance=ab12…) 7862..7871=refused
浏览器降级  L1 fail native=1155 -> L2 ok
libre       WB_SKIP_BROWSER=<unset>  WB_LAUNCHER_NOBROWSER=<unset>
---- server.log (tail 20) ----
...
---- launcher.log (tail 20) ----
...
```

这个拼装函数写成 `Diagnostics.BuildReport(ctx)`，Launcher / 托盘 / 安装器三处共用。

### 2.5 配套改动（不做这些，2.3 的降级没法被验证）

1. **日志必须先去耦（B1）**：`Log()` 的候选路径改成四级，并且**每一级失败都往上抛、最后一级失败就在兜底窗里显示"日志都写不出去"**：
   `%LOCALAPPDATA%\TodoWorkbench\logs\` → `<exeDir>\logs\` → `%ProgramData%\TodoWorkbench\logs\` → `%TEMP%\twb-logs\`。
   成功后把 `logPath` 写进兜底窗和诊断报告。
2. **日志改成追加 + 按天（B2）**：`launcher-yyyyMMdd.log`，单文件 > 2MB 就 `.1` 轮转，保留 14 天。
3. **别再用 `cmd /c` 起 node（B3）**：`Process.Start(nodePath, args)` 直接起，`CreateNoWindow=true`、`UseShellExecute=false`，日志交给 node 自己写（`src/log.mjs`，见 4.1）。顺手解决引号地狱和日志截断。
4. **`.ready` 换成完整性校验（B4）**：解压完写 `.ready.json = {version, files, bytes, nodeSize, serverMjsSize}`；每次启动先比对 `node.exe` 大小 + `src\server.mjs` 存在且大小一致，**不一致就重解压**（自愈）。
5. **`/api/health` 合并成一处（B5）**：删掉 `server.mjs:582-584` 的快捷分支，让 `handleApi` 里的那个成为唯一实现，并补上 `instanceId` 和 `pid`：

   ```js
   if (method === 'GET' && pathname === '/api/health') {
     return sendJson(res, 200, {
       ok: true, version: VERSION, db: cfg.dbPath, port: cfg.port,
       pid: process.pid, instanceId: INSTANCE_ID, startedAt: STARTED_AT,
     });
   }
   ```
   `INSTANCE_ID` 由服务启动时生成并写进 `dataDir\instance.json`（同时写 `server.port`）。
6. **启动器改读 `server.port` + 校验 `instanceId`（B6）**：不再盲扫 11 个端口当"自己"。顺序：
   ① 读 `dataDir\instance.json`，有 `port` 就直接探一次 `127.0.0.1:<port>/api/health`；
   ② 命中且 `instanceId` 相等 → 复用（"已在运行"分支）；
   ③ 命中但 `instanceId` 不等 → 这是**别人的实例**，记录日志，自己换端口起。
7. **健康探测加 TCP 前置（B9）**：先 `new TcpClient().ConnectAsync(127.0.0.1, port)` 给 120ms 超时筛掉没人听的端口，只对连通的端口发 HTTP。总等待上限硬编码 30 秒，超时就进形态 B 兜底窗。
8. **node 子进程异常退出要立刻反馈**：`Process p = Process.Start(...)`；等待循环里每次 `p.HasExited` 为真就**马上**读 `server.log` 尾部进兜底窗，不要傻等 30 秒。
9. **停服务前校验镜像路径（B7）**：
   ```csharp
   var proc = Process.GetProcessById(pid);
   string image = proc.MainModule.FileName;              // 可能抛，包 try
   if (!image.Equals(nodePath, StringComparison.OrdinalIgnoreCase)) 拒绝并提示 pid 已失效;
   ```
10. **`WB_SKIP_BROWSER` → `WB_LAUNCHER_NOBROWSER`（B10）**：新变量名，且命中时**仍弹兜底窗**（显示 URL + 日志），并写 `[WARN] browser: suppressed by env WB_LAUNCHER_NOBROWSER`。旧变量保留兼容但记警告。
11. **"已在运行"改成三个明确按钮（D10）**：`[打开界面] [停止服务] [退出]`，用 `FallbackForm` 的一个变体，不用 `YesNoCancel`。
12. **托盘图标（建议 P1）**：`NotifyIcon` 常驻，图标复用 `build/app.ico`，菜单「打开界面 / 打开数据文件夹 / 查看日志 / 停止服务 / 退出」。**这是"服务在跑但用户不知道去哪"的根治手段**，也让用户能随时确认"它还在"。左键双击 = 打开界面（走同一个 `Browser.Open`）。

---

## 3. ② 安装程序设计

### 3.1 per-user vs per-machine：取舍矩阵

| 维度 | per-user（仅为我） | per-machine（所有用户） |
|---|---|---|
| 安装目录 | `%LOCALAPPDATA%\Programs\TodoWorkbench` | `%ProgramFiles%\TodoWorkbench` |
| UAC | **不需要** | 需要（安装 + 每次升级 + 卸载） |
| 数据目录 | `%LOCALAPPDATA%\TodoWorkbench\data` | **相同**（每个用户各自一份数据） |
| 卸载项 | `HKCU\...\Uninstall\TodoWorkbench` | `HKLM\...\Uninstall\TodoWorkbench` |
| 开始菜单 | 当前用户 Start Menu | `%ProgramData%\Microsoft\Windows\Start Menu\Programs` |
| 桌面快捷方式 | 当前用户桌面 | `%PUBLIC%\Desktop` |
| 多人共用一台机 | 每人装一份（≈90MB × N） | 一份程序，各自数据 |
| 升级路径 | 用户跑新安装包，零 UAC | 需 UAC；UAC 取消 → 升级失败 |
| **新增失败面** | 小 | **大**：UAC 取消、企业策略禁写 Program Files、杀软对提权进程更敏感、**elevated 启动器导致浏览器打不开（B8）** |
| 适合谁 | 个人自用、发给同事、公司里每人一份 | IT 统一部署、公用电脑、**用户没有 `%LOCALAPPDATA%` 写权限**的受限账户 |

**决策：默认 per-user，per-machine 作为明确可选项。**

理由（按权重）：
1. 这个产品的价值是"**个人**本地待办"，没有共享需求，per-machine 换不来任何东西；
2. 免 UAC ⇒ 升级只需双击一次，失败面最小；
3. per-machine 天然把启动器带进 elevated 上下文（如果安装时给 root exe 写 `requireAdministrator` 清单），**这会直接制造"浏览器打不开"**——今天要修的病，不能自己再造一个；
4. 数据本来就只有一份，per-user 和 per-machine 的数据布局可以完全一样（都在 `%LOCALAPPDATA%`），所以两种模式的差异被压缩到"程序文件放哪 + 注册表写哪"。

**per-user 之外的例外**：如果检测到 `%LOCALAPPDATA%` 不可写（今天这台机器就是），安装器**主动建议切到 per-machine** 并解释原因。这条是有实测依据的。

### 3.2 安装器清单：一个 exe，`asInvoker`，需要时自提权

不采用"per-machine 清单"的理由：一个 exe 只能有一个清单，而我们需要同一个 exe 既能免 UAC 装 per-user，又能在用户选了"所有用户"时提权。做法是 **`asInvoker` + `Verb="runas"` 自我提权重启**——清单只决定默认行为，`runas` 动词会照常弹 UAC。

**备选方案与取舍**

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 单 exe + 自提权（选它）** | `asInvoker` 清单，per-machine 时 `Process.Start(self, "/elevated ...", Verb=runas)` | 发布物只有 1 个文件，不会漏；默认路径零 UAC | 提权后是**另一个进程**，进度要靠日志文件或参数回传；用户取消 UAC 要写 `Win32Exception 1223` 的处理 |
| B. 两个 exe（`setup.exe` + `setup-admin.exe`） | 各自固定清单 | 提权语义最干净，不用二次解析 | 发布物 2 个文件，容易只发一个；payload 要内嵌两份（或外置）→ 体积翻倍 |
| C. 永远 requireAdministrator | 单清单 | 实现最省事 | per-user 也要 UAC，违背"双击即装"；且把提权上下文带进日常使用 |

方案 A 的提权协议：

```
父进程（asInvoker）
  └─ Process.Start(new ProcessStartInfo(Application.ExecutablePath,
        "--elevated --run=<guid> --dir=<安装目录> --desktop=1 --startmenu=1")
        { Verb = "runas", UseShellExecute = true })
     抛出 Win32Exception 且 NativeErrorCode==1223 → 用户取消了 UAC
           → 提示「已取消管理员授权」+ 两个选择：[改为仅为我安装] / [退出]
     WaitForExit() → 读 %LOCALAPPDATA%\TodoWorkbench\logs\setup-<guid>.log 显示结果
子进程（--elevated）
  └─ Banner「正在为所有用户安装…」（不可取消）
     执行同一套 Install(stage)，日志写同一个 setup-<guid>.log
     退出码 0/1 回传
```
要点：
- `run-id` 用 GUID，父子进程共用一个日志文件 → 父进程即使只会显示"安装失败"，用户也能把那个日志发过来。
- 提权后 `HKCU` 仍然是**发起提权的那个用户**（UAC 是同用户令牌提升），所以 per-machine 时若也要给当前用户建快捷方式，`HKCU` 是对的。但 per-machine 的规范做法是只写 All Users（`%ProgramData%` Start Menu + `%PUBLIC%\Desktop`），我们按规范来，**不碰用户的 HKCU**。
- 提权子进程**绝不能**把自己的环境/注册表写进"用户态安装"路径。

### 3.3 安装后的磁盘布局

**核心决策：启动器（thin）与 payload（胖）分离，payload 按版本落地。**

```
C:\Users\<u>\AppData\Local\Programs\TodoWorkbench\      ← <installDir>（ASCII！）
├─ TodoWorkbench.exe            启动器 ~35KB（不含 payload）
├─ uninstall.exe                卸载器 ~30KB
├─ installed.json               ← 安装清单（启动器据此判断"我是安装版"）
├─ app\
│  ├─ 1.0.0\                    ← 一个版本一个目录，绝不原地覆盖
│  │  ├─ node.exe
│  │  ├─ src\*.mjs
│  │  ├─ public\*
│  │  └─ 使用说明.txt
│  └─ 1.1.0\                    ← 升级后新增；旧的按策略清理
└─ cache\
   └─ payload-1.1.0.zip         可选：修复包（勾选才留，+35MB，见 4.3）

C:\Users\<u>\AppData\Local\TodoWorkbench\               ← 用户数据，升级永不触碰
├─ data\
│  ├─ workbench.db (+ -wal / -shm)
│  ├─ token.txt
│  ├─ instance.json             {instanceId, port, pid, version, dataDir, startedAt}
│  ├─ archive\                  完成的待办 Markdown
│  ├─ backups\
│  │  └─ pre-upgrade-1.0.0-to-1.1.0-20261020-0930\   ← 升级前自动整份备份
│  └─ logs\server-20261020.log
└─ logs\
   ├─ launcher-20261020.log
   ├─ setup-<guid>.log
   └─ uninstall-<guid>.log
```

`installed.json`（启动器唯一的"我是什么形态"判据）：

```json
{
  "schema": 1,
  "mode": "perUser",                  // perUser | perMachine
  "displayName": "待办工作台",
  "installDir": "C:\\Users\\lenovo\\AppData\\Local\\Programs\\TodoWorkbench",
  "dataDir": "C:\\Users\\lenovo\\AppData\\Local\\TodoWorkbench\\data",
  "version": "1.1.0",
  "installedAt": "2026-10-20T09:30:12+08:00",
  "uninstallKey": "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench",
  "shortcuts": ["startmenu", "desktop"]
}
```

**为什么这样切**（这是整个设计里最要命的一处取舍）：

| 方案 | 升级怎么做 | 问题 |
|---|---|---|
| 现在的单文件版：payload 内嵌 exe，解到 `%LOCALAPPDATA%\TodoWorkbench\app-<ver>` | 换 exe，下次运行解新目录 | 目录和学习成本不可控；**卸载时不清 `app-<ver>` 就留垃圾，清了又可能删到用户数据目录的邻居**；`.app` 兜底目录会散落在 exe 旁边 |
| 全塞进安装目录、数据也在里面 | 覆盖写 | per-machine 时 Program Files 不可写 → 数据写不进去；升级覆盖时旧文件残留/被锁 |
| **启动器 + `app\<ver>\`（选它）** | 加目录 + 切指针 | 需要多一层版本解析（10 行代码），换来：**原子升级、秒级回滚、能同时保留两个版本、卸载一把清干净** |

**版本解析（启动器侧，替代 `current.txt`，更简单也更抗损）**：

```csharp
// 扫 app\* 按版本降序，返回第一个"完整性校验通过且未被标记为坏"的目录
static string ResolveVersionDir(string installDir, out string version)
{
    var dirs = Directory.GetDirectories(Path.Combine(installDir, "app"))
        .Select(d => new { Path = d, Ver = Path.GetFileName(d) })
        .Where(x => Version.TryParse(x.Ver, out _))
        .OrderByDescending(x => Version.Parse(x.Ver))
        .ToList();

    foreach (var d in dirs)
    {
        if (File.Exists(Path.Combine(d.Path, "bad.mark"))) continue;      // 连续失败被拉黑
        if (!File.Exists(Path.Combine(d.Path, "node.exe"))) continue;
        if (!File.Exists(Path.Combine(d.Path, "src", "server.mjs"))) continue;
        version = d.Ver; return d.Path;
    }
    version = null; return null;
}
```
不引入 `current.txt` 是为了**消除"指针文件损坏"这个状态**：目录本身就是真相，"最高且完好"就是当前版本。

### 3.4 清单文件 `build/app.manifest`（三个 exe 共用）

```xml
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="TodoWorkbench" type="win32" />

  <!-- 关键：asInvoker。安装器需要提权时用 runas 子进程，日常运行绝不要管理员 -->
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2">
    <security>
      <requestedPrivileges xmlns="urn:schemas-microsoft-com:asm.v3">
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>

  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />  <!-- Win10/11 -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />  <!-- 8.1 -->
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}" />  <!-- 8 -->
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}" />  <!-- 7 -->
    </application>
  </compatibility>

  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <!-- 系统级 DPI：本机清晰，跨屏由系统位图缩放（WinForms 最稳的选择） -->
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <!-- 长路径：用户把安装目录选到很深的地方时不炸 -->
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
```

编译参数：`/win32manifest:build\app.manifest`（和 `/win32icon:build\app.ico` 可共存）。

> 不用 `permonitorv2`：.NET Framework 的 WinForms 需要 app.config 里配 `System.Windows.Forms.ApplicationConfigurationSection` 才真正支持，配不全会出现字体错乱。安装器界面就一屏，系统级 DPI 够用。

### 3.5 卸载项注册表：字段全表

**写入位置**（per-user / per-machine）

```csharp
// per-user
var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
var key  = root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\TodoWorkbench");

// per-machine —— 显式 Registry64：csc 默认 anycpu 在 x64 上是 64 位进程，
// 但万一以后改成 anycpu32bitpreferred，不显式指定会写到 Wow6432Node，
// "应用和功能"里表现会不一致（有时候两个条目、有时候看不到）
var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
var key  = root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\TodoWorkbench");
```

**字段**（`REG_SZ` 一律不加尾随反斜杠、路径带引号规则见备注）

| 值名 | 类型 | 内容 | 备注 |
|---|---|---|---|
| `DisplayName` | REG_SZ | `待办工作台` | 必需 |
| `DisplayVersion` | REG_SZ | `1.1.0` | 必需，来自程序集版本 |
| `Publisher` | REG_SZ | `陈春天的哥哥` | |
| `DisplayIcon` | REG_SZ | `"<installDir>\TodoWorkbench.exe",0` | 带引号+`,0`；不带会显示成默认图标 |
| `InstallLocation` | REG_SZ | `<installDir>` | **不带尾随 `\`、不带引号**，否则"打开文件位置"会错 |
| `UninstallString` | REG_SZ | `"<installDir>\uninstall.exe"` | 必需，整体带引号（路径含空格） |
| `QuietUninstallString` | REG_SZ | `"<installDir>\uninstall.exe" --quiet` | 支持静默卸载 |
| `ModifyPath` | REG_SZ | 省略（配合 `NoModify=1`） | |
| `InstallDate` | REG_SZ | `20261020` | `yyyyMMdd`，**无分隔符** |
| `EstimatedSize` | **REG_DWORD** | `92160` | 单位 **KB**；"应用和功能"的"大小"列 |
| `NoModify` | REG_DWORD | `1` | 去掉"修改"按钮 |
| `NoRepair` | REG_DWORD | `1` | 去掉"修复"按钮 |
| `VersionMajor` | REG_DWORD | `1` | 排序用 |
| `VersionMinor` | REG_DWORD | `1` | |
| `URLInfoAbout` | REG_SZ | 项目主页/README 地址（可空） | |
| `HelpLink` | REG_SZ | 同上 | |
| `Comments` | REG_SZ | `本地待办 + 归档工作台，数据只存本机` | "应用和功能"里显示 |
| `InstallSource` | REG_SZ | 安装器所在目录 | |
| `SystemComponent` | REG_DWORD | **不写**（写了就藏起来） | |

写入必须用**显式类型**，`SetValue(name, value, RegistryValueKind.DWord)`；用 `SetValue(name, 92160)` 会变成 `REG_SZ`，"大小"列不显示。

`EstimatedSize` 算法：安装完成后递归求和 `app\<ver>` + `TodoWorkbench.exe` + `uninstall.exe` 的字节数 / 1024。

### 3.6 快捷方式（`IShellLink`，不需第三方）

```csharp
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLinkCoClass { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
 Guid("000214F9-0000-0000-C000-000000000046")]
internal interface IShellLinkW
{   // 顺序即 vtable 顺序，不能调换
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
 Guid("0000010b-0000-0000-C000-000000000046")]
internal interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

internal static class Shortcut
{
    // 必须在 STA 线程上调用（安装器 UI 线程就是 STA，[STAThread] Main）
    public static void Create(string linkPath, string target, string args, string workDir, string desc, string icon)
    {
        var link = (IShellLinkW)new ShellLinkCoClass();
        link.SetPath(target);
        if (!string.IsNullOrEmpty(args)) link.SetArguments(args);
        link.SetWorkingDirectory(workDir);
        link.SetDescription(desc);
        if (!string.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);
        ((IPersistFile)link).Save(linkPath, true);
        Marshal.FinalReleaseComObject(link);
    }
}
```

创建哪些快捷方式：

| 位置 | 路径 | 目标 |
|---|---|---|
| 开始菜单（主） | per-user: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\待办工作台.lnk`<br>per-machine: `%ProgramData%\Microsoft\Windows\Start Menu\Programs\待办工作台.lnk` | `<installDir>\TodoWorkbench.exe` |
| 开始菜单（排障用，强烈建议） | 同上目录 `待办工作台（不自动开浏览器）.lnk` | 同 exe，**参数 `--no-browser`** |
| 桌面（可选勾选） | per-user: `Environment.GetFolderPath(Desktop)`<br>per-machine: `Environment.GetFolderPath(CommonDesktopDirectory)` | 同上 |

第二条快捷方式是低成本高回报：**用户报"浏览器打不开"时，让 ta 用这个快捷方式启动，就能进兜底界面拿到可复制 URL**。这比远程指导用户按 Win+R 靠谱得多。

快捷方式失效的兜底：安装器写完 `lnk` 后**立刻回读**（`IShellLinkW.GetPath`）校验目标路径存在；不存在就报警告（不致命）。

### 3.7 升级 / 回滚 / 自愈

**升级流程**（新安装包检测到 `<installDir>\installed.json` 存在即进入升级分支）

```
1. 读旧 installed.json：version_old, dataDir, mode
2. 版本相同 → 提示"已安装同版本，是否修复？（会重新解压程序文件，数据不动）"
   版本更低 → 提示"已安装更新版本 x，是否降级？（不推荐）"
   版本更高 → 正常升级
3. 停服务：读 <dataDir>\server.pid（并按 B7 校验镜像路径）→ kill → 等最多 5s
   （另外先探一次 instance.json 的端口，能通就先 kill 掉，避免 pid 文件过期）
4. 【数据保险】把 workbench.db / -wal / -shm 复制到
   <dataDir>\backups\pre-upgrade-<old>-to-<new>-<yyyyMMdd-HHmm>\（含一个 .txt 说明）
   —— 这一步在动任何程序文件之前做，是最便宜的"升级不丢数据"保证
5. 解压 payload 到 app\<new>\（新目录，完全不碰 app\<old>\）
6. 完整性校验 app\<new>\node.exe + src\server.mjs（大小非 0）
7. 覆盖 <installDir>\TodoWorkbench.exe 和 uninstall.exe（这两个是老版本唯一被覆盖的文件，
   覆盖前先 File.Copy 到 <installDir>\.swap\ 作为回滚备份 —— 万一新启动器有问题）
8. 重写 installed.json（version=new）
9. 更新 Uninstall 注册表中 DisplayVersion / EstimatedSize / InstallDate
10. 重建快捷方式（指向不变，一般不必，但目标 exe 可能被替换过 → 重建一次最省事）
11. 清理旧版本：保留 new 和 old 两个，更早的删掉（删之前确认不是 new 也不是 old）
12. 完成页：勾选"立即运行"
```

**回滚（三条路径，全部不需要用户重新下载）**

| 触发 | 机制 |
|---|---|
| 新版本 `app\<ver>` 不完整（解压中断） | 安装器在步骤 6 失败 → 删掉半成品目录、把 `installed.json` 的 version 改回 `old` → 提示"升级失败，已保持 x 版本，你的数据没动" |
| 新版本能装但**起不来**（node 崩、schema 不兼容） | 启动器记录失败：`<exeDir>\app\<ver>\bad.mark`（内容 = 失败次数 + 最后错误摘要）。同一版本连续失败 2 次 → 写入 `bad.mark`，下次启动自动跳过它，落到上一版；并在兜底窗里告诉用户"新版本启动失败，已自动回到 1.0.0" |
| 用户在"应用和功能"里直接卸载重装 | 正常卸载保留数据（默认勾选），重装后数据还在 |

`bad.mark` 的清理：安装器下次成功安装该版本时删除它；用户点"再试一次"时也删。

**自愈（可选，安装器里一个勾选框）**

勾选"保留修复包（+35MB）"时，把安装用的 `payload.zip` 留在 `<installDir>\cache\payload-<ver>.zip`。启动器发现某版本 `node.exe` 缺失（杀软删了），且 `cache\payload-<ver>.zip` 存在 → 就地重新解压该版本并校验。不勾选则提示"程序文件缺失，请重新运行安装包（数据不受影响）"。默认**不勾**（省 35MB），企业/无人值守部署时勾上。

### 3.8 数据目录：三条规则

1. **数据目录永远不在安装目录里。** 安装版一律 `%LOCALAPPDATA%\TodoWorkbench\data`（无论 per-user 还是 per-machine）。这保证：升级不碰、卸载可保留、per-machine 时 Program Files 的只读性不影响写入。
2. **便携版保持现状**（exe 旁的 `工作台数据`），方便"拷走文件夹 = 备份全部"。判据：exe 旁没有 `installed.json` 且 payload 内嵌/exe 旁有 `src\`。
3. **首次以安装版运行时的迁移**：若 `%LOCALAPPDATA%\TodoWorkbench\data\workbench.db` 不存在，而 `<exeDir>\工作台数据\workbench.db` 或 **原单文件版遗留的 `%LOCALAPPDATA%\TodoWorkbench\app-*\` 旁边的数据**存在 → 弹窗：

```
检测到你以前用过便携版，数据在：
  E:\SFH office\workbench\dist\工作台数据
要把它迁移到正式安装位置吗？
  [ 迁移（推荐，原目录保留改名为 工作台数据.bak-20261020-0930） ]
  [ 不迁移，从空数据开始 ]
```
迁移 = 复制 `workbench.db(-wal/-shm) / archive\ / backups\ / token.txt`，**原目录改名而不是删除**（用户的东西，永远不要替 ta 删）。

### 3.9 无网络无第三方：构建管线改造（`scripts/build-dist.mjs`）

新增/变更的产物：

| 产物 | 由谁编译 | 内嵌资源 |
|---|---|---|
| `dist\待办工作台\`（便携文件夹） | 现状不变 | 无 |
| `dist\待办工作台.exe`（便携单文件） | `Launcher.cs` + `Browser.cs` + `FallbackForm.cs` + `Diagnostics.cs` | `payload.zip` |
| **`dist\待办工作台-安装程序.exe`（新增）** | `Installer.cs` + 上述共用文件 | `payload.zip`、`launcher.exe`、`uninstaller.exe` |
| **`dist\待办工作台-安装程序.zip`（新增，分发用）** | Compress-Archive | — |
| `dist\待办工作台-便携版.zip` | 现状不变 | — |

构建顺序（改后的 `build-dist.mjs`）：

```
0. 读 package.json version → 生成 build\gen\Version.g.cs（AssemblyVersion / AssemblyFileVersion /
   AssemblyInformationalVersion），替换掉 Launcher.cs:18-20 的手写版本 —— 顺手修 B12
1. 便携版目录（现状）
2. 编译 Launcher.exe          → build\out\TodoWorkbench.exe       （/win32manifest:app.manifest）
3. 编译 Uninstaller.exe       → build\out\uninstall.exe
4. 打 payload.zip             = src\ + public\ + node.exe + 使用说明.txt
5. 便携单文件 = csc Launcher.cs + /resource:payload.zip
6. 安装器 = csc Installer.cs  + /resource:payload.zip,payload.zip
                              + /resource:build\out\TodoWorkbench.exe,launcher.exe
                              + /resource:build\out\uninstall.exe,uninstaller.exe
                              + /win32icon:app.ico + /win32manifest:app.manifest
7. 打 dist\待办工作台-安装程序.zip（= 安装程序.exe + 使用说明.txt）
```

csc 参考集（安装器/卸载器需要额外加 `System.Drawing.dll`）：

```
/r:System.Windows.Forms.dll /r:System.Drawing.dll
/r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll
```

**注意 `Installer.cs` 里怎么从自身资源取 `launcher.exe`**：资源名就是 `launcher.exe`（不带扩展名规则变化），用
`Assembly.GetExecutingAssembly().GetManifestResourceStream("launcher.exe")`。
（`payload.zip` 沿用现在的 `HasResource()` 兜底写法，因为它可能被加上命名空间前缀。）

### 3.10 安装器界面（一个 Form，三页 Panel 切换）

```
┌─ 待办工作台 安装程序 1.1.0 ────────────────────┐
│                                                 │
│  安装给谁                                       │
│   (•) 仅为我安装（推荐）  不需要管理员权限       │
│   ( ) 为这台电脑上的所有用户安装  需要管理员权限  │
│                                                 │
│  安装位置  [C:\Users\lenovo\AppData\Local\Programs\TodoWorkbench  ] [浏览…]
│            需要约 95 MB 可用空间，当前可用 xxx GB
│                                                 │
│  [x] 创建桌面快捷方式                            │
│  [x] 创建"不自动开浏览器"的排障快捷方式          │
│  [ ] 保留修复包（+35MB，程序文件被杀软删除时可自愈）│
│  ─────────────────────────────────────────────  │
│  你的待办数据将保存在：                          │
│    C:\Users\lenovo\AppData\Local\TodoWorkbench  │
│  升级/卸载都不会删除这里。                       │
│                                                 │
│                          [ 取消 ]  [ 安装 ]     │
└─────────────────────────────────────────────────┘
```

进度页要有**逐步文字日志**（不是只有进度条）：`正在解压程序文件…（12/19）`、`正在注册卸载信息…`，每行同时写进 `setup-<guid>.log`。用户报障时那片文字就是最好的证据。

### 3.11 顺手要做的两件事

1. **剥 MOTW**：安装器把 `TodoWorkbench.exe` 复制到安装目录后，调用 `DeleteFile("<path>:Zone.Identifier")`（`[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool DeleteFile(string lpFileName)`）去掉"来自 Internet"标记，减少日后被 SmartScreen 拦的概率。（对**安装器自身**无效——它运行时还没被复制。）
2. **文档里明确写**：未签名的 exe 首次运行会出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。想彻底消除只能买代码签名证书（EV 证书才能直接过 SmartScreen），这是成本问题不是技术问题。

---

## 4. ③ 失败兜底与日志

### 4.1 日志布局与规范

**位置**

| 谁 | 写哪 | 轮转 |
|---|---|---|
| 启动器 | `%LOCALAPPDATA%\TodoWorkbench\logs\launcher-yyyyMMdd.log`（四级回退，见 2.5-1） | 按天，单文件 >2MB → `.1`，保留 14 天 |
| 服务（node） | `<dataDir>\logs\server-yyyyMMdd.log` | 按天 + >5MB 轮转，保留 3 个 |
| 安装器 | `%LOCALAPPDATA%\TodoWorkbench\logs\setup-<guid>.log` | 每次一个，保留 10 个 |
| 卸载器 | `%LOCALAPPDATA%\TodoWorkbench\logs\uninstall-<guid>.log` | 同上 |

**服务侧日志要靠代码写，不能靠 `cmd >`**（B2/B3）。新增 `src/log.mjs`：

```js
// src/log.mjs —— node 自己写日志，摆脱 cmd 重定向（它会截断/被锁/被引号搞坏）
import fs from 'node:fs';
import path from 'node:path';

export function openLog(dir, { keepDays = 14, maxBytes = 5 * 1024 * 1024, prefix = 'server' } = {}) {
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let file = path.join(logDir, `${prefix}-${day()}.log`);
  let stream = fs.createWriteStream(file, { flags: 'a' });

  const write = (level, args) => {
    const line = `${new Date().toISOString()} [${level}] ` +
      args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log(line);                          // 控制台里也留一份（开发时直接看）
    try {
      if (stream.bytesWritten > maxBytes) {    // 同一天超过 5MB 就换 .1
        stream.end();
        try { fs.renameSync(file, file + '.1'); } catch {}
        stream = fs.createWriteStream(file, { flags: 'a' });
      }
      stream.write(line + '\n');
    } catch { /* 日志写不出去不能影响主流程 */ }
  };

  // 接管 console：现有 30+ 处 console.log/error 全部自动落盘，零改动
  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { write(lvl.toUpperCase(), a); };
  }
  // 未捕获异常：先落盘再退，否则"闪退无日志"
  process.on('uncaughtException', (err) => { write('FATAL', [err]); process.exit(1); });
  process.on('unhandledRejection', (err) => { write('FATAL', ['unhandledRejection', err]); });
  for (const f of fs.readdirSync(logDir)) {   // 清理过期日志
    const m = f.match(new RegExp(`^${prefix}-(\\d{8})\\.log`));
    if (!m) continue;
    if ((Date.now() - new Date(`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`)) / 86400000 > keepDays)
      try { fs.unlinkSync(path.join(logDir, f)); } catch {}
  }
  return { path: file };
}
```
在 `server.mjs` 里、`dataDir` 算出来之后（`:31-32` 之后）立刻调用：`openLog(dataDir)`。
注意：这里覆盖 `console.log`，而 `console.log(line)` 在 `write` 里又会调回自己 → 死循环。落地时把 `console.log(line)` 改成 `origLog(line)`（保存原始引用）。**这是实现时最容易踩的一个坑，先写在这里。**

**日志格式**（统一到可以 grep）

```
2026-10-20T09:27:28.914+08:00 [INFO ] stage=resolveAppDir mode=installed dir=E:\...\app\1.0.0
2026-10-20T09:27:29.103+08:00 [INFO ] stage=resolveDataDir dir=E:\...\工作台数据 writable=true
2026-10-20T09:27:29.220+08:00 [INFO ] stage=launch node=E:\...\node.exe port=7861
2026-10-20T09:27:31.050+08:00 [INFO ] stage=healthy url=http://127.0.0.1:7861/ instance=ab12cd port=7861
2026-10-20T09:27:31.052+08:00 [INFO ] browser: begin url=... elevated=False shell=True
2026-10-20T09:27:31.410+08:00 [WARN ] browser: L1 fail native=1155 hresult=0x80004005 msg=没有应用程序与此操作的指定文件有关联
2026-10-20T09:27:31.560+08:00 [INFO ] browser: L2 ok (explorer.exe forward)
```

规则：**每个 stage 一行、一行内 `k=v`**，让"哪一步停的"一眼可见；级别只用 INFO/WARN/ERROR/FATAL；不打印 token、不打印待办内容。

### 4.2 安装失败矩阵

| 失败点 | 现象 | 处理 | 用户看到 |
|---|---|---|---|
| 目标目录写不进去（选了 `C:\` 或 Program Files 但选 per-user） | `UnauthorizedAccessException` | 不静默回退 | 「这个位置需要管理员权限」+ [改用默认位置] / [以管理员身份安装到这里] |
| 目标目录被别的程序占用 | 有 exe 但没有我们的 `installed.json` 且目录非空 | 拒绝安装 | 「该文件夹里已有其他程序，请换个位置」 |
| 磁盘空间不足 | `IOException` | 安装前 `DriveInfo` 检查 `可用 > 3 × payload`（≈120MB） | 「需要约 120MB 可用空间，当前只剩 xx MB」 |
| 解压中途失败（杀软锁文件 / 压缩包损坏） | `InvalidDataException` 带文件名 | 删半成品 `app\<ver>`，重试 1 次；再失败→报具体文件名 | 「解压 xxx 失败，请把杀毒软件加入白名单后重试」+ [打开日志] |
| 注册表写入失败（per-machine 但没提权） | `UnauthorizedAccessException` | **回滚**：删 `app\<ver>` + 删已建快捷方式 | 「注册卸载信息失败，已撤销安装」+ 以管理员重试按钮 |
| 快捷方式创建失败 | `COMException` | **不致命**，记 WARN，继续 | 完成页脚注「桌面快捷方式创建失败，可从开始菜单启动」 |
| 用户在 UAC 处取消 | `Win32Exception 1223` | 不报错 | 「已取消管理员授权」+ [改为仅为我安装] / [退出] |
| 提权子进程崩溃 | 退出码 ≠ 0 | 父进程读 `setup-<guid>.log` 尾部显示 | 「安装未完成」+ 日志尾部 + [复制诊断] |
| 升级时服务停不掉（pid 失效/别的实例） | kill 失败 | 依次：`instance.json` 端口探活 → kill pid（校验镜像）→ `taskkill /PID` → 仍失败则提示"关掉黑色的命令行窗口后重试" | 明确文案，不要静默继续 |
| 升级时数据备份失败 | 复制 db 出错 | **中止升级**（没有备份就不动程序） | 「升级前的数据备份失败，已取消升级」 |
| 安装器自身被 SmartScreen 拦 | 根本没启动 | 代码无解 | 文档 + 首次运行说明（3.11-2） |
| 安装到含中文/空格的目录后 node 起不来 | 已用 `Process.Start(exe, args)` 而非 cmd | 安装完成后**立刻试启动一次并做健康检查**，失败就把 `app\<ver>\bad.mark` 写上并以"安装完成但有警告"结束 | 完成页「程序已安装，但自检未通过，请点『查看日志』」 |

**安装器收尾自检（强烈建议做）**：安装完成后静默起一次服务（`WB_NO_OPEN=1` + 随机端口），打 `/api/health`，成功就停掉、显示「安装完成，自检通过」。这一步能把"装完才发现用不了"提前到安装现场，是这套安装器最有价值的一步。

### 4.3 卸载失败矩阵

| 失败点 | 处理 |
|---|---|
| 服务在跑 | 先按 `instance.json` 端口 → `/api/health` 确认是自己的实例；然后 kill pid（校验镜像路径），轮询最多 5s |
| 卸载器不能删自己 | **复制自己到 `%TEMP%\twb-uninstall-<guid>.exe`，用副本继续**（副本不在安装目录里，可以随便删安装目录）；原进程立刻 `Environment.Exit(0)` |
| 文件被占（杀软扫描、资源管理器预览） | 重试 3 × 300ms；仍失败 → 把待删项写进 `PendingFileRenameOperations`（`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager`，管理员）或降级为 `cmd /c ping -n 4 127.0.0.1 >nul & rd /s /q "<dir>"`，并提示「重启后完成清理」 |
| 副本删不掉自己 | `MoveFileEx(tmp, null, MOVEFILE_DELAY_UNTIL_REBOOT)`（0x4），只能尽力 |
| 数据要不要删 | 默认**保留**：`[x] 保留我的待办数据（推荐）`，并显示数据目录路径。取消勾选后**二次确认**「将永久删除 xxx 条待办、xxx 个归档文件，无法恢复」 |
| 注册表项不存在（手工删过） | 不当成错误，继续 |
| per-machine 但当前不是管理员 | 检测到 `HKLM` 项 + 非提权 → 用 `runas` 自提权重跑卸载器（同一个协议） |
| 删完注册表但目录残留 | 以 `installed.json` 的 `installDir` 为准再删一次；仍失败 → 提示路径让用户手删 |

### 4.4 首次运行失败矩阵

| 情况 | 判定 | 处理 |
|---|---|---|
| `installed.json` 里 `dataDir` 不可写 | 写 probe 失败 | 本次改用 `%LOCALAPPDATA%\TodoWorkbench\data`，**在兜底窗显示实际数据路径**（B11 的根治：永远显示真实路径，不写死） |
| `app\<ver>` 不完整 | `ResolveVersionDir` 校验失败 | 有 `cache\payload-<ver>.zip` → 自动重解压；没有 → 兜底窗「程序文件缺失」+ [重新运行安装包] |
| 所有版本都被 `bad.mark` 拉黑 | `ResolveVersionDir` 返回 null | 兜底窗：「没有可用的程序版本」+ 列出 `app\*` 与各自的失败原因 + [打开日志] |
| node 起不来（exit ≠ 0 或 30s 无健康） | 立即读 `server.log` 尾部 | 兜底窗形态 B，**内联日志尾部**，不用用户去找文件 |
| 数据目录在但不是 SQLite / db 损坏 | node 报错落 `server.log` | 检测到 `file is not a database` → 提示「数据库文件损坏」+ [用最近的备份恢复]（列 `backups\` 里最新 3 个，让用户选） |
| 端口全被占（7861-7871） | 11 个端口全 refused 不上 | 让启动器自己挑：先 `TcpListener(IPAddress.Loopback, 0)` 拿一个空闲端口，以 `WB_PORT` 传入；再不行让用户重试 |
| 升级后 schema 不兼容 | node 起不来 + 日志里有 `no such table/column` | 兜底窗：「新版本无法读取旧数据」+ [回到上一版本]（删/拉黑 `bad.mark` 并给出上一版目录）+ [查看 pre-upgrade 备份] |
| 用户机器上遗留 `WB_LAUNCHER_NOBROWSER` | 环境变量存在 | 写 WARN，**仍然弹兜底窗**显示 URL |

### 4.5 支持包（P2，但很值）

托盘菜单/兜底窗里放一个「导出诊断包」：把最近 3 个 `launcher-*.log`、`server-*.log`、`installed.json`、系统信息（OS 版本、`node.exe` 架构、`%LOCALAPPDATA%` 可写性、默认浏览器 ProgId、端口占用快照）打成一个 zip 到桌面，文件名 `待办工作台-诊断-20261020-0931.zip`。用户报障只需要发一个文件。

---

## 5. 改动清单（文件级，按优先级）

### P0 —— 不做这些，问题无法被诊断也无法被验证

| 文件 | 动作 |
|---|---|
| `build/Launcher.cs` | `Log()` 改四级回退 + 按天轮转（B1/B2）；去掉 `cmd /c`，直接 `Process.Start(node, args)`（B3）；`.ready` → `.ready.json` 完整性校验（B4）；停服务校验镜像路径（B7）；`WB_SKIP_BROWSER` → `WB_LAUNCHER_NOBROWSER`（B10）；失败提示显示真实数据目录（B11） |
| `build/Launcher.cs` | 三处开浏览器统一走 `Browser.Open()` |
| `build/Browser.cs`（新） | L1–L4 降级 + `IsElevated` + `Quote` + 完整日志 |
| `build/FallbackForm.cs`（新） | 形态 A / B + 「复制全部诊断信息」 |
| `build/Diagnostics.cs`（新） | `BuildReport()` |
| `src/server.mjs` | 合并 `/api/health` 到一处并加 `instanceId/pid`（B5）；启动时写 `instance.json` + `server.port`；`openLog(dataDir)` |
| `src/log.mjs`（新） | 日志接管 + 轮转 + `uncaughtException` |
| `build/app.manifest`（新） | 3.4 全文 |

### P1 —— 安装程序本体

| 文件 | 动作 |
|---|---|
| `build/Installer.cs`（新） | 三页 UI + per-user/per-machine 分支 + `runas` 自提权 + 解压 + 注册表 + 快捷方式 + 升级/备份 + 自检 |
| `build/Uninstaller.cs`（新） | 停服务 + 保留数据选项 + 副本自删 + `PendingFileRenameOperations` |
| `build/Shortcut.cs`（新） | 3.6 的 COM interop |
| `build/Registry.cs`（新） | `RegistryView.Registry64` 显式 + 类型显式 |
| `scripts/build-dist.mjs` | 生成 `Version.g.cs`；新增 installer/uninstaller 编译步骤；新增 `-安装程序.zip` |
| `build/version.txt` 或 `package.json` | 版本单一来源（B12） |

### P2 —— 体验与运维

托盘图标；`--no-browser` 参数；诊断包导出；`cache\payload` 自愈；迁移提示。

---

## 6. 验收清单（照着跑，全绿才算完）

**A. 浏览器打开（每一格都要过）**
1. 普通用户双击 → 浏览器打开，`launcher-yyyyMMdd.log` 里能看到 `browser: L1 ok`。
2. 默认浏览器改成 Chrome / Edge / 360 各试一次。
3. `设置→默认应用` 里把 http 关联清空 → 双击 → **应出现兜底窗形态 A**，URL 可复制，点「再试一次」不崩。
4. 以管理员身份运行 exe → 日志出现 `L1 skipped (self elevated)`，浏览器**以普通权限**打开。
5. 杀掉 explorer.exe（任务管理器 → 结束任务）后双击 → 走 L3/L4 或兜底窗，不静默。
6. 手工 `setx WB_LAUNCHER_NOBROWSER 1` → 双击 → 有 WARN 日志 + 兜底窗。
7. 占了 7861-7871 全部端口 → 启动器挑到别的端口，日志里能看到实际端口。

**B. 服务健壮性**
8. 删掉 `app\<ver>\node.exe` 再双击 → 自动重解压（便携版）/ 兜底窗提示（安装版），**不能**"启动失败"一句话了事。
9. 把 `工作台数据\workbench.db` 改成非法内容 → node 报错 → 兜底窗内联日志尾部。
10. 让 `%LOCALAPPDATA%` 不可写（用一个没有写权限的账户）→ 日志落到 `<exeDir>\logs`，兜底窗里 `logPath` 显示的是真实位置。

**C. 安装程序**
11. per-user 安装 → 不弹 UAC；`%LOCALAPPDATA%\Programs\TodoWorkbench` 结构符合 3.3。
12. 「应用和功能」里能看到「待办工作台 1.1.0 / 陈春天的哥哥 / 大小 ~90MB / 卸载」。
13. per-machine 安装 → 弹 UAC 一次；装到 `%ProgramFiles%`；`HKLM`（**64 位视图**）有卸载项；All Users 开始菜单有快捷方式。
14. per-machine 安装后**普通用户双击快捷方式** → 浏览器能打开（验证启动器没有被提权）。
15. 升级 1.0.0 → 1.1.0：`app\` 下两个目录、数据不变、`backups\` 里出现 `pre-upgrade-*`、注册表 `DisplayVersion` 更新。
16. 升级中途断（安装器里加一个 `/failtest` 开关制造失败）→ 旧版本仍能启动，数据完好。
17. 装到一个含空格和中文的目录（如 `D:\我的 软件\工作台`）→ 一切正常。
18. 安装器在**无网络**环境下完整跑通（断网、无任何第三方依赖）。
19. 卸载（保留数据）→ 目录清干净、注册表清干净、`%LOCALAPPDATA%\TodoWorkbench\data` 还在、卸载器自身不残留。
20. 卸载（删数据）→ 二次确认后数据目录也没了。
21. 卸载时服务在跑 → 先停再删，无残留进程。

---

## 7. 明确不做的

- **不引入第三方安装器**（WiX/Inno/NSIS）：违反约束，且会把"一个 csc 就能编"的构建链变成需要装工具链。
- **不做开机自启/常驻服务**：需求里没有，加了就要处理"用户不知道怎么关"的客服成本。托盘图标够用。
- **不做自动更新检查**：无网络约束。升级靠用户跑新安装包，`installed.json` 里版本号足够做"有新版请重装"的提示（P2）。
- **不做 per-machine 下的多用户共享数据**：数据永远按用户隔离，这既是隐私承诺（"数据不出本机"）也是技术上的减法。
- **不给启动器加 `requireAdministrator`**：这是 2.2 B8 的根源，加了等于自造"浏览器打不开"。
