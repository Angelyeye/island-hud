# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。日期按本地时区记录。

## [0.2.0] - 2026-10-24

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
