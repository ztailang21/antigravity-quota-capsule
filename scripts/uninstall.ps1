#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

$PluginName = 'antigravity-quota-capsule'
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\$PluginName"
$DataDir = Join-Path $env:APPDATA 'AntigravityQuotaCapsule'
$BackupFile = Join-Path $DataDir 'shortcut_backup.json'

Write-Host "=== Antigravity Quota Capsule (Windows Uninstaller) ===" -ForegroundColor Cyan

# 1. Restore Windows shortcuts from backup, plus regex-clean any remaining shortcuts if backup is absent
$wsh = New-Object -ComObject WScript.Shell
$restoredPaths = @{}

if (Test-Path $BackupFile) {
    try {
        $backup = Get-Content -Path $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($prop in $backup.PSObject.Properties) {
            $lnkPath = $prop.Name
            $origArgs = [string]$prop.Value
            if (Test-Path $lnkPath) {
                try {
                    $sc = $wsh.CreateShortcut($lnkPath)
                    $sc.Arguments = $origArgs
                    $sc.Save()
                    $restoredPaths[$lnkPath] = $true
                    Write-Host "[OK] Restored shortcut from backup: $lnkPath" -ForegroundColor Green
                } catch {
                    Write-Host "[WARN] Could not restore shortcut: $lnkPath" -ForegroundColor Yellow
                }
            }
        }
    } catch {
        Write-Host "[WARN] Failed reading shortcut backup file; falling back to flag stripping." -ForegroundColor Yellow
    }
}

$searchDirs = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

foreach ($dir in $searchDirs) {
    $lnks = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
    foreach ($lnk in $lnks) {
        if ($restoredPaths.ContainsKey($lnk.FullName)) { continue }
        try {
            $sc = $wsh.CreateShortcut($lnk.FullName)
            if ([System.IO.Path]::GetFileName([string]$sc.TargetPath) -notmatch '^antigravity\.exe$') { continue }
            $curArgs = [string]$sc.Arguments
            $cleaned = ($curArgs -replace '--remote-debugging-address=127\.0\.0\.1', '' -replace '--remote-debugging-port=0', '' -replace '\s+', ' ').Trim()
            if ($cleaned -ne $curArgs.Trim()) {
                $sc.Arguments = $cleaned
                $sc.Save()
                Write-Host "[OK] Stripped debug flags from shortcut: $($lnk.FullName)" -ForegroundColor Green
            }
        } catch {
        }
    }
}

# 2. Remove installed plugin directory gracefully (even if sidecar is currently running)
if (Test-Path $TargetDir) {
    # Remove manifests first so Antigravity stops the running sidecar cleanly
    foreach ($manifest in @((Join-Path $TargetDir 'plugin.json'), (Join-Path $TargetDir 'sidecars\quota-capsule\sidecar.json'))) {
        if (Test-Path $manifest) {
            Remove-Item -Force $manifest -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 700

    $removed = $false
    for ($i = 0; $i -lt 4; $i++) {
        try {
            Remove-Item -Recurse -Force $TargetDir -ErrorAction Stop
            $removed = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if ($removed) {
        Write-Host "[OK] Removed plugin directory: $TargetDir" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Plugin manifests removed; remaining locked files will clear once Antigravity closes." -ForegroundColor Yellow
    }
} else {
    Write-Host "[INFO] Plugin directory was already removed." -ForegroundColor Gray
}

# 3. Optionally purge cached config/quota state
if ($PurgeData -and (Test-Path $DataDir)) {
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    Write-Host "[OK] Purged data directory: $DataDir" -ForegroundColor Green
}

Write-Host "Uninstall complete. Restart Antigravity 2.0 to finish cleanup." -ForegroundColor Cyan
