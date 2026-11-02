# 工作台仓库约定

## 打包与发布（重要）

默认**只改源码、只做本地验证，不打包、不更新安装包**。

- 禁止擅自运行：`node scripts/build-dist.mjs`（会重写 `dist/` 里的三个 exe/zip 和使用说明）、任何生成安装包/便携包/单文件 exe 的操作。
- 禁止擅自改动 `dist/` 目录内容，也不要替换、重命名或删除已交付的产物。
- 改完功能后的标准收尾是：源码落盘 + `node scripts/smoke.mjs`、`node scripts/ui-smoke.mjs`、`node scripts/e2e.mjs` 这类本地验证通过，然后说明「改动已完成，等你指令再打包」。
- 只有在用户明确说「打包 / 出安装包 / 更新安装包 / 发新版本」时，才执行 `scripts/build-dist.mjs` 与相关的 dist 更新，并重新自检。
- 文档同理：`README.md` 随代码更新；`dist/使用说明.txt` 属于发布物，只在打包时更新。

## 其他

- 数据文件（`data/`、`archive/`）是用户真实数据，不要在验证中清空；需要用测试库时用临时目录或 `scripts/reset.mjs` 前先确认。
- 改 C#／源码请用编辑工具逐处改，不要用 PowerShell `Set-Content -Encoding utf8` 回写整文件（会把中文按 ANSI 解码再写回，产生乱码与语法错误）。
