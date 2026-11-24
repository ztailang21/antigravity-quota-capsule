---
name: quota-capsule-setup
description: >-
  Install, update, troubleshoot, or uninstall the Antigravity Quota Capsule
  Windows plugin that displays model quotas between the Model Selector and
  Turbo button in the Antigravity 2.0 composer bar.
---

# Antigravity Quota Capsule — Windows Setup & Troubleshooting Skill

Use this skill when the user asks to install, configure, update, diagnose, or
uninstall **Antigravity Quota Capsule** on Windows.

## Installation Steps (Windows)

1. Run the bundled PowerShell installer from the repository root:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```
2. The installer automatically:
   - Installs the plugin into `~/.gemini/config/plugins/antigravity-quota-capsule/`.
   - Locates Windows shortcuts (`Antigravity.lnk`) on Desktop, Start Menu, and Taskbar.
   - Backs up original shortcut arguments to `%APPDATA%\AntigravityQuotaCapsule\shortcut_backup.json`.
   - Appends `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0` so the Sidecar can mount the Shadow DOM capsule into the composer bar without modifying `app.asar`.
3. Ask the user to fully quit and relaunch Antigravity 2.0 using the updated shortcut, and confirm **Antigravity Quota Capsule** is enabled in **Settings -> Plugins**.

## Opening the Settings & Diagnostics Pane

When the plugin is running, offer this clickable sidecar link:

[Quota Capsule](sidecar://antigravity-quota-capsule/quota-capsule/aux-pane.html)

## Troubleshooting Checklist

- **Capsule not showing in composer bar**:
  - Verify Antigravity was launched with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0`.
  - Check whether `DevToolsActivePort` exists under `%APPDATA%\Antigravity\` or `%LOCALAPPDATA%\Antigravity\`.
  - Open the Aux Pane settings view to inspect live CDP connection status and diagnostic logs.
- **Uninstalling cleanly**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
  ```
