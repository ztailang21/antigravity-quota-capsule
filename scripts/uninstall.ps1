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

# 1. Restore Windows shortcuts cleanly
$wsh = New-Object -ComObject WScript.Shell
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
                    Write-Host "[OK] Restored shortcut: $lnkPath" -ForegroundColor Green
                } catch {
                    Write-Host "[WARN] Could not restore shortcut: $lnkPath" -ForegroundColor Yellow
                }
            }
        }
    } catch {
        Write-Host "[WARN] Failed reading shortcut backup file." -ForegroundColor Yellow
    }
}

# 2. Remove installed plugin directory
if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[OK] Removed plugin directory: $TargetDir" -ForegroundColor Green
} else {
    Write-Host "[INFO] Plugin directory was already removed." -ForegroundColor Gray
}

# 3. Optionally purge cached config/quota state
if ($PurgeData -and (Test-Path $DataDir)) {
    Remove-Item -Recurse -Force $DataDir
    Write-Host "[OK] Purged data directory: $DataDir" -ForegroundColor Green
}

Write-Host "Uninstall complete. Restart Antigravity 2.0 to finish cleanup." -ForegroundColor Cyan
