# Antigravity Quota Capsule (Windows Plugin)

真正的 **Antigravity 2.0 原生插件**（`plugin.json` + `sidecar.json`），将 **Gemini** 与 **Claude / GPT** 的 **5 小时限额与周限额** 以轻量 Shadow DOM 胶囊形式，直接嵌入到底部输入框的 **「模型选择器」与「极速 (Turbo)」之间**，自动同步实时额度，点击/悬停即可展开 1:1 原生风格的完整额度卡片。

> A zero-dependency native **Antigravity 2.0 plugin** built specifically for Windows. Mounts a live Shadow DOM quota capsule directly inside the chat composer bar between the **Model Selector** and **Turbo/Mode** button, featuring native-grade automatic quota sync, Unicode-safe Windows sidecar launch (works on Chinese/non-ASCII Windows usernames), and an official Aux Pane settings & diagnostics panel.

---

## 核心特性 (Features)

- **原生 Antigravity 2.0 插件形态**：安装于 `~/.gemini/config/plugins/antigravity-quota-capsule/`，在 Antigravity **Settings -> Plugins** 直接开关，随客户端自动启动/停止，不是独立的托盘软件。
- **原生级自动同步额度（无需手动刷新）**：
  - **通道 1（Sidecar 原生 Connect-RPC 轮询）**：利用宿主传递的本地 `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` 定时自动同步 `RetrieveUserQuotaSummary` / `GetUserStatus` / `GetCommandModelConfigs`；
  - **通道 2（CDP 原生额度响应无感监听）**：在本地回环 CDP 会话中静默监听客户端自身的额度响应 JSON，客户端一刷新即实时同步全部 4 项（含 `0%` 耗尽状态与精确重置倒计时）；
  - **通道 3（DOM 捕获兜底）**：保留页面内捕获与点击刷新作为兜底保障。
- **真 DOM 嵌入 + 3 档响应式**：
  - 零修改 `app.asar`、不破坏客户端签名、抗自动更新；
  - 直接插入底栏 Flexbox 工具条，拖拽窗口、缩放高 DPI、弹出下拉菜单均 0 延迟原生适配；
  - 宽槽位并排展示双组（自动高亮当前模型组），标准槽位聚焦当前模型 `5h + 周` 限额，窄槽位自动折叠为迷你圆环 + 百分比。
- **Windows 深度专配（彻底解决中文用户名坑）**：
  - 内置全 Unicode 安全的 `launch.ps1` 启动器，绕开 `cmd.exe` / `agy-node.cmd` 在中文/非 ASCII Windows 用户名下的 CP936 编码崩溃问题；
  - 零第三方依赖（无需 `npm install`，无 Node.js 时也可自动回退复用 Antigravity 内置 Electron Node 运行时）；
  - 一键 `install.ps1` 自动安全配置并备份 Windows 快捷方式，`uninstall.ps1` 一键无痕还原。
- **官方 Aux Pane 设置与诊断面板**：在 Antigravity 右侧辅助栏实时切换显示密度、语言、悬停/点击行为、演示预览与查看连接诊断。

---

## Windows 快速安装 (Quick Start)

### 方式一：让 Antigravity AI 一键代装（推荐）
直接在 Antigravity 对话框发送：

> 请按 https://github.com/ztailang21/antigravity-quota-capsule/blob/main/docs/windows-install.md 帮我安装 antigravity-quota-capsule。

### 方式二：PowerShell 一键安装
```powershell
git clone https://github.com/ztailang21/antigravity-quota-capsule.git
cd antigravity-quota-capsule
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

然后**完全退出并重启 Antigravity 2.0**（确认系统托盘也已退出），在 **Settings -> Plugins** 确保 **Antigravity Quota Capsule** 已启用即可。

详细说明与排查见：[docs/windows-install.md](./docs/windows-install.md)。

### 干净卸载
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

---

## 项目结构

```text
antigravity-quota-capsule/
├── plugin.json                     # Antigravity 2.0 插件清单
├── sidecars/quota-capsule/
│   ├── sidecar.json                # Sidecar 声明与 Aux Pane 入口
│   ├── launch.ps1                  # Windows Unicode 安全启动器（免疫中文用户名 cmd 编码坑）
│   ├── server.mjs                  # 零依赖 Node.js Sidecar（状态持久化 + HTTP API + Aux Pane）
│   ├── native-quota-sync.mjs       # 原生 Connect-RPC 轮询与全格式 JSON 额度解析器
│   ├── cdp-bridge.mjs              # Windows DevToolsActivePort 探测 + 纯 JS RFC6455 CDP 桥接
│   ├── quota-parser.mjs            # 中/英文额度文案解析与倒计时引擎
│   ├── injected-widget.js          # Composer Shadow DOM 胶囊 + Portal 详情弹层
│   └── aux-pane.html               # 右侧官方 Aux Pane 设置与连接诊断面板
├── skills/quota-capsule-setup/     # AI 自动安装与排查技能
├── scripts/                        # Windows 一键安装 / 卸载脚本
├── docs/windows-install.md         # Windows 安装与故障排查文档
└── tests/run-tests.mjs             # 自动化测试套件
```

---

## 致谢与灵感来源

- 架构思路借鉴了社区优秀项目 [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) 与 [arthurcavallari/antigravity-sidecar-kit](https://github.com/arthurcavallari/antigravity-sidecar-kit)。

## 安全与隐私

- 严格仅绑定 `127.0.0.1` 本地回环，**零外部网络请求、零遥测**。
- 不修改 Antigravity 二进制/前端资源包（`app.asar`），不读取聊天正文或账户凭据。
- 所有配置与额度缓存仅保存在本机 `%APPDATA%\AntigravityQuotaCapsule\`。

## License

[MIT](./LICENSE)
