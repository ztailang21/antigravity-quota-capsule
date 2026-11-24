#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipShortcutPatch
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$PluginName = 'antigravity-quota-capsule'
$PluginsDir = Join-Path $env:USERPROFILE '.gemini\config\plugins'
$TargetDir = Join-Path $PluginsDir $PluginName
$DataDir = Join-Path $env:APPDATA 'AntigravityQuotaCapsule'
$BackupFile = Join-Path $DataDir 'shortcut_backup.json'

Write-Host "=== Antigravity Quota Capsule (Windows Installer) ===" -ForegroundColor Cyan

# 1. Copy plugin files into ~/.gemini/config/plugins/antigravity-quota-capsule (in-place overwrite safe while sidecar is running)
if (-not (Test-Path $PluginsDir)) {
    New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
}
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

$itemsToCopy = @('plugin.json', 'sidecars', 'skills', 'README.md', 'LICENSE')
foreach ($item in $itemsToCopy) {
    $src = Join-Path $RepoRoot $item
    if (Test-Path $src) {
        if ((Get-Item $src).PSIsContainer) {
            Copy-Item -Path $src -Destination $TargetDir -Recurse -Force
        } else {
            Copy-Item -Path $src -Destination (Join-Path $TargetDir $item) -Force
        }
    }
}
Write-Host "[OK] Plugin installed to: $TargetDir" -ForegroundColor Green

# 2. Patch Windows Antigravity shortcuts with standard local-only CDP flags (with backup)
if (-not $SkipShortcutPatch) {
    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }

    $backupMap = @{}
    if (Test-Path $BackupFile) {
        try {
            $existing = Get-Content -Path $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($prop in $existing.PSObject.Properties) {
                $backupMap[$prop.Name] = [string]$prop.Value
            }
        } catch {
            $backupMap = @{}
        }
    }

    $searchDirs = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Programs'),
        [Environment]::GetFolderPath('CommonPrograms'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

    $wsh = New-Object -ComObject WScript.Shell
    $patchedCount = 0
    $flags = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=0'

    foreach ($dir in $searchDirs) {
        $lnks = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
        foreach ($lnk in $lnks) {
            try {
                $sc = $wsh.CreateShortcut($lnk.FullName)
                $targetPath = [string]$sc.TargetPath
                if (-not $targetPath) { continue }
                $exeName = [System.IO.Path]::GetFileName($targetPath)
                if ($exeName -notmatch '^antigravity\.exe$') { continue }

                $origArgs = [string]$sc.Arguments
                if (-not $backupMap.ContainsKey($lnk.FullName)) {
                    $backupMap[$lnk.FullName] = $origArgs
                }

                $newArgs = $origArgs.Trim()
                if ($newArgs -notmatch '--remote-debugging-address=') {
                    $newArgs = ($newArgs + ' --remote-debugging-address=127.0.0.1').Trim()
                }
                if ($newArgs -notmatch '--remote-debugging-port=') {
                    $newArgs = ($newArgs + ' --remote-debugging-port=0').Trim()
                }

                if ($newArgs -ne $origArgs.Trim()) {
                    $sc.Arguments = $newArgs
                    $sc.Save()
                    Write-Host "[OK] Updated shortcut: $($lnk.FullName)" -ForegroundColor Green
                } else {
                    Write-Host "[OK] Shortcut already configured: $($lnk.FullName)" -ForegroundColor DarkGreen
                }
                $patchedCount++
            } catch {
                Write-Host "[WARN] Skipped shortcut (insufficient permissions or locked): $($lnk.FullName)" -ForegroundColor Yellow
            }
        }
    }

    if ($backupMap.Count -gt 0) {
        $backupJson = $backupMap | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($BackupFile, $backupJson, (New-Object System.Text.UTF8Encoding($false)))
    }

    if ($patchedCount -eq 0) {
        Write-Host "[INFO] No Antigravity.exe shortcut found automatically." -ForegroundColor Yellow
        Write-Host "       Please manually append the following to your Antigravity shortcut Target:" -ForegroundColor Yellow
        Write-Host "       $flags" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Fully quit Antigravity 2.0 and relaunch it from the updated shortcut."
Write-Host "  2. Open Antigravity Settings -> Plugins and ensure 'Antigravity Quota Capsule' is enabled."
Write-Host "  3. The quota capsule will appear between the Model Selector and Turbo button!"
