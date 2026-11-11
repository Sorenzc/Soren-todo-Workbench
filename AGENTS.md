# 工作台仓库约定

## 打包与发布（重要）

默认**只改源码、只做本地验证，不打包、不更新安装包**。

- 禁止擅自运行：`node scripts/build-dist.mjs`（会重写 `dist/` 里的安装包与便携包）、任何生成安装包/便携包/单文件 exe 的操作。
- 禁止擅自改动 `dist/` 目录内容，也不要替换、重命名或删除已交付的产物。
- 改完功能后的标准收尾是：源码落盘 + `node scripts/smoke.mjs`、`node scripts/ui-smoke.mjs`、`node scripts/e2e.mjs` 这类本地验证通过，然后说明「改动已完成，等你指令再打包」。
- 只有在用户明确说「打包 / 出安装包 / 更新安装包 / 发新版本」时，才执行 `scripts/build-dist.mjs` 与相关的 dist 更新，并重新自检。
- 文档同理：`README.md` 随代码更新；`dist/使用说明.txt` 属于发布物，只在打包时更新。

## 发布铁律（用户明确要求，务必遵守）

### 1. Release 资产用固定名，不带版本号

**只发两个包：安装包 + 绿色便携包。** 单文件版与独立的 README-install.txt 已停止发布（`build-dist.mjs` 也不再生成单文件版）。

| 固定名 | 来自 |
| --- | --- |
| `todo-workbench-setup.exe` | `dist/待办工作台-<版本>-安装包.exe` |
| `todo-workbench-portable.zip` | `dist/待办工作台-便携版.zip` |

原因：用户的个人网页直接链接 `releases/latest/download/todo-workbench-setup.exe`，每次发版都不用改链接。

- tag / Release 标题仍写 `vX.Y.Z`，只有**附件名不带版本号**
- 上传前先把 dist 里的产物复制到临时目录并改成固定名（中文名会被网关截断，固定名同时解决这个问题）
- 发布说明里的下载表格也写固定名，并给出 `releases/latest/download/<固定名>` 形式的链接
- 发布前用 `--preview=1|2|3 --shot=<png>` 把安装向导三页各截一张图，确认没有文字遮挡、错行或被裁掉

### 2. 打包、发布前必须清掉演示数据

顺序固定为：先截图（需要演示数据）→ 再清数据 → 再打包 → 再发布。

清理动作：

```
node scripts\stop.mjs
node scripts\reset.mjs          # 清空任务、速记、系列、归档，保留分类与设置
```

- 清完删掉 `data/backups`（里面有清库前的快照，含演示数据）、`data/shots`、`data/updates`、`data/edge-cdp-profile`、`archive/*`
- 用 sqlite 确认 `task` / `memo` / `task_series` 都是 0 行、`archive/` 是 0 个文件，再往下走

### 3. 发布流程

清数据 → 提交 → 推送（`github.com:443` 不通时用 Git Data API 重放提交）→ 打 tag `vX.Y.Z` → `node scripts\build-dist.mjs` → `gh release create` → 上传两个固定名资产 → 校验资产 `state=uploaded` 与大小。

## 其他

- 数据文件（`data/`、`archive/`）是用户真实数据，不要在验证中清空；需要用测试库时用临时目录或 `scripts/reset.mjs` 前先确认。
- 改 C#／源码请用编辑工具逐处改，不要用 PowerShell `Set-Content -Encoding utf8` 回写整文件（会把中文按 ANSI 解码再写回，产生乱码与语法错误）。
