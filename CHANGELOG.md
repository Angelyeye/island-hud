# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。日期按本地时区记录。

## [Unreleased]

### 新增

- **客户端审批让位**（可选，默认关闭）：设置 → 通用 → 审批与提问可开启。开启后审批/提问卡片先在小岛倒计时，到期无人操作自动交回客户端，由 DSH / ZCode / Claude Code / Codex 的原生审批界面接管，可直接在 agent 内决策；倒计时期间小岛点击仍生效，收起卡片或编辑答案会暂停倒计时。新增实机回归 runner（handoff-runner）覆盖倒计时、自动让位、收起守卫与重新展开。

### 新增

- **Claude Code 支持**：通过 `~/.claude/settings.json` hook 接入（遵循 `CLAUDE_CONFIG_DIR`），岛上展示会话状态，权限审批与 `AskUserQuestion` 问答可直接决策；问答答案经 `PreToolUse` 的 `updatedInput` 回写（问题文本与 header 双键）。协议行为以本机 Claude Code 2.1.310 实测为准。
- **Codex CLI 支持**：通过 `~/.codex/hooks.json` 原生 hook 接入（遵循 `CODEX_HOME`），岛上展示会话状态与权限审批（仅交互 TUI 会话，需在 Codex 内 `/hooks` 信任一次；`codex exec` 不产生审批事件属上游行为）。以本机 Codex 0.164.0 实测为准。
- 设置页新增 Claude Code 与 Codex 集成卡片：安装 / 修复 / 卸载均先备份、原子写入、只改动本集成添加的条目，并检测其他 `PermissionRequest` hook 的共存冲突；Claude 配置了 `disableAllHooks` 时给出警告。
- 新增可选真实 CLI 端到端测试 `npm run test:e2e`（需 `ISLAND_HUD_E2E=1`，消耗少量模型额度）：真实 `claude -p` / `codex exec` 会话经沙箱配置把审批与事件送到岛上并自动应答。
- 新增实机 GUI 回归 runner（`npm run test:ui` 的 providers-runner）：真实 hook 脚本 × 真实管道 × 真实 Windows 鼠标点击，覆盖 Claude/Codex/ZCode 审批与问答决策。

### 变更

- hook 集成所有权匹配改为版本无关的 packages 目录标记：升级后自动替换旧版本 hook 组，不再残留失效条目（ZCode 同步修复，含回归测试）；匹配对路径分隔符不敏感。
- 岛上审批 / 问答卡片在无既有会话时也正确显示来源芯片（此前显示通用 HUD 徽标）。

### 修复

- 渲染层全面改为节点树构建：`IslandPresentation` 新增 `material()`，`wave` / `header` / `markdown` 与岛视图、原生请求卡片改为先描述节点树、在 DOM 边界一次性物化，文本一律经文本节点注入；`setHTML` / `innerHTML` / `insertAdjacentHTML` 动态汇聚点全部移除，从结构上消除转义遗漏导致的 XSS 风险面。
- `application-runner` GUI 测试仍调用 v0.2.0 已更名的 `focusDsh` 预加载 API，导致该 runner 在 main 上失败；改用 `focusSession`。

## [0.2.0] - 2026-10-25

### 新增

- **ZCode 支持**：通过 ZCode hook 接入，岛上展示 ZCode 会话状态，权限审批与多题问答可在岛上直接决策，与 DSH 会话合并在同一个列表里。
- 设置页新增 ZCode 集成卡片：安装 / 修复 / 卸载会把 hook 写入 `~/.zcode/cli/config.json`，写入前自动备份，只改动本集成添加的条目；检测到其他 `PermissionRequest` hook 时提示共存冲突。
- ZCode 问答经审批面回传答案（`updatedInput`），属实验性协议；失败时自动回退 ZCode 原生界面。
- 集成超时改为按客户端区分：ZCode 审批 / 问答卡片可等待最长 24 小时，DSH 保持原有 120 秒 / 600 秒。

### 变更

- 会话更新通道 `dsh:update` 更名为内部通道 `island:sessions`；预加载 API `focusDsh` 更名为 `focusSession`。
- `island:focus` 对 ZCode 会话打开其项目目录（ZCode 暂无会话深链）。
- 更新检查不再自动下载并运行安装器：发现新版本时引导用户打开 GitHub Releases 页面自行下载；清单版本作为不可信输入校验（仅数字与点）。
- 诊断与桥接证据日志路径在启动时一次性解析为常量。
- 运行时升级 Electron 33.4.11 → 42.11.16（已 EOL 的 33 系列的 4 条安全通告随升级清除）。
- `integrations/*/lib/*.cjs` 生成文件头部增加 `AUTO-GENERATED` 标注，避免被误当作源码直接修改。

### 修复

- 控制台或测试运行器的输出管道提前关闭时，诊断日志自动降级为仅写文件，不再触发 `EPIPE` 主进程异常弹窗。
- `foreground-watcher.exe` 纳入 `npm run build:helpers` 一并编译：此前打包版从未包含该助手，「全屏时自动隐藏」开关会静默失效；现在安装版 / 便携版功能可用，新增测试校验助手二进制与源码摘要一致。
- Electron 运行时校验改为跟随 `package.json` 锁定版本（原为硬编码 33.4.11）：升级 Electron 后 `npm start` / UI 测试 / 打包不再需要逐处改代码。
- 移除未被任何界面使用的 `island.openPath` IPC 通道（无发送方校验的任意路径打开入口）。
- 岛上审批卡片的来源徽标文本统一转义；应用图标资产缺失时回退到程序绘制图标，不再让启动路径抛错。
- 修复 renderer GUI 测试与渲染层的脱节：同步提示文案断言与 ZCode 多 provider 化后的实际界面一致，会话推送通道名更新为 `island:sessions`。

### 说明

- ZCode hook 脚本由 `node` 执行，需要 Node.js 在 PATH 中。
- 只读工具与自动批准模式不经过岛上审批，行为与原生一致。
- `--uninstall-cleanup` 现在会同时移除 DSH 与 ZCode 集成。

## [0.1.0] - 2026-10-24

首个公开发布版本。

### 新增

- Windows 顶部悬浮岛式 HUD，展示 DSH 会话状态与摘要，空闲时自动收起。
- 单次审批：允许、拒绝、取消，结果实时回传 DSH。
- 多题问答：单选、多选、自由文本，支持逐题草稿与中文输入法。
- 从悬浮岛精确跳转到对应的 DSH 会话。
- 会话归档与删除：仅在本机隐藏，不删除 DSH 数据，可在设置中恢复。
- 岛上最多同时展示 50 条会话，超出时自动隐藏最旧项，待处理与运行中优先。
- 全部会话面板改为紧凑滚动列表，多会话下仍可快速浏览。
- 中文设置界面：面板密度（520px / 440px）、内容字号、最大高度、主题与实时预览。
- 托盘菜单：重新居中、显示器切换、全屏自动隐藏、更新检查、日志与诊断信息。
- DSH 插件安装与修复流程，写入前自动备份现有配置。
- 全局快捷键：`Ctrl+Alt+I` 显隐、`Ctrl+Alt+O` 展开或收起、`Esc` 收起面板。

### 说明

- 仅支持 Windows 10 / 11 x64 与 DeepSeek Harness。
- 构建产物未签名，首次运行可能出现 SmartScreen 提示。
- 本版本为早期实验版本，接口可能随 DSH 更新调整。
- `integrations/dsh/preset-standard.patch.yml` 基于 DeepSeek DSH 的 MIT 许可 preset 修改，版权与许可声明保留在文件头与 `NOTICE` 中。
- 移除不可用的 `package:win` / `package:nsis` 脚本与未使用的 MCP 依赖声明。
