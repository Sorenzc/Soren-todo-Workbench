# 待办工作台 → DSH 插件：落地方案（2026-10-20）

> 结论来自专家团（软件架构师 / UI 设计师 / UI 视觉验收设计师）独立分析 + 主理人对关键依据的复核。
> 复核方式：直接从 `E:\DSH\resources\app.asar` 只读解包抽取文档，不修改任何 DSH 文件。

---

## 1. 总体结论

**有条件可行，且属于「低成本高收益」的改造**，但有两个前提必须先验证：

1. 插件入口走 DSH 官方的「侧栏图标 + 全局主面板」槽位（已由官方文档证实可用）；
2. 前端必须放弃 iframe，改为 React 槽位内的组件；现有 2200 行命令式渲染需要一次容器化改造（外层 React 壳 + 注入 transport），而不是整页重写。

**不成立的期待**：目前**没有官方插件商店**。可分发的通道是 `plugin_manager` 的四种 spec——npm registry / git 仓库 / tarball / 本地路径；dsh.so、dsh.works 一类社区目录本质是「索引 npm 名或 git URL」，不是 DSH 内建市场。对外说法建议是「开源仓库 + npm 包，可一键安装」，而不是「上架商店」。

---

## 2. 主理人复核过的硬事实（可作为方案地基）

| 事实 | 依据（asar 内路径） |
|---|---|
| 插件页面必须以 React 组件渲染进槽位；**禁止 Host 供 HTML + iframe 内嵌**（iframe 拿不到主题 token、明暗切换、`ctx.locale`） | `…/skills/cordis-plugin-development/references/practices.md`："Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe…" |
| 只允许用 `--dsw-alias-*` 主题 token；字面色只用于插图；间距/字号/行模式要抄同类宿主页（管理列表参考 Plugin Manager 页） | 同上："Style with the theme tokens … literal colors are for artwork only." |
| 禁止 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 Harness Client 包；组件抛错会**整块槽位空白**（`slot entry crashed`） | 同上 |
| 官方入口范式：`sidebar.panellist` 注册图标行（`id` + 可选 `order` + label），**同一个 id 对应 layout 的根级 `main` 键控槽位**；`main` 缺条目时抛错且不切换 | `dsh-client-ui-sidebar/README.md` |
| 安装通道 = pnpm 的 registry / git / tarball / path 四种 spec；运行中的 bundle 替换会报 `restart-required`；安装动作需要 `danger-full-access` 或逐次审批；Host 插件代码**在 DSH 进程内、工作区沙箱之外**执行 | `dsh-plugin-manager/README.md` |
| 现有前端的改造面很小：`public/app.js` 2215 行、**只有 2 处 `fetch(`**（同一个 `request(method,path,body)` 收敛点，带 `x-wb-token`）、`el()` 工厂集中、20 个 `render*`；`styles.css` 936 行 / 75 个变量 / 393 处 `var(--` / 仅 76 处硬编码 hex | 架构师代码实测 |

---

## 3. 入口：放在哪、点开是什么

**首选（唯一推荐）**：侧栏图标 → 全局「工作台」页。

- 槽位：`sidebar.panellist`（`id: workbench`，`order: 20`，避让 `ui-schedule` 的 10 与 Plugin Manager 的 0）；
- 页面：`main` 槽位 `key: workbench`，**全局页、不属于任何 Session**（与 Plugin Manager 页同构）；
- 图标：16/18px 单色图形，跟随 `--dsw-alias-*`；
- 备选（只做快速录入，不做第二入口）：`/todo` 斜杠命令。顶栏**没有**第三方按钮槽位，不要自造浮层按钮。

**明确删除的三件**（否则一眼「外挂感」）：

1. 自有标题栏（`public/index.html` 的 titlebar）；
2. 自有 Ctrl+K 命令面板（DSH 没有全局命令面板；命令属会话内）；
3. 固定 380px 详情列 + 236px 左侧 rail（DSH 侧栏本身就是 rail，双栏嵌套最扎眼）。

---

## 4. 窗口与视图清单

| 窗口/视图 | 承载方式 | 内容 |
|---|---|---|
| 工作台主面板 | `main` 全局页 | 顶部分段（即将逾期 / 本周 / 全部 / 已完成 / 统计）+ 分组内嵌卡片列表 + 底部状态条（未完成·逾期·今天·已完成 + 快捷键提示） |
| 任务详情 | 面板内右侧抽屉 360px（<768 变 sheet） | 标题、完成并归档、安排（分类/优先级/截止/时间/预估）、笔记、标签、关联文件夹、动态；**不要**做成通用 CRUD 表单 |
| 新建/编辑 | 面板内 Modal（自绘，抄宿主焦点与 Esc 行为） | 标题、分类、日历选日期、优先级、标签、预估、笔记、文件夹、每月例行 |
| 月历 | 面板内浮层（**不要 append 到 body**） | 6×7 格、到期/完成双点、‹ › 翻月、回到今天；点某天进「当天」 |
| 联系人 / 激励作者 | 面板内 Modal | 二维码 + 说明（保留现有文案与素材） |
| 设置 | 面板内 Modal 或宿主 Settings 子页 | 提前天数、沉睡阈值、本周范围、归档目录、备份 |
| 全局 toast | `shell.overlay` | 仅归档成功/失败、撤销 |

---

## 5. UI 如何与 DSH 匹配

- **只允许 `--dsw-alias-*`**：现有 75 个自定义变量整体映射为别名层；76 处硬编码 hex 清零。主色从 `#2563EB` 换 `--dsw-alias-state-business-primary`（浅 `#4176e6` / 深 `#7aaaff`），卡片圆角 10px → `--dsw-radius-md`（12px）。
- **字号必须跟随宿主**：宿主字号是用户可调基准（10–22px），现有 9 档固定 px 会静默忽略该设置（无障碍回归）。改为 rem/相对宿主基准，档位数量保留但不写死 px。
- **密度默认 36px 行高**（现 40px 是 iOS 分组语义），提供 28/36/40 三档；分组头 24→28px。
- **断点按面板实际宽度**（用 `ResizeObserver` 观测面板根元素，不判视口）：≥1080 三列 / 900–1079 抽屉 / 720–899 收 rail / <720 单列 / <480 折叠。
- **顶部让位**：入口型主面板用 `--dsh-frame-top-clearance` 做顶部内边距。
- **类名统一 `wb-` 前缀**，深色由宿主切换（删除 `.dark` 与 `applyTheme()`）。
- 十雷区（上线前拦截）：自有标题栏、主色 `#2563EB`、10px 圆角 + 40px 行高、通用「暂无数据/加载中」、灰图标居中空态、优先级只靠颜色、表格斑马纹、搬 Ctrl+K、右栏 tab 自带标题行、深色只靠 `prefers-color-scheme`。

设计稿与规格书（本次产出）：
- `docs/dsh-plugin-ui-design-2026-10-20.md`（入口/7 个窗口/token 映射表/12 个组件/断点/无障碍/十雷区/验收清单）
- `docs/design-preview/dsh-workbench-mockup.html`、`dsh-shot-A-1440.png`、`dsh-shot-B-1440.png`

---

## 6. 技术架构

**进程模型**：全部跑在 DSH Host 进程内；**不起子进程、不监听端口、不出站网络**。

**包结构**（照 `templates/decoration` 的最小可用形状，无构建）：

```
package.json     exports {".":"./index.js","./client":"./client.js","./locale/*.json","./icon"}
                 dsh.bundle.patch / dsh.client{platform:"web",inject:[...]}
cordis.patch.yml insert: [{ id: workbench, name: '<pkg>' }]
index.js         Host 半：领域服务 + 仓储适配 + 归档写盘
client.js        Client 半：window.__ModuleLoader__.load({ id, factory(require){ const React=require('react'); … } })
locale/{en,zh}.json   icon.svg
```

**数据层（关键决策）**：插件运行期用 `ctx.storageDomain` 领域表 `workbench` v1（category / tag / task / taskTag / taskLink / taskEvent / series），旧的 `data/workbench.db` 只做**一次性导入源**（只读打开、幂等 upsert、dry-run 报告、源文件不动）。归档 Markdown 仍写真实文件，根目录进插件 `Config`。

**领域层复用**：`src/` 里的 `tasks / series / focus / archive / recur / util` 是纯函数，直接复用；只把 `db.mjs` 换成「仓储端口 + 两个适配器」（`legacy-sqlite` 供现有测试，`storage-domain` 供插件），不引入 DI 容器。

**传输桥**：Client ↔ Host 需要定型，三种选择——
1. 宿主 Remote 装饰器（需要一次单文件转译）；
2. 手写 Remote 描述符（无构建，但属未文档化内部约定，跨版本可能破裂）；
3. 命令桥（零构建，但绑 `sessionId`、无推送）。
建议 M0 用半天做 spike 2，不行再接受一次 esbuild 转译。

**`server.mjs` 的边界**：保留为测试夹具（现有 226 项断言走 HTTP/CDP），插件 Host 半不复用它的路由层。

---

## 7. 依赖与权限

| 项 | 结论 |
|---|---|
| 第三方运行时依赖 | 0（Host = 宿主 Node 24.x；Client = 宿主模块表里的 React） |
| Node 能力 | `node:fs`/`node:path` 常用；`node:sqlite` 只出现在导入适配器里按需动态 import |
| 子进程 | 默认不用。「打开关联文件夹」改用宿主能力（**待核对** `packages/shell` 是否有该能力） |
| 网络 | 出站 0、监听 0 |
| 文件系统 | 归档根目录、插件 Config、旧库只读路径 |
| 剪贴板 | 浏览器 API，不走 Node |
| 安装权限 | 安装动作本身需要 `danger-full-access` 或逐次审批（需在文档里对用户明说） |

---

## 8. 分发与版本

- 通道：npm 公开包（首选，`plugin_manager` 直接 `install_bundle` 包名）+ Git 仓库（源码可读、审阅友好）+ tarball/本地路径（内测）。
- 包内不带 postinstall（规避 pnpm 11 的 build-script 审批摩擦）；`engines.dsh` 写正确 peer 区间，避免走兼容豁免。
- 按「插件市场索引格式」提案（状态仍是 proposed）预置元数据：`title/description`（`en`+`zh`）、`icon` ≤256 KiB 且包内、`engines.dsh`。
- 升级语义要写进文案：替换已加载的 JS 模块**需要重启 DSH**（`restart-required`）。
- 数据兼容：插件 semver + 域 `version` 整数；读到更高版本域明确拒绝，不静默降级；归档 Markdown 格式冻结。
- 未发现插件签名机制（待核对）；安全审查 = peer 兼容检查 + 用户审批 + 目录方人工审核。

---

## 9. 里程碑与工作量（约 16 人日）

| 里程碑 | 内容 | 验收标准 | 估算 |
|---|---|---|---|
| M0 影子验证 | 空面板上屏（`sidebar.panellist` + `main`）；数据往返（spike）；`storageDomain` 打开 | 出现「工作台」入口并能切换；面板读到 3 条种子任务；明暗两色无硬编码色；无 `slot entry crashed` | 1.5 d |
| M1 只读迁移 | 旧库导入器（幂等 + dry-run）+ 今日/近期/全部/统计只读 | 计数与 `doctor.mjs` 一致；重复执行零新增；源库 mtime 不变 | 3 d |
| M2 写路径 | 增删改、完成归档 Markdown、每月例行、详情 | 完成任务后 `archive/YYYY/YYYY-MM/*.md` 落盘；36 期例行与旧版逐行一致 | 3 d |
| M3 视觉对齐 | token 全量映射、`wb-` 前缀、删 rail/删 `.dark`、密度与字号跟宿主 | 面板内无 hex 色值；与 Plugins 页并排无违和；字号随宿主设置变化 | 3 d |
| M4 打包分发 | manifest/locale/icon、`npm pack` 干跑、干净 profile 安装/升级/卸载 | 新机一次装成功；升级提示正确；卸载数据策略符合文档 | 1.5 d |
| M5 硬化 | 迁移幂等、错误态、拒绝更高域版本、冒烟 | 断网/只读/缺目录三种降级都有可读提示 | 2 d |
| 验收 | 视觉门禁 + 十雷区逐条 | 见 `docs/dsh-plugin-ui-design-2026-10-20.md` §7/§9 | 1 d |

---

## 10. 关键分歧与裁决

| 分歧 | 两方观点 | 裁决 |
|---|---|---|
| 能否 iframe 复用现有 SPA | UI 设计师：「同源可行，可作过渡」；架构师/视觉验收：「违反 practices.md」 | **不用于交付**。主理人已复核原文：禁止 Host 供 HTML + iframe。仅允许本地 spike 自用，不作为上架形态、不拍商店截图 |
| 前端改造方式 | 架构师：「容器托管」= 保留命令式 `app.js`，外套 React 壳 + 注入 transport；视觉验收：「必须 React 重写视图层」 | **先试容器托管**（改动面 3 处：`request()` 抽 transport、`$`/`$$` 收敛到 root、删 `applyTheme`）；M1 若遇 StrictMode 双挂载/HMR 重挂载冲突，再退到列表/详情两组件重写。这是本项目最大的工作量分叉，M0 必须先定 |
| 详情放哪 | 架构师：`sidebar.right.pane.tab`；设计师：右栏面板**无标题行、无会话就没有停靠面** | 工作台是全局页（不绑 Session），**默认面板内右侧抽屉 360px**；只有在会话内才考虑右栏 tab。这条会省掉约 0.5 d 的对齐工作 |
| 字号 | 设计师：9 档固定整数 px；视觉验收：宿主字号用户可调 10–22px | **改为相对宿主基准**（rem/相对单位），档位保留、不写死 px |

---

## 11. 待确认事项

**阻塞级**

1. ★ `main` 槽位对第三方 `panelId` 的接受度——官方 README 已写明「同 id 对应 main 键控槽位、缺条目抛错」，仍需 M0 用最小插件实测一次。
2. ★ 当前 desktop profile 挂载的 storage backend 是 `json` 还是 `sqlite`——决定持久化保证与备份策略。
3. ★ 传输桥选型：手写 Remote 描述符是否可用；若否，用户是否接受一次单文件转译（esbuild）。

**非阻塞但影响体验**

4. 卸载/删除 bundle 时 `storageDomain` 数据是否保留、如何显式清除。
5. 宿主是否有替代 PowerShell `FolderBrowserDialog` 的能力（打开关联文件夹）。
6. 是否继续维护独立 exe（建议：冻结特性，只留安全修复，插件 M4 通过后再决定弃留）。
7. npm 包名与 scope（`@sfh/…` 还是个人 scope），以及是否允许公开。

---

## 12. 下一步（按顺序）

1. M0 spike：拷 `templates/decoration` → 注册 `sidebar.panellist` + `main` → 本地路径 `install_bundle` → 看是否能上屏、切换不抛错（半天，决定全案形态）。
2. 出 token 映射表（75 变量 → `--dsw-alias-*`）+ 字号相对化口径（设计师，1 天）。
3. `app.js` 三处外科手术 + `db.mjs` 拆端口（架构师，2 天）。
4. 旧库导入器 dry-run（1 天），先只读跑通再上写路径。
5. 打包骨架 `npm pack` 干跑，打通分发管道。

---

## 13. 入口位置修正（二次评审，2026-10-20）

用户提出：入口能否钉在左侧导航（像「新建任务」），内容只出现在项目主窗口、不要全局页（全局页切项目不方便）。

### 复核过的代码事实

| 事实 | 位置 |
|---|---|
| 「新建任务」是硬编码按钮，不是槽位，无法被插件复用或替换 | dsh-client-ui-sidebar/lib/client.js 348-377 |
| sidebar.panellist 的每一行点击无条件调用 ctx.layout.selectPanel(id)；main 里没有同 id 条目会直接抛错 | 同文件 184-186、480；dsh-client-ui-layout/lib/client.js 468-471；dsh-client-ui-sidebar/README.md 38 |
| 打开/新建会话时会强制清掉全局页：replaceMain(..., "reveal") → layout.selectPanel(null) | dsh-client-ui-workspace/lib/client.js 1471、1489、1673 |
| 项目窗口内的会话级座位 conversation.view 存在，tab 条在会话头第二行，showTabs = !hideChrome && tabs.length > 1 | dsh-client-ui-conversation/lib/client.js 17946、17991、19557、19740 |
| 空白会话（未发首条消息）不渲染任何 view、也不显示 tab 条 | 同文件 17942、17991 |
| 会话视图选择按会话持久化在 dsh.conversation.<sessionId> | 同文件 4485-4499 |
| 另有一个只做动作、不绑 main 的侧栏座位：sidebar.footer.action（list/root，底部、设置之上；cordis 插件在用） | dsh-client-ui-sidebar/lib/client.js 403、151；dsh-client-ui-cordis/lib/client.js 1411 |

### 结论：两个要求不可同时满足

- 入口常驻左侧导航 → 只能走 sidebar.panellist，而它 1:1 绑定 root main 全局页；且切会话时宿主会把 main 清掉（selectPanel(null)），所以「固定在侧栏 + 内容随项目」在官方槽位内做不到。
- 内容跟随项目 → 只能走 conversation.view（会话头 tab，和「对话 / 轨迹」同排），此时没有侧栏入口。
- 想两者都要，只能 fork 官方 UI（替换 sidebar/workspace 包），升级必崩，不建议。
- 侧栏底部 sidebar.footer.action 可以是「常驻按钮」，但它只能做动作：当前没有公开 API 让 root 作用域的按钮切到某个会话视图（selectView 只注入给 conversation.session.header.actions）。

### 三种可行形态

| 形态 | 入口 | 内容 | 代价 |
|---|---|---|---|
| A 全局页 | 侧栏行（位置正确） | 全局页；切会话被踢回对话 | 用户抱怨的根因未解决 |
| B 会话视图（推荐） | 会话头 tab「工作台」 | 真·项目窗口，随项目自动切换 | 无侧栏常驻入口；空白会话不出现 |
| C 侧栏底部按钮 + 右栏/浮层 | 侧栏底部 | 右栏 tab（仅对话态）或浮层 | 位置偏、不是主窗口 |

推荐：B 为主；若还要跨项目总览，再补一个 A（只读看板）。工作量区间约 16-20 人日（架构师 14-16、设计师净 +2~4，两口径待 M0 后重估）。

### 待用户拍板

1. 二选一：内容随项目（B，推荐） 还是 侧栏常驻（A，接受全局页）；
2. 是否加 A 作为只读跨项目看板（+约 4-7 人日）；
3. 空白会话没有入口，是否接受（先发一句话才出现 tab）。

### 上线前必须打的 spike（P0）

注册一个最小 conversation.view（id: probe）验证四件事：tab 是否出现、点击是否渲染、切项目是否各自记忆、空白会话是否确实没有 tab。全部通过才按 B 继续；任一失败退回 A。
