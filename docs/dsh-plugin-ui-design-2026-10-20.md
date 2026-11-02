# 待办工作台 → DSH 工作台插件 · UI 设计规格（v1）

> 角色：design-ui-designer ｜ 日期：2026-10-20 ｜ 状态：可交付开发（待「待核对」清单闭环）
> 依据：DSH 宿主 asar 内官方 README 与预构建 bundle 实读；工作台 `public/styles.css`、`public/index.html` 实读。
> 配套视觉稿：`docs/design-preview/dsh-workbench-mockup.html`（可直接浏览器打开，自带浅/深两帧＋组件画廊）
> 出图：`docs/design-preview/dsh-mockup-full-1500.png`

---

## 0. 结论（UI 侧）

1. **可行，且不需要另造一套视觉语言**：DSH 的 `--dsw-*` 别名层（403 个 token）已经覆盖卡片面、层级线、文字三级、业务色/成功/警告/错误、圆角 5 档、阴影 3 档、焦点环。工作台现有 `styles.css` 的 `:root` token 与之**语义同构**，全部可 1:1 映射（见 §3），不存在"移植即破相"的硬伤。
2. **入口首选「侧栏图标 → 全局面板」**，与官方 **Plugins 页**同一形状（`sidebar.panellist` + `main` keyed slot），零猜测成本（证据见 §1.1）。**备选**是右侧栏 tab（会话内伴侣视图），**不推荐**底部条、独立窗口、`/` 斜杠命令作为主入口。
3. **必须放弃三件东西**：自有标题栏（与 DSH chrome 重复）、自有 Ctrl+K 命令面板（DSH 没有全局命令面板，等价物是 `/` 斜杠命令＋快捷键服务）、固定 380px 详情列（在 1440 宽 + 右侧栏打开时中栏只剩 ~512px，塞不下三列）。
4. **密度必须改**：现 40px 行高 + 16px 卡距是 iOS 分组语义；放进 DSH（列表行 28px、分组头 36–38px）会像"外挂应用"。建议默认 **36px**，提供 28/36/40 三档密度。
5. **色彩一票否决项**：不要再让 `--accent:#2563EB` 出场。DSH 业务主色是 deepseek `#4176e6`（浅）/ `#7aaaff`（深），主按钮、选中、焦点环全部换成 `--dsw-alias-state-business-primary`，否则插件一眼"不属于这里"。
6. **iframe 复用现有 SPA 是可行的过渡手段，但有视觉代价**：能拿到同源（宿主半边托管 `public/`），但 iframe 里不会自动继承宿主的 `--dsw-*`、`corner-shape` 圆角平滑、`--dsh-content-font-size` 字阶，必须手动注入并从父窗合同步主题；且自有标题栏/命令面板仍在画面里。**结论：iframe 只做 Phase 1 的"能用"，Phase 2 起按本规格原生重建高频视图（今日 / 列表 / 详情）。**

---

## 1. 入口与窗口信息架构

### 1.1 首选：侧栏图标入口 + 全局面板（`sidebar.panellist` → `main`）

官方证据（实读 `dsh-client-ui-plugin-manager/lib/client.js`，注册形状可照抄）：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name:'sidebar.panellist', id: PANEL_ID, order: 0, label: () => t('panel'), locale: NS },
  WorkbenchPanelIcon));
ctx.slots.inject('main', function* () {
  const handle = createNavigationStore(), instance = handle.create();
  const store = { ...handle, create: () => instance };
  yield ctx.slots.register(
    { name:'main', key: PANEL_ID, locale: NS, store, inject: () => face, children: {…} },
    WorkbenchPanel);
});
ctx.layout.selectPanel(PANEL_ID);   // 需要"点一下就跳过去"时用
```

官方 README（`_doc_pm.md`）原文：「浏览器插件通过 `ctx.slots.inject()` 注册 `plugins` 侧栏入口与它的 `main` 面板……页面为全局页面，不属于任何 Session。」

**入口规范**
| 项 | 规格 |
|---|---|
| 位置 | 左侧栏底部图标组（`sidebar.panellist`，root 作用域 list），排在 Plugins 图标之前 |
| 图标 | 双列勾选线稿 17×17，stroke 1.5，`currentColor`（与插件页图标同笔画密度；不用品牌色，选中态由宿主给） |
| 角标 | 未完成/逾期计数用 `sidebar.toggle.badge` 能力（若该席位可写）或自绘 14px 圆点角标，底色 `--dsw-alias-state-error-primary`，仅 >0 且逾期时显示 |
| label | `待办工作台`，locale-aware 传入（`locale: NS` + 字典），不留硬编码中文 |
| order | 排在 Plugins(0) 之后，取 10，避免与官方页抢位 |
| 跳转 | 点击图标即 `layout.selectPanel('workbench')`；从 `/todo` 命令进入走同一函数 |

### 1.2 备选：右侧栏「今日」tab（`sidebarRightTabs` + `sidebar.right.pane.tab`）

用途：**会话旁路**——写代码时右栏常驻今日清单，不用切走主面板。

```js
ctx.sidebarRightTabs.register({ id:'workbench.today', kind:'workbench-today',
  title:() => t('today'), priority:'extension', keepMounted:true, multiple:false });
ctx.slots.register({ name:'sidebar.right.pane.tab', key:'workbench.today' }, TodayPane);
```

约束（实读 `_doc_sbr.md`，均为硬规则，设计时必须让布局满足）：
- 右栏 **没有标题行**，所有控件挂在 tab 条末端（⋮ 菜单 / 刷新 / 全屏切换），所以「今日」面板自身的工具栏高度必须 ≤ 0，计数与刷新并入 tab 条。
- 窄于 **768px** 打开即全屏；退全屏会收起。→ 「今日」面板需提供 **单列全屏版**（见 §5.3）。
- **没有会话就没有停靠面**：hero 画面右侧为空 → 不能把「今日」当作唯一入口。
- 右栏首次打开占视口 45%，上限 70%；为保中栏 400px，框架会先把右栏压到 300px。

### 1.3 不推荐的入口（及原因）
- `shell.bottom` 底部状态条：横跨三列、三列按高度缩短。待办是"常看不常用"，占底栏性价比低，且默认组合不占用时突然出现会顶掉用户布局。→ 状态条降级为**面板内 footer 26px**。
- 独立 BrowserWindow / 新窗口：DSH 客户端插件没有开窗 API（待核对），且会立刻退化成"又一个桌面应用"。
- `/` 斜杠命令作为主入口：`ctx.commandUi` 需要会话上下文与 composer，全局页面不该依赖它。→ 只做 3 条快捷命令（见 §1.5）。

### 1.4 窗口清单（7 个）
| # | 窗口/视图 | 承载槽位 | 尺寸 | 出现条件 |
|---|---|---|---|---|
| W1 | **工作台主面板** | `main` key=`workbench` | 填满中栏（≥512px） | 点侧栏图标 |
| W2 | **今日**伴侣面板 | `sidebar.right.pane.tab` | 45% 视口 / <768 全屏 | 会话内从右栏 tab 打开 |
| W3 | **详情列/抽屉** | W1 内部 | ≥1080 时 320px 常驻列；<1080 时右侧抽屉 360px 浮层 | 选中任一行 |
| W4 | **快速新建**浮层 | `shell.overlay` | 居中 480×auto | `Mod+Shift+N` / 面板内「新建」长按 |
| W5 | **月历浮层** | W1 内部 popover | 296×320 | 工具栏日历按钮 |
| W6 | **设置节** | `settings.section` | 760px 表单 | 设置页「待办工作台」 |
| W7 | **插件页配置页** | `plugins.bundle.config` key=`dsh-workbench` | 同上组件复用 | 插件页 → 本插件 → 配置 |

> W6/W7 必须复用同一 React 组件（gongwen 插件实证的写法：同一个 `GongwenSettings` 注册到两个槽位），不要写两份表单。

### 1.5 命令（快捷键服务，符号待核对）
| 命令 id | 默认键 | 行为 |
|---|---|---|
| `workbench.open` | `Mod+Shift+W` | `layout.selectPanel('workbench')` |
| `workbench.new` | `Mod+Shift+N` | 打开 W4 快速新建 |
| `workbench.today` | 无（速查里可选） | 打开 W2 今日 tab |
| `workbench.focus` | `F`（面板内） | 聚焦面板搜索框（不是全局键） |

先核对宿主已用键位再定；「扩展命令在核心操作之后按命令 ID 稳定排列」是宿主的排序保证，我们只需给稳定 id。

---

## 2. W1 主面板区块布局（像素级）

```
┌ wb-main ─────────────────────────────────────────────── 1160×860 ─┐
│ wb-head   高 44（含 --dsh-frame-top-clearance 顶部让位）            │
│   h1「今日」16/600 · sub 12 tabular「6 项待办 · 2 项逾期 · 3.5h」   │
│   ─── grow ─── [新建 primary 28]                                   │
│ wb-toolbar 高 28+10 底距                                           │
│   [搜索框 28×min180  bg-sunken  内嵌 kbd 10px]                     │
│   [seg 今日|近7天|逾期  高 26  bg-sunken  pad 2]                   │
│   ─── grow ─── [日历 28icon][密度 28icon][更多 28icon]             │
├──────────────┬────────────────────────────┬───────────────────────┤
│ wb-rail 196  │ wb-list  flex               │ wb-detail 320         │
│  视图 4 项   │  group-head 28              │  d-head 36            │
│  分类 N 项   │  card(radius 12, ring l2)   │  d-title 15/600       │
│  每月例行    │    row 36（密度可调）       │  d-body（滚动）        │
│  （滚动）    │  group-head                 │   状态seg / kv / 笔记  │
│              │  card …                     │   / 关联 / 时间线      │
│              │                             │  d-foot 48            │
├──────────────┴────────────────────────────┴───────────────────────┤
│ wb-foot 高 26  「今日 6 · 逾期 2 · 完成 1   下次备份 18:00   F 筛选」│
└────────────────────────────────────────────────────────────────────┘
```

**硬规则**
- `.wb-head` 的 `padding-top: calc(var(--dsh-frame-top-clearance) - 4px)`：框架明确说明「入口型主面板要用它做顶部内边距」，否则 Windows 标题栏会压住标题。
- 面板**不自绘标题栏**、不自绘窗口按钮。
- 中栏永远是 flex 主列（`min-width:0`），rail 固定 196，detail 固定 320。
- 详情列只在面板宽 ≥1080 出现；<1080 改 `shell.overlay` 右侧抽屉（360px，`--dsw-shadow-lv2`，遮罩 `--dsw-alias-bg-overlay` 12%）；<900 抽屉改全屏 sheet（顶部 44 拖拽条、底部 48 操作条）。
- 视口高 <620 时 `wb-foot` 隐藏（信息在 `wb-head.sub` 里已有）。

### 2.1 W2「今日」面板区块
- tab 条（宿主绘制）→ 面板体：
  - `today-h` ：「今天还剩 4 项 · 3.5h」13/600 ＋ tabular
  - 4px 进度条（`--dsw-alias-state-business-primary`，100% 时切 success）
  - 三段：**逾期**（红 `when`）／**今天**（时间 tabular）／**已完成**（默认折叠）
  - 每行 30px：checkbox 16 ＋ 优先级点 6 ＋ 标题 ellipsis ＋ 右侧时间
  - 底部 `notice`：备案/说明类 11px，`--dsw-alias-bg-multi-select`
- 无会话停靠面时不可用 → 面板内不出现"请先打开会话"之类文案，入口本身就不显示。

### 2.2 W4 快速新建浮层
- `shell.overlay` 居中卡 480px，`--dsw-radius-lg`，`--dsw-shadow-lv3`，elevation 描边代替 border。
- 结构：单行输入（占位「要做什么？⌘Enter 保存」）→ 一行 chip 组（优先级/分类/日期/预估）→ 底部提示「Tab 循环选项 · Esc 关闭」。
- 不做成多字段表单：这是"捕获"不是"编辑"，完整字段在 W3 详情里改。

### 2.3 W5 月历浮层
- 296×320，`--dsw-radius-md`，`--dsw-shadow-lv2`，锚在工具栏日历按钮下方 8px。
- 沿用现有双点语义：**到期**空心点 `--dsw-alias-label-tertiary`，**完成**实心点 `--dsw-alias-state-success-primary`；今日格 `--dsw-alias-state-business-tertiary` 底 + `--dsw-alias-state-business-primary` 字。
- 键盘：←→ 日、↑↓ 周、PgUp/PgDn 换月、Enter 跳转当天列表、Esc 关闭并回焦。
- 浮层必须做 **edge flip**（靠右时改左对齐），这条在 900 宽实测时踩过坑（见 `docs/ui-spec-三处改造-2026-10-19.md` §4.6）。

### 2.4 W6/W7 设置节
复用 gongwen 的实测尺度（13px/20、label 12、note 11、input padding 5×8、border .5、radius 6、gap 16/8/10、max-width 760）：
- 段 1「数据位置」：只读路径 + 「打开文件夹」+「迁移…」+「备份频率」
- 段 2「归档」：归档目录、Markdown 模板（只读预览）、「打开归档」
- 段 3「外观」：密度（28/36/40）、是否显示优先级点、周起始日
- 段 4「关于」：版本、兼容区间、作者链接、二维码（微信/支付宝）——**这是品牌资产保留的唯一位置**，不要放进主面板。

---

## 3. Token 映射表（工作台 → DSH）

| 用途 | 现 token / 值（`public/styles.css`） | DSH token（唯一权威） | 备注 |
|---|---|---|---|
| 应用底色 | `--bg-app #F4F5F7` / `#101215` | `--dsw-alias-bg-base`（#fff / #151517） | 面板底色改用 base，不再用灰底 |
| 卡片面 | `--bg-surface #FFFFFF` / `#181B1F` | `--dsw-alias-bg-layer-1`（#fff / #232324） | 嵌套层用 `-layer-2/-3` |
| 凹陷/输入底 | `--bg-sunken #ECEEF1` / `#0C0E11` | `--dsw-alias-bg-multi-select`（#f9fafb / #212123） | 搜索框、seg、textarea |
| 悬停 | `--bg-hover #F2F4F6` / `#22262C` | `color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)` | 宿主无 hover token，用 label 混合最稳 |
| 按下 | `--bg-active #E7EAEE` / `#2A2F36` | 同上 9% | |
| 选中行 | `--bg-selected #E7F0FE` / `#1B2B45` | `--dsw-alias-state-business-tertiary`（#e4edfd / #34415b） | 与宿主选中语义一致 |
| 文字 1/2/3 | `--text-1 #1A1D21` `--text-2 #5B6472` `--text-3 #6B7280` | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` | |
| 更弱文字 | — | `--dsw-alias-label-caption`（#adb2b8 / #81858c） | 时间戳、计数、placeholder |
| 卡片描边 | `--card-ring #DCDFE4` | `--dsw-alias-border-l2` | 高层级表面改用 `--dsw-elevation-stroke` 且 `border:0` |
| 行分隔 | `--card-sep #E9ECEF` | `--dsw-alias-border-l1` | 1px，inset 左 12 |
| 强调/主按钮/焦点 | `--accent #2563EB` / `#3B82F6` | `--dsw-alias-state-business-primary` | **禁止再用 #2563EB** |
| 强调浅底 | `--accent-50 #EFF5FF` | `--dsw-alias-state-business-tertiary` | |
| 危险/逾期 | `--danger #DC2626` `--prio-p0 #C81E1E` | `--dsw-alias-state-error-primary`（#ec1313 / #f25a5a） | |
| 危险浅底 | `--danger-50 #FDF0F0` | **无对应 token**：`color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)` | 实测别名层只有 error-primary/secondary，没有 tertiary，别臆造 |
| 警告/临期 | `--warn #D97706` `--prio-p1` | 点/条用 `--dsw-alias-state-warn-primary`；**文字必须用 `--dsw-alias-state-warn-label`（#dd8629 / #f7ad31）** | #f59e0b 做小字对比度不足 4.5:1 |
| 成功/完成 | `--success #0E9F6E` `--prio-p2?` | `--dsw-alias-state-success-primary` | |
| P2 常规 | `--prio-p2 #2563EB` | `--dsw-alias-state-business-primary` | 优先级与业务色撞色可接受（同族） |
| P3 随手 | `--prio-p3 #6B7280` | `--dsw-alias-label-tertiary` | |
| 卡片圆角 | `--card-radius 10px` | `--dsw-radius-md` 12px（卡片）/ `-sm` 8（按钮、行）/ `-xs` 4（chip） | 10px 不在宿主档位里 |
| 阴影 1/2/3 | `--shadow-1/2/3` | `--dsw-shadow-lv1/lv2/lv3` | |
| 焦点环 | `outline:2px solid var(--accent)` | `outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color)` | 密集行可用 1px |
| 文本选区 | `rgba(37,99,235,.22)` | `--dsw-alias-bg-document-selection` | |
| 字号档 | 14 base / 13 / 12 / 11 整数档 | `--dsh-content-font-size`（10~22）与其 secondary | 大档位时 `wb-fs-sec` 取 secondary token |
| 过渡 | `--ease-out cubic-bezier(.16,1,.3,1)` | 保留（宿主无过渡 token） | 120ms/180ms 两档，尊重 `prefers-reduced-motion` |

**纪律**
1. 插件 CSS 只允许出现 `--dsw-*` / `--dsh-*` 与自身派生变量（`--wb-*`），**不写字面色值**（图形素材与二维码除外）。
2. 不向 `:root` 写任何 `--dsw-*`（会污染宿主）；派生变量统一挂 `.dwb-root` 作用域并加 `dwb-` 前缀，所有 class 带 `dwb-`，避免与宿主类名相撞。
3. 深色**不写** `@media (prefers-color-scheme: dark)`：宿主通过 `body[data-ds-dark-theme]` + `html{color-scheme}` 驱动，插件跟随即可。
4. `--dsw-*` 样式表是颜色唯一权威；缺语义值时取"最接近的语义 token"，不发明新色（官方 README 限制节原文）。

---

## 4. 组件库（12 个，均可复用）

| # | 组件 | 尺寸/规格 | 状态 | 备注 |
|---|---|---|---|---|
| C1 | `Button` | 高 28（sm 24），padding 0 10，radius `-sm`，13/500 | default / hover / active / focus-visible / disabled / loading（文字转 3 点） | 变体 primary（实心业务色）/ default（描边 l2）/ quiet（无底无边） |
| C2 | `IconButton` | 28×28（sm 24），图标 15×15 stroke 1.4 | 同上 + `aria-pressed` 常驻态（用 `--wb-selected` 底） | 触摸区最小 28；移动/窄屏提升到 36 |
| C3 | `Segmented` | 容器 26/28，pad 2，选中项底 `--wb-card` + `shadow-lv1` | — | 2–4 项；>4 项改 Select |
| C4 | `SearchField` | 高 28，底 `--wb-sunken`，内嵌 kbd 10px | idle / focus（环）/ filled（右侧清空按钮） | 兼作命令面板输入（原 palette 的替代） |
| C5 | `TaskRow` | 高 36（28/40 档），pad 0 12，左 checkbox 16、优先级点 6、标题 14、右侧 chips | default / hover（显行内动作）/ selected（左侧 2px 业务色条 + tertiary 底）/ done（删除线 + tertiary 字）/ dragging | 分隔线 inset 左 12（不随 checkbox 对齐，别用 40） |
| C6 | `InsetGroup` | 卡面 `layer-1`、radius `-md`、ring l2、组头 28（12/600 secondary）、组间距 12 | collapsed / default | 组头右侧计数 tabular；≥6 组时组头吸顶 |
| C7 | `PriorityDot` | 6px 圆点，4 档色 | — | 仅色不够：hover/tooltip 与详情里必须有文字「P1 重要」（a11y） |
| C8 | `Chip` | 高 20，pad 0 6，radius `-xs`，11px，tabular | default（sunken）/ ghost（描边）/ biz / warn / err | 同类最多 3 个，超出折成「+2」 |
| C9 | `Checkbox` | 16px 圆，border 1.5 `--wb-ring-strong` | unchecked / hover / checked / indeterminate / disabled | `corner-shape:round`；命中区按 44 预留（`::before` 扩展） |
| C10 | `DetailPane` | 列 320 / 抽屉 360 / sheet 全屏 | 列 / 抽屉 / sheet 三形态 | 状态 segmented 在标题下第一屏可见 |
| C11 | `EmptyState` | 图标 44 + 标题 13/500 + 一行 12 + 至多 2 个动作 | 四种：今日清空 / 无搜索结果 / 首次使用 / 归档为空 | 文案各写各的，禁止通用「暂无数据」 |
| C12 | `Skeleton` / `Toast` | 骨架条 12px `--dsw-alias-bg-skeleton`；toast 用 `--dsw-alias-toast-bg/-label` | 骨架仅 >1.2s 才出现 | toast 由 `shell.overlay` 挂，避免每面板一套 |

**组件状态覆盖清单**（交付验收用）：每个交互组件必须有 default / hover / active / focus-visible / disabled；列表组件额外 selected / done；异步组件额外 loading / empty / error。

---

## 5. 响应式、密度、深色

### 5.1 断点（按**面板自身宽度**，不是视口——面板会被左右栏挤压）
| 面板宽 | 形态 |
|---|---|
| ≥1080 | rail 196 + list + detail 320（三列） |
| 900–1079 | rail 196 + list；detail 改右侧抽屉 |
| 720–899 | rail 收起为 56 图标轨道（hover 展开浮层）；detail 抽屉 360 |
| <720 | 单列：head 内「视图」下拉替代 rail；detail 全屏 sheet；chips 只留优先级点 + 时间 |
| <480 | head 折叠为「今日 ⌄」+ 一个主按钮；footer 隐藏 |

> 用 `ResizeObserver` 观测面板根元素改写 `data-wb-width` 档位，**不要**用 `@media` 判视口——官方右栏会把中栏压到 400px 而不改视口。

### 5.2 密度
| 档 | 行高 | 组头 | 卡距 | 适用 |
|---|---|---|---|---|
| 紧凑 | 28 | 24 | 8 | 与 DSH 会话列表同密度 |
| **舒适（默认）** | 36 | 28 | 12 | 兼顾可扫读与命中率 |
| 宽松 | 40 | 28 | 16 | 原实现，老用户迁移用 |

存 `localStorage['dsh.workbench.density']`；改档只改 `.dwb-root{--wb-row}` 与三个伴随值，不动任何组件 CSS。

### 5.3 深色与窄屏
- 深色完全由宿主驱动：插件不写 color-scheme，不写 media query；自绘图形（品牌 mark）在深色下换成 `--dsw-alias-label-primary` 描边版。
- 边框在深色要"提亮而不是提暗"：一律用 `--dsw-alias-border-l1..l3`（深色值是 `#ffffff0f/1f/29`），禁止硬编码 `rgba(0,0,0,.x)`。
- 右栏 <768 自动全屏 → W2 必须按 768 单列重排（三段列表头吸顶，行高 36）。

---

## 6. 无障碍（WCAG AA 基线）

| 项 | 要求 |
|---|---|
| 对比度 | 正文 4.5:1；11px chip 文字也要 4.5:1（所以 warn 用 `-label` #dd8629 而非 #f59e0b）；优先级点旁边必须有文字 |
| 键盘 | Tab 顺序：head → toolbar → rail → list → detail；行内 checkbox 与行本体的 Enter 行为分离（Space 勾选、Enter 打开详情） |
| 焦点 | 只用 `--dsw-focus-ring-*`；详情抽屉打开时焦点进入抽屉并 trap，Esc 关闭后回焦到来源行 |
| 语义 | 列表 `role="list"` + 行 `role="listitem"`/`aria-selected`；checkbox 用真实 `input type=checkbox` 或 `role="checkbox" aria-checked`；进度条 `role="progressbar"` |
| 动效 | `prefers-reduced-motion: reduce` 时抽屉/浮层改瞬切（保留 80ms 透明度） |
| 缩放 | 200% 文本缩放下不截断标题（ellipsis 单行 ok），不出现横向滚动 |
| 触摸 | 窄屏行内控件命中区 ≥36×36，密集档也不小于 32 |

---

## 7. 雷区（"做成通用雷同界面"的十个信号，上线前逐条拦截）

1. 面板里出现自己的标题栏 / 关闭按钮 / 最小化 → 与 DSH chrome 打架，一眼外挂。
2. 主色仍是 `#2563EB`（Tailwind blue-600）→ 与宿主 deepseek 蓝并排就露馅。
3. 卡片圆角 10px、行高 40px、`--shadow-2` 手写阴影 → 不属宿主档位。
4. 全部用「暂无数据」「加载中…」→ 通用感最强的一处。
5. 空态用灰色大图标 + 居中两行文字 + 「新建」按钮 → 任何后台都有；今日清空态应给"今天已经清空 + 下一步去哪"。
6. 优先级只有颜色没有文字（色盲 + 语义缺失）。
7. 表格化（真 `<table>` + 斑马纹）→ 宿主没有表格语言，列表语义才匹配。
8. 把 Ctrl+K 命令面板原样搬进插件（DSH 无全局面板，出来就是"第二个搜索框"）。
9. 右侧栏 tab 自带标题行/工具栏（宿主规定 tab 内无标题行，控件挂 tab 条末端）。
10. 深色靠 `prefers-color-scheme` 或自带切换开关 → 与宿主手动主题打架，且多一个无效控件。

---

## 8. 与 iframe 方案（Phase 1 过渡）的视觉代价

可行前提：宿主半边把 `public/` 以同源静态路由托管（如 `/workbench/app/*`），面板里 `<iframe src="/workbench/app/index.html">`。代价与必须打的补丁：

| 问题 | 影响 | 补丁 |
|---|---|---|
| iframe 不继承 `--dsw-*` | 颜色/圆角/阴影全部退回旧值，两套视觉并排 | 父窗同源读 `getComputedStyle(document.documentElement)` 取 `--dsw-*`，`postMessage` 注入子窗 `:root`；同理监听 `body[data-ds-dark-theme]` 属性变化转发 |
| `--dsh-content-font-size` 等字阶 | 用户调字阶插件不跟随 | 一并转发 |
| `corner-shape` superellipse 圆角平滑 | 圆角手感与宿主不一致（次要） | 转发 `corner-shape` 声明；不支持则接受 |
| 自有标题栏 + Ctrl+K 面板 | 双重 chrome，最伤观感 | 加 `?embed=1`：隐藏 titlebar/#btnTheme/#btnSettings/palette，保留内容区；主题与命令入口交给宿主 |
| 焦点与快捷键隔离 | Ctrl+K / F 只在 iframe 内生效；Esc 不冒泡 | 明确不做快捷键注册，改为面板内按钮；Esc 用 postMessage 转出 |
| 高度/滚动双条 | 出现两条滚动条 | iframe 高度 100%，子窗 `overflow:hidden`，滚动交给子窗内部容器 |

**判断**：Phase 1 用 iframe 上架是合理的（1–2 天可出可安装包，用户能真用）；但**上架截图别用 iframe 版**，会被验收者当"外挂网页"。Phase 2 起按 §2 原生重建。

---

## 9. 验收清单（可测，逐条打勾）

**结构**
- [ ] 侧栏出现「待办工作台」图标，点击后中栏切为工作台面板，且**面板内没有第二个标题栏**
- [ ] 面板顶部内容不被 Windows 标题栏遮挡（`--dsh-frame-top-clearance` 生效）
- [ ] 1440 宽下三列（196/弹性/320）；1080 以下详情变抽屉；720 以下 rail 收 56
- [ ] 右侧栏「今日」tab 打开时面板宽 ≈512，此时详情列自动改为抽屉（不挤压列表）
- [ ] 右栏 <768 全屏时 W2 按单列重排，无横向滚动

**视觉**
- [ ] 全站无 `#2563EB`、无 `#F4F5F7`、无 10px 圆角、无手写 `box-shadow`
- [ ] 切换宿主主题（浅↔深）后，面板全部表面/文字/边框随之变化，无残留浅色块
- [ ] 宿主字阶调到 18 时，标题与 chip 不溢出、不换行错位
- [ ] 主按钮/选中/焦点环颜色与 Plugins 页并排一致
- [ ] 深色下边框肉眼可见（未硬编码黑色 alpha）

**交互**
- [ ] hover 行显行动作、移出不残留
- [ ] 选中行有 2px 左色条 + tertiary 底；键盘上下移动选中态同步
- [ ] checkbox Space 勾选、Enter 打开详情、Esc 关抽屉并回焦
- [ ] 月历浮层在靠右/靠底时自动翻转，900 宽不出画
- [ ] 密度三档切换后行高/组头/卡距三处同步变化
- [ ] 骨架只在 >1.2s 出现，空态文案各不相同

**无障碍**
- [ ] 全程 Tab 可达，焦点环处处可见（含深色）
- [ ] 优先级在详情与 tooltip 有文字，不只靠颜色
- [ ] 200% 文本缩放无横向滚动、无截断误读
- [ ] `prefers-reduced-motion` 下无位移动画

---

## 10. 待核对（阻塞项标 ★）

1. ★ **面板宽度的真实下限**：官方说右栏为保中栏 400px 会先压到 300px——那么主面板最窄可能是 ~400px，我的 5 档断点需要按实测调整；需在 1280×800 与 1440×900 上各截一张真实宿主截图核对。
2. ★ **`--dsh-frame-top-clearance` 在 Web（浏览器）形态下的值**：本次只从桌面 asar 推出 Windows=标题栏高度；Web 形态若无此变量，需 fallback 0。
3. ★ **DSH 页面 CSP 是否允许 `frame-src 'self'`**（决定 iframe 过渡方案生死）。
4. `sidebar.panellist` 图标组件的 props 契约（是否只接 `{}`，是否需 `aria-label`）——待读 `dsh-client-ui-sidebar` 的 client 实现。
5. 快捷键/命令注册的确切符号（`ctx.shortcuts`? `ctx.commands`?）——`_doc_sc.md` 只讲了目录与排序，没给注册 API。
6. `shell.toggle.badge` 席位是否可写角标（我只确认了 `sidebar.toggle.badge`）。
7. `corner-shape: superellipse(1.5)` 是否全局生效于插件元素（若全局，我的 `border-radius:50%` 圆点需配 `corner-shape:round`，已按此写）。
8. 宿主菜单/浮层是否提供可复用表面变量（`--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter`）——我倾向 W4/W5 直接复用它们以贴合"原生感"，需确认语义契合。

---

## 11. 交付物清单

| 文件 | 内容 |
|---|---|
| `docs/dsh-plugin-ui-design-2026-10-20.md` | 本文档 |
| `docs/design-preview/dsh-workbench-mockup.html` | 高保真稿：浅色宽面板帧、深色窄面板＋今日 tab＋空态帧、组件画廊；全部 token 化，可直接改 token 复现 |
| `docs/design-preview/dsh-shot-A-1440.png` | 帧 A 出图：1440×900 浅色 · 宽面板（rail 196 ／ 列表 ／ 详情 320），可直接当商店截图底稿 |
| `docs/design-preview/dsh-shot-B-1440.png` | 帧 B 出图：1440×900 深色 · 窄面板（512，rail 收起）＋右侧「今日」tab＋清空空态 |
| `docs/design-preview/dsh-mockup-full-1500.png` | 上述两帧＋组件画廊的整体出图（Edge headless 实拍，1500 宽） |

> 出图方式：`msedge --headless=new --window-size=1440,900 --screenshot=… "…/dsh-workbench-mockup.html#A"`（`#A` 浅色宽面板 / `#B` 深色窄面板 / `#gal` 组件画廊）。改 token 后重出图即可回归。
