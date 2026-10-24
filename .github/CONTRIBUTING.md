# 贡献指南

感谢你愿意改进 Island HUD。提交前请先读完本页，它可以省掉不少来回沟通。

## 开发环境

- Windows 10 / 11 x64
- Node.js 24
- PowerShell 7（示例命令均以 PowerShell 给出，请按需调整）

```powershell
npm ci
npm run build:helpers
npm test
```

## 分支与提交

- `main` 是发布分支，只接受通过 PR 合入的改动，请勿直接向 `main` 推送。
- 开发时从最新的 `main` 拉出功能分支，命名参考：`feat/session-list-scroll`、`fix/tray-menu-crash`、`docs/readme-typos`、`chore/upgrade-electron`。
- 一个 PR 只做一件事，避免把格式化、重构和功能混在一起。
- 文档分中英两份：`README.md` 是简体中文主版本（仓库首页默认展示，内容以它为准），`README.en.md` 是英文镜像；改动功能说明、命令或数字时请同步更新两份，避免两者不一致。

## DCO 签名

本项目采用 Developer Certificate of Origin（DCO）而非 CLA。每个提交都需要由你本人签署：

```powershell
git commit -s -m "fix: 修正多会话面板滚动位置"
```

提交信息末尾会自动附加：

```text
Signed-off-by: Your Name <you@example.com>
```

签名表示你有权按本项目许可证提交该改动。使用 `git commit -s` 即可，无需另行签署文件。

## 提交信息规范

采用 Conventional Commits 风格的简短前缀：

- `feat:` 新功能
- `fix:` 缺陷修复
- `docs:` 文档
- `test:` 测试
- `refactor:` 不改变行为的重构
- `chore:` 构建、依赖与杂项

标题用中文或英文均可，保持一句话说清改了什么、为什么改。

## 测试

- `npm test`：Node 层单元与集成测试，提交前必须通过，CI 也只跑这一项。
- `npm run test:ui`、`npm run test:tray`：需要真实桌面的 GUI 与托盘检查。修改界面或托盘行为时请在本地执行，并在 PR 中说明结果。
- 新增逻辑请附带测试；修复缺陷时优先补一个能复现问题的测试。

## 禁止提交的内容

- 个人配置文件、本机路径、真实会话记录与日志。
- 任何令牌、密钥、证书、`.env` 文件或抓包内容。
- `node_modules/`、构建产物、截图中的隐私信息。
- 第三方产品的图片、图标、字体或界面素材。

## PR 流程

1. Fork 仓库或从维护者处获取写权限。
2. 基于 `main` 建分支并完成改动。
3. 本地跑通 `npm test`，需要时补跑 GUI 检查。
4. 推送分支并创建 PR，说明动机、改动点与验证方式。
5. 维护者会做代码审阅，可能请你补充测试或拆分提交。

## 问题反馈

请使用仓库的 Issue 模板提交缺陷或功能建议。安全相关问题不要开公开 Issue，请按 [SECURITY.md](SECURITY.md) 的方式私下上报。
