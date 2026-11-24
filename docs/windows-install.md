# Windows 安装指南 (`antigravity-quota-capsule`)

本插件专为 **Windows 10 / Windows 11 + Antigravity 2.0 桌面端** 打造，零第三方依赖（无需 `npm install`，无需管理员权限，**零修改 `app.asar`**，原生支持中文/非 ASCII Windows 用户名路径）。

---

## 方式一：让 Antigravity AI 一键代装（推荐）

直接把下面这句话发给 Antigravity：

> 请按 https://github.com/ztailang21/antigravity-quota-capsule/blob/main/docs/windows-install.md 帮我安装 antigravity-quota-capsule。

（AI 会自动克隆仓库并运行 `scripts\install.ps1`。）

---

## 方式二：PowerShell 手动一键安装

```powershell
git clone https://github.com/ztailang21/antigravity-quota-capsule.git
cd antigravity-quota-capsule
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会自动完成两件事：
1. 将插件安装到 `%USERPROFILE%\.gemini\config\plugins\antigravity-quota-capsule\`（支持运行中原位覆盖升级）；
2. 查找桌面 / 开始菜单 / 任务栏中的 `Antigravity.exe` 快捷方式，备份原始参数到 `%APPDATA%\AntigravityQuotaCapsule\shortcut_backup.json`，并追加本地回环调试参数：
   ```text
   --remote-debugging-address=127.0.0.1 --remote-debugging-port=0
   ```

### 启用步骤
1. **完全退出** Antigravity 2.0（注意检查右下角系统托盘确保进程已彻底退出），通过更新后的快捷方式重新启动；
2. 在 Antigravity 左下角 **Settings -> Plugins** 中确认 **`Antigravity Quota Capsule`** 已启用；
3. 底部输入栏的 **「模型选择器」与「极速 (Turbo)」之间** 即可自动出现实时额度胶囊；
4. 点击（或悬停）胶囊即可展开完整 4 项实时额度卡片，也可在右侧辅助栏打开 **`Quota Capsule`** 面板自定义密度、语言与查看诊断状态。

---

## 手动配置快捷方式（如跳过自动修改）

如果你运行了 `install.ps1 -SkipShortcutPatch`，或使用自定义启动器，请右键 Antigravity 快捷方式 -> **属性** -> 在「目标 (Target)」末尾（引号外部）添加：

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=0
```

示例：
```text
"C:\Users\<你的用户名>\AppData\Local\Programs\antigravity\Antigravity.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0
```

---

## 常见问题排查

1. **底栏未显示胶囊，右侧面板提示“等待调试端口”**
   - 确认你是通过添加了 `--remote-debugging-port=0` 参数的快捷方式启动 Antigravity；
   - 如果 Antigravity 原先在右下角托盘驻留，新启动会复用旧进程而忽略新参数——请彻底退出托盘图标后再重新打开。
2. **更新插件**
   - 在仓库目录 `git pull` 后重新运行 `.\scripts\install.ps1`，然后在 Antigravity **Settings -> Plugins** 中关闭再重新开启插件即可（支持运行中原位更新）。
3. **干净卸载**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
   ```
   脚本会自动还原快捷方式原始参数并删除插件目录；如需同时清除本地配置与缓存，附加 `-PurgeData` 即可。
