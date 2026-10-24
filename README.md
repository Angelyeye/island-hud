# Island HUD

**Island HUD** 是一个 Windows 顶部悬浮岛式 HUD，当前支持 DeepSeek Harness（下称 DSH）与 ZCode 两类本机编码代理。它以紧凑的岛形卡片常驻屏幕顶部，实时显示会话状态；需要你决策时自动展开审批或问答卡片，确认、拒绝、选择都在岛上完成，不必切回终端窗口。

Island HUD 由桌面应用与两类集成组成：DSH 通过原生插件接入，ZCode 通过 hook 配置接入。集成把客户端的会话状态、待处理请求与处理结果送给应用，应用通过只监听本机回环地址的通道接收并回传，不经过任何公网服务。

> **非官方声明**：本项目是独立的社区开源项目，与 DeepSeek 及其他任何产品、公司、团队均无关联，也未获得任何形式的背书、授权或支持。

## 界面预览

| 总览 | 全部会话 | 设置 |
| --- | --- | --- |
| ![总览](screenshots/overview.png) | ![全部会话](screenshots/sessions.png) | ![设置](screenshots/settings.png) |

## 功能特性

- **会话状态**：展示当前会话、项目与运行状态，空闲时自动收起为窄条。
- **单次审批**：允许、拒绝、取消权限请求，结果同步回 DSH / ZCode。
- **多题问答**：单选、多选、自由文本，支持逐题草稿与中文输入法。
- **精确跳转**：从卡片直接跳到对应的 DSH 会话；ZCode 会话打开其项目目录。
- **归档与删除**：在本机隐藏不需要的会话，不删除客户端数据，可随时恢复。
- **多会话浏览**：岛上最多同时展示 50 条会话（待处理与运行中优先），全部会话面板为紧凑滚动列表。
- **中文设置**：面板密度（520px / 440px 两档）、内容字号、最大高度、主题与实时预览。
- **非阻塞接续**：面板收起后请求仍在后台等待，可稍后继续回答。

## 系统要求

- Windows 10 / 11（x64）
- Node.js 24（自带 npm；ZCode 集成的 hook 脚本同样由 `node` 执行）
- DeepSeek Harness 0.2.1-rc.2（实测版本；更早版本可能无法安装插件）
- ZCode CLI（hook 已可用即可，无需额外配置）
- Electron 33.4.11（已在 `package.json` 中精确锁定）
- 可用的 .NET Framework 4 C# 编译器（用于构建管道助手，Windows 自带）

## 快速开始

```powershell
git clone https://github.com/Angelyeye/island-hud.git
cd island-hud
npm ci
npm run build:helpers
npm start
```

- `npm ci` 按锁文件安装依赖；若 Electron 二进制下载受限，可临时设置 `$env:ELECTRON_MIRROR` 指向镜像。
- `npm run build:helpers` 用 `tools/pipe-host.cs` 编译管道助手到 `src/tools/`，源码变更后会自动重建。
- `npm start` 是**隔离开发模式**：使用独立的 `work/development` 配置与数据目录，不会改动你正在使用的 DSH / ZCode 配置和模型权限。正式使用请在设置中安装对应集成。

## 安装 DSH 插件

1. 启动 Island HUD（开发模式或打包版均可）。
2. 在任务栏托盘图标上右键，选择「设置…」。
3. 打开「集成」页，确认 DSH 状态为可连接。
4. 点击「安装 / 修复」，等待提示写入完成（每次操作都会先备份现有配置）。
5. 重启 DSH，让插件生效。

卸载时回到同一页面点击「卸载集成」，不会删除 DSH 自身的会话数据。

## 安装 ZCode 集成

1. 启动 Island HUD，打开「设置… → 集成」页的 ZCode 卡片。
2. 点击「安装 / 修复」：会把 Island HUD 的 hook 写入 ZCode 用户配置（`~/.zcode/cli/config.json`），写入前自动备份，只改动本集成添加的条目。
3. 重新发起一个 ZCode 会话即可生效；会话状态、权限审批与提问会出现在岛上，直接在岛上「允许 / 拒绝」或回答。
4. 卸载时点击「卸载集成」，只移除本集成添加的 hook 条目。

说明：

- hook 脚本由 `node` 执行，请确保 Node.js 在 PATH 中。
- 审批卡片打开期间，ZCode 的原生命令会等待岛上决策；退出 Island HUD 或长时间不响应时自动回退 ZCode 原生审批，不会卡住会话。
- 只读工具（Read / Glob / Grep 等）与自动批准模式不会中转，行为与原来一致。
- 若已安装其他会在 `PermissionRequest` 上阻塞的 hook（例如其他审批桥），两者会同时等待响应；设置页会提示冲突，请按需停用其一。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Alt+I` | 显示 / 隐藏悬浮岛 |
| `Ctrl+Alt+O` | 展开 / 收起全部会话面板 |
| `Esc` | 收起当前展开的面板 |

右键托盘图标还可以重新居中、切换显示器、设置全屏自动隐藏、打开日志目录或复制诊断信息。

## 已知限制

- DSH 的插件扩展点尚未公开稳定，DSH 升级后可能需要同步更新插件。
- ZCode 集成依赖其 hook 配置格式，ZCode 升级后可能需要同步更新；问答经审批面回传属实验性协议。
- 构建产物未做代码签名，Windows SmartScreen 可能提示风险。
- 项目处于早期实验阶段，接口与界面仍可能调整。
- 只支持 Windows + DSH / ZCode 组合；其他操作系统与其他客户端不在支持范围内。
- 自动化测试覆盖 Node 层逻辑，GUI 与托盘行为需要在本地桌面手动验证。

## 目录结构

```text
island-hud/
├─ src/
│  ├─ main.js            Electron 主进程：窗口、托盘、悬浮岛与全局快捷键
│  ├─ preload.js         渲染进程与主进程之间的受控桥
│  ├─ app/               应用生命周期、设置、集成管理与窗口行为
│  ├─ bridge/            本机回环服务，接收并回传集成请求
│  ├─ dsh/               DSH 适配层、会话管理与导航

│  ├─ integrations/      DSH 插件包与 ZCode hook 的构建素材
│  ├─ logs/              诊断日志
│  ├─ probe/             测试与开发启动入口
│  ├─ renderer/          悬浮岛与设置页界面
│  ├─ sessions/          会话存储、归档与可见性
│  ├─ tools/             运行时助手二进制（构建产物）
│  └─ update/            更新检查
├─ tools/                构建、打包、测试与发布脚本（含 C# 助手源码）
├─ test/                 Node 层测试
├─ screenshots/          README 界面截图
├─ build/                打包配置与图标素材
└─ integrations/         生成的 DSH 插件包与 ZCode hook 客户端
```

## 测试

```powershell
npm test
```

`npm test` 运行 Node 层的单元与集成测试，不需要打开窗口，CI 也只跑这一项。需要真实桌面环境的 GUI 与托盘检查请在本地执行：

```powershell
npm run test:ui
npm run test:tray
```

## 参与贡献

欢迎提交问题与改进。开始之前请阅读 [贡献指南](.github/CONTRIBUTING.md)，提交的每个 commit 需要包含 `Signed-off-by` 行（DCO）；安全问题请按 [安全策略](.github/SECURITY.md) 私下上报，不要公开提交带令牌、日志或本机路径的内容。

## 代码签名策略

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Angelyeye](https://github.com/Angelyeye)
- Approvers: [Angelyeye](https://github.com/Angelyeye)

目前正在申请 SignPath Foundation 免费开源签名；**在申请通过并发布首个签名版本前，所有发布产物均为未签名状态**。签名覆盖范围、验证方式与隐私说明见 [Code signing policy](.github/CODE_SIGNING_POLICY.md)。

## 许可证

本项目以 **GNU Affero General Public License v3.0**（AGPL-3.0-only）发布，版权归 **Angelyeye** 所有，完整条款见 [LICENSE](LICENSE)。第三方依赖及其许可见 [NOTICE](NOTICE)；其中 `integrations/dsh/preset-standard.patch.yml` 基于 DeepSeek DSH 的 MIT 许可 preset 修改，版权与许可声明见该文件头及 NOTICE。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)