# 视觉验收契约与拦截清单：侧栏常驻入口 + 项目级内容

- 版本：2026-10-20（第 2 轮，针对用户「入口钉在左侧导航、内容只出现在项目主窗口」的诉求）
- 角色：UI 视觉验收设计师（设计契约 → 线上界面逐项对照 → 拦截通用/雷同界面）
- 依据：DSH 0.2.1-rc.2-332895e 客户端源码（asar 只读解包）、上一轮方案/设计稿、现有产品代码
- 状态：**未执行界面截图比对**（本轮只有源码取证，无浏览器截图能力）；下文所有尺寸/颜色为源码值，不是渲染实测值

---

## 0. 验收视角的结论

1. 用户要的「像『新建任务』那样一行常驻按钮」在插件范围**做不到完全一样**：
   - 「新建任务」是硬编码按钮（`E:\SFH office\.tmp-asar\node_modules\@deepseek-ai\dsh-client-ui-sidebar\lib\client.js:348-377`），不是槽位；插件只有 `sidebar.panellist`（list/root，:487-521），渲染为 36px 文本行，不是 38px 填充按钮（CSS 见同文件:91，`_2H3hWW_newSession` 与 `_2H3hWW_panelRow`）。
   - `sidebar.panellist` 行的点击是写死的 `selectPanel(id)`（:184-186），并且 `selectPanel` 对没有 `main` key 的 id **抛错**（`dsh-client-ui-layout\lib\client.js:468-471`：`layout.selectPanel: main panel "<id>" is not registered`）。侧栏行 ↔ 根级 `main` 全局页是 1:1 契约，不能用侧栏行直接切换「会话主窗口里的内容」。
2. 「内容只出现在项目主窗口、随项目切换」在插件范围**有原生座位，但作用域是会话（Session），不是工作区/项目（Workspace）**：`conversation.view`（`dsh-client-ui-conversation\lib\client.js:19555-19567` 派生 tab、:17946 渲染、:19798 声明为 Factory 局部 `views: {scope:"session"}`），即会话头里的「对话 / …」页签行，内容占主窗口正文区，偏好按 sessionId 持久化（`dsh-client-ui-conversation\lib\client.js:4485-4496`，key `dsh.conversation.<sessionId>`）。
3. 因此两个诉求**不能由同一个原生座位同时满足**：要么入口在侧栏（内容只能是 `main` 全局页），要么内容在项目主窗口（入口只能是会话头页签 / 会话行内小按钮）。
4. 本轮的验收立场：**若团队选「项目主窗口」形态，则入口必须放弃侧栏常驻行，改用会话头页签**；若保留侧栏行，则必须承认它是全局页，且不得伪装成「项目内嵌面板」。任何「侧栏按钮 + 主窗口内嵌」的拼接实现都会在下文 P0-4 被拦截。

---

## 1. 验收基线（源码值，逐项可对照）

> 用途：验收时逐条量取线上界面，与下表比对；数值来源为 asar 解包后的客户端源码字符串（CSS-in-JS），非设计稿推测。

### 1.1 侧栏导航 band

| 元素 | 源码值 | 位置 |
| --- | --- | --- |
| 侧栏根 | padding `6px 12px`，font-size `14px`，背景 `var(--dsw-specific-sidebar-fill)`（= `#f9fafb`） | `dsh-client-ui-sidebar\lib\client.js:91` |
| 品牌行 logoRow | height `60px`，gap `8px`，品牌字号 `18px/600`，letter-spacing `.04em` | 同上 |
| 新建会话按钮 | height `38px`，`border:.5px solid var(--dsw-alias-border-l3)`，radius `var(--dsw-radius-md)`（=12px），背景 `var(--dsw-alias-button-elevated-fill)`（= `#fff`），padding `8px 12px`，字号 `14px/22px`、weight `500`，margin `0 2px 12px` | 同上 |
| 面板行容器 panelList | `gap:4px`，`margin-bottom:8px`，仅在 `panels.length > 0` 时渲染 | 同上；渲染条件 `:378-389` |
| 面板行 panelRow | `min-height:36px`，`padding:7px 8px`，`margin:0 2px`，gap `8px`，radius `var(--dsw-radius-md)`，line-height `22px` | 同上 |
| 面板行 active | 背景 `var(--dsw-alias-interactive-bg-hover)`，文字仍 `label-primary`（**不是**主色） | 同上 |
| 面板行 icon | `size: wide ? 16 : 18`，由侧栏传入；收起态行 36×36 | `:191`；CSS 同上 |
| 面板行标题 | 单行 ellipsis，无副标题、无 badge、无右键菜单 | `:194-197`；`syncPanels :453-469` |
| 收起态 | 面板列 `gap:12px`，行 36×36 图标居中；tooltip delay `500ms` | CSS 同上；`PanelRow :175-178` |

### 1.2 会话（项目）主窗口头部与页签

| 元素 | 源码值 | 位置 |
| --- | --- | --- |
| header | `min-height:76px`（有 tabs 时），`padding:10px 28px 0 20px`，`border-bottom:.5px solid var(--dsw-alias-border-l3)`；无 tabs 时 `min-height:0; padding-bottom:10px` | `dsh-client-ui-conversation\lib\client.js:17325` 起 CSS 串 |
| titleRow | `min-height:30px`，grid 第 2 列 | 同上 |
| tabs 行 | `gap:36px`，`margin-top:10px`，`padding-left:8px`，`grid-column:1/-1`，`role=tablist` | 同上；`:18043-18057` |
| tab 按钮 | `font-size:13px`，`font-weight:500`，`line-height:16px`，`padding:0 0 9px`，颜色 `var(--dsw-alias-label-tertiary)`（= `#81858c`） | 同上 |
| tab active | 文字 + 下划线 `var(--dsw-alias-state-business-primary)`（= `#4176e6`） | 同上 |
| tabs 显示条件 | `!hideChrome && tabs.length > 1`（`hideChrome` 由 blank 会话传入） | `:17991` |
| view 区 | `renderSlot("conversation.view", …, {only: viewId})`；blank 会话直接 `return null` | `:17942-17952` |
| 页签集合来源 | `slots.entries("conversation.view")`；`trajectory` 受 `configForms.developerTools.enabled` 门控 | `:19555-19567` |
| 页签切换 | `activateView` → `uiConversation.binding(sessionId).activate(id)` + `actions.setView(view)`（store 持久化 key `dsh.conversation`） | `:19568-19580`、`:4471-4497` |
| 无 View target 时 | `activateTarget` 对未注册 target 只入 activeTargets、不抛错（`returns published`） | `:2736-2745` |

### 1.3 侧栏会话行内座位（项目行上的常驻/悬停入口）

| 元素 | 源码值 | 位置 |
| --- | --- | --- |
| 槽位 | `sidebar.session.row.leading`（list/root）、`sidebar.session.row.hover`（list/root）、`sidebar.workspaces.session.row.action`（list/root） | `dsh-client-ui-workspace\lib\client.js:5235-5246` |
| 每行传入 props | `{ sessionId, displayTitle }` | `:2348-2351` |
| leading 座位 | 仅在 `!archived && !blank` 且未显示状态点时占位（会与状态点互斥） | `:2306` |
| row action 座位 | 排在 `⋯` 菜单左侧；容器 `.rowActions` **默认 `display:none`，仅行 hover / 菜单打开时显示**，`gap:15px` | `:2348`；CSS `:1741` |
| 行内按钮 iconButton | `16×16`，颜色 `label-tertiary`，hover 转 `label-primary`，radius `--dsw-radius-xs` | CSS `:1741` |
| 会话行 | 高度 `32px`，radius `--dsw-radius-md`，hover/selected 背景 `interactive-bg-hover` | CSS `:1741` |

### 1.4 全局页（若仍保留 main 形态）

| 元素 | 源码值 | 位置 |
| --- | --- | --- |
| 入口型页面顶部内边距 | 必须用 `var(--dsh-frame-top-clearance)`（48px） | `dsh-client-ui-plugin-manager\lib\client.js:1913`、`dsh-client-ui-schedule\lib\client.js:2433`；`dsh-client-ui-layout\README.zh.md`（窗口 chrome 座段落） |
| 失焦重置 | Plugins 页在 `activePanelId !== "plugins"` 时 `setView({kind:"list"})`（离开即回列表） | `dsh-client-ui-plugin-manager\lib\client.js:4462-4464` |
| 主面板选中 | `renderSlot("main", {}, { entryKey: activePanelId ?? "conversation" })` | `dsh-client-ui-layout\lib\client.js:118-119` |

### 1.5 设计 token（可直接用于比对取值）

| token | 值 | 来源 |
| --- | --- | --- |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `dsh-client-ui-theme\lib\client.js:1413` |
| `--dsw-alias-bg-base` | `#fff` | 同上 |
| `--dsw-alias-state-business-primary` | `#4176e6` | 同上（`--dsw-static-deepseek-500`） |
| `--dsw-alias-label-tertiary` | `#81858c` | 同上 |
| `--dsw-alias-border-l3` | `#0000001f` | 同上 |
| `--dsw-alias-interactive-bg-hover` | `#26314824`（accent 变体也在同串） | 同上 |
| `--dsw-radius-sm/-md/-lg` | `8px / 12px / 16px` | `dsh-client-ui-theme\lib\client.js:1407` |
| 深色主题开关 | `body[data-ds-dark-theme]`，**不是** `prefers-color-scheme` | `dsh-client-ui-layout\lib\client.js:504-505` |

---

## 2. 形态判定（验收视角的「像不像原生」分级）

| 形态 | 入口位置 | 内容位置 | 随项目切换 | 原生度 | 验收判定 |
| --- | --- | --- | --- | --- | --- |
| A 官方全局页（上一轮方案） | `sidebar.panellist` 行（新建会话正下方） | root `main` keyed 页 | 数据可跟随，页面不跟随 | 高（Plugins 同构） | 可用，但**不满足用户 #2**，入口被用户视为「全局页图标」 |
| B 会话主窗口页签（本轮推荐） | 会话头 tab 行（「对话」右侧） | `conversation.view` 正文区 | 是（按 sessionId，含偏好持久化） | 最高（与 Trajectory 同构） | **推荐**：满足 #2，不满足 #1 |
| C 会话行小按钮 + 全局页 | 会话行 hover 16px 图标 | root `main` 页（带 sessionId 上下文） | 是（数据层） | 中（hover 才出现，键盘/触屏不可达） | 折中，仅当产品坚持侧栏入口 |
| D 侧栏行 + 主窗口内嵌 | — | — | — | — | **不可达**：无 session/workspace 作用域的 main 座位，且无「跨包切换会话视图」公开 API（见 §6 未验证项） |

---

## 3. 拦截清单（P0 阻断发布 / P1 发布前修 / P2 迭代）

> 判定方法统一为：截图或 DevTools 量取 + 与 §1 数值比对；每项都要留证据（截图 + 选择器 + 计算值）。

### P0（阻断，任一条不通过即不得发布）

- **P0-1 不得自绘会话头或页签行。** 形态 B 必须注册 `conversation.view`（`name/id/order/label/locale`），复用原生 tab 行；出现第二条 tab 行、第二个标题、或 tab 字号/字重/间距不是 `13px/500/36px` 即拦截。
- **P0-2 blank 会话不得出现「点了没反应」的入口。** 原生行为：blank 会话 `hideChrome` → 不显示 tabs，`conversation.view` 也不渲染（`:17942`、`:17991`）。若我方入口在 blank 会话仍可见（例如侧栏行或 hero 按钮）而内容不出现 → 拦截。
- **P0-3 侧栏行必须与 `main` key 一一对应。** 只注册 `sidebar.panellist` 而不注册同 id 的 `main` 条目，点击会抛 `layout.selectPanel: main panel "<id>" is not registered`（`dsh-client-ui-layout\lib\client.js:469`）→ 拦截。
- **P0-4 禁止用嵌套 button / `stopPropagation` 把侧栏行改造成「跳转到会话视图」。** `PanelRow` 本身是 `button`（`:179-199`），子级再放交互元素是无效 HTML 且破坏 `aria-current`/焦点顺序 → 拦截。
- **P0-5 禁止自有主色、自有圆角、自有行高。** 出现 `#2563EB`、`10px` 圆角、`40px` 行高、表格斑马纹 → 拦截；必须使用 `#4176e6` / `8·12·16px` / 会话行 `32px`、面板行 `36px`。
- **P0-6 若保留 `main` 全局页，必须 `padding-top: var(--dsh-frame-top-clearance)` 且不得自绘顶栏。** 缺 48px 顶部让位（或被自绘顶栏覆盖）→ 拦截。
- **P0-7 主题必须走 token。** 不允许 `@media (prefers-color-scheme: dark)` 自判；DSH 用 `body[data-ds-dark-theme]`（`:504-505`）。深色下出现白底卡片/浅灰描边 → 拦截。
- **P0-8 切换项目不得残留上一项目数据。** 形态 B/C 均需按 `sessionId` 重取或清空列表与详情；出现旧项目条目、旧滚动位置串味 → 拦截。
- **P0-9 入口文本必须 locale 化。** 硬编码中文（或英文）label → 拦截；`label` 必须走 `locale`（参考 `dsh-client-ui-plugin-manager\lib\client.js:4481`）。
- **P0-10 不得照抄 Plugins 的「失焦重置」。** 全局页离开即回列表（`:4462-4464`）对「切项目来回看」是反体验；若形态 A/C 采用必须显式说明并改为「记住上次视图」，否则按体验缺陷拦截。

### P1（发布前修）

- 空态必须带项目上下文（项目名 + 一个主操作），禁止「灰图标 + 暂无数据 + 按钮」三件套模板；禁止跨页面复用同一张通用空态插画。
- 加载态用骨架/占位而非全屏 spinner；错误态给出可重试动作与原因。
- 入口图标：`sidebar.panellist` 收到 `size`（16/18）必须原样使用、`currentColor`、不描边填充混用；会话行按钮用 `16×16`（CSS `:1741`）。
- hover-only 入口（`sidebar.session.row.action` 默认 `display:none`）必须提供键盘可达路径；若作为主入口，改为 `sidebar.session.row.leading`（常驻）或放弃。
- tab 内容宽度：主面板最小可用宽约 400px（`dsh-client-ui-layout\README.zh.md`），禁止固定 380px 双栏详情列；窄容器下必须降级为单栏。
- 焦点与快捷键：不得抢占会话输入框焦点；不得新增 `Ctrl/⌘+K`（已被搜索占用）。

### P2（迭代）

- 动效统一 `150ms var(--ds-ease-in-out)`；尊重 `prefers-reduced-motion`。
- tooltip 文案与 delay（侧栏 500ms）一致；埋点自埋（第三方 id 不触发 `sidebar_menu_click`，`:478-481`）。
- 滚动条沿用 `quietBars` 行为，不自绘滚动条。

---

## 4. 界面结构（形态 B：项目主窗口内页签）

```
项目主窗口（main key = conversation）
├─ 会话头 header（min-height 76px，原生；禁止自绘）
│  ├─ headerLeading（root 座，可放 1 个 16px 图标按钮）
│  ├─ titleRow（面包屑 + 会话操作，30px）
│  └─ tabs（对话 | 工作台，13px/500，gap 36px）   ← 我方入口
├─ view 区（conversation.view，only = activeId）
│  └─ 工作台内容（本插件）
│     ├─ 工具行：筛选/范围（单行，≤32px，不另起标题）
│     ├─ 列表：32px 行高、hover 背景 interactive-bg-hover
│     └─ 详情：窄容器单栏；≥720px 才允许右列
└─ composer（原生常驻）
```

状态规则：

| 状态 | 行为 |
| --- | --- |
| 无会话 / blank 会话 | 无 tabs、无 view 区（原生）。我方**不得**留入口；首轮对话后才出现「工作台」页签（需产品确认可接受） |
| 切换会话/项目 | 按 `sessionId` 重挂载；上次页签偏好由原生持久化自动恢复（`dsh.conversation.<sessionId>`） |
| 会话运行中 | 页签可切换；不得阻塞 composer；切回「对话」时输入草稿不得丢失（原生 `bindDraftPersistence` 负责，禁止卸载 composer） |
| 空数据 | 项目名 + 「暂无排期，创建第一条」类动作，不用通用空态 |
| 侧栏收起 | 页签不随之变化；不得依赖侧栏宽度做布局断点 |

形态 C（会话行小按钮 + 全局页）额外规则：页面顶部 48px 让位；页内不得再出现会话头；点击行内图标后焦点应落在页面首个可交互元素；返回会话用原生 `selectPanel(null)`。

---

## 5. 上一轮方案需舍弃 / 修订的内容

| 项 | 处理 | 依据 |
| --- | --- | --- |
| 设计稿 §1.1「入口位置=左侧栏底部图标组(order 10)」 | **修订**：panellist 渲染在「新建会话」正下方、工作区列表之上（`dsh-client-ui-sidebar\lib\client.js:378-389`），不是底部 | 源码 |
| 自有标题栏 + 返回按钮 | 舍弃（会话头已存在，重复标题=雷同/结构错） | §1.2 |
| 主色 `#2563EB` | 改 `var(--dsw-alias-state-business-primary)` = `#4176e6` | §1.5 |
| 10px 圆角 | 改 `8/12/16px` | §1.5 |
| 40px 行高 | 面板行 36px、会话行 32px、列表行 ≤32px | §1.1/§1.3 |
| 固定 380px 详情列 | 改为 ≥720px 才双栏 | 主面板最小 400px |
| 全局页失焦重置 | 若保留页面形态，改为记忆上次视图 | `plugin-manager:4462-4464` |
| `Ctrl/⌘+K` 全局搜索 | 舍弃（冲突） | 上一轮设计稿 §1.5 |
| 表格斑马纹 / 通用居中风图标空态 | 舍弃 | 上一轮方案 §5 雷区 |

---

## 6. 未验证事项（不得当作结论使用）

1. **只注册 `conversation.view` 槽位、不注册 `uiConversation.views` target 是否能正常工作**：源码显示 `activateTarget` 对未注册 target 不抛错（`:2736-2745`），tab 集合只读槽位（`:19555-19567`），推测可行；但官方 trajectory 两处都注册（`:2261`、`:8205`），**未实测**。
2. **是否存在公开 API 让 root 作用域控件切换某会话的当前 View**：`openView` 只作为 `conversation.content` 注入的局部能力出现（`:19804-19831`），`uiConversation.binding().activate()` 只激活 snapshot target、不写 store.view；**未找到公开路径**（标为未验证，不代表绝无可能）。
3. **用户截图里的「扩展管理」行归属**：整套 asar 搜 `扩展管理` 为 0 命中（16,679 个文本文件），本 build 无法证实该行来源，且截图含「搜索」按钮而本 build 侧栏无搜索框 → 截图与本 build 可能不是同一版本；**验收基线必须用运行时截图重取**。
4. **渲染实测值**：本轮未截图、未在 127.0.0.1:62319 上量取，所有数值是 CSS 源值；行高/间距在真实字体下可能有 1px 级差异。
5. **Windows 标题栏 / macOS 顶部条**下的侧栏几何（`[data-windows-titlebar]`、`[data-platform=darwin]` 分支，CSS `:91`）未在对应环境验证。

---

## 7. 验收执行步骤（建议）

1. 基线截图：`1440×900` 与 `1024×768`，light/dark 各一套；侧栏展开/收起各一套。
2. 采集点：tab 行（字号/字重/间距/下划线颜色）、header 高度、会话行高度、行内按钮尺寸、空态、切换项目前后、blank 会话。
3. 对照 §1 表格逐项打分，P0 全过才进入下一步；P1 记入发布前整改单。
4. 通用/雷同专项：同一空态是否在 2 个以上页面复用；入口图标是否与「插件」「定时任务」同族但不区分；是否出现非 token 色值（DevTools 过滤 `#` 与 `rgb(`）。
