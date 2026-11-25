#requires -Version 5.1
# Unicode-safe Windows launcher for Antigravity Quota Capsule sidecar (v1.1.0).
# Bypasses cmd.exe / agy-node.cmd CP936 encoding issues on non-ASCII Windows usernames (e.g. C:\Users\中文\).

$ErrorActionPreference = 'Stop'
$SidecarDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerScript = Join-Path $SidecarDir 'server.mjs'

# 1. Prefer system node.exe if available
$nodeCmd = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if ($nodeCmd -and (Test-Path $nodeCmd.Source)) {
    & $nodeCmd.Source $ServerScript
    exit $LASTEXITCODE
}

# 2. Fallback to Antigravity's bundled Electron runtime in Node mode (checks standard paths + parent process path)
$candidates = New-Object System.Collections.Generic.List[string]
try {
    $selfProc = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
    if ($selfProc -and $selfProc.ParentProcessId) {
        $parent = Get-Process -Id $selfProc.ParentProcessId -ErrorAction SilentlyContinue
        if ($parent -and $parent.Path -and (Test-Path $parent.Path)) {
            $parentDir = Split-Path -Parent $parent.Path
            $candidates.Add((Join-Path $parentDir 'Antigravity.exe'))
            if ($parent.ProcessName -match '^Antigravity$') {
                $candidates.Add($parent.Path)
            }
        }
    }
} catch {
}

$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'))
$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Google Antigravity\Antigravity.exe'))
$candidates.Add((Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe'))

foreach ($exe in ($candidates | Select-Object -Unique)) {
    if ($exe -and (Test-Path $exe)) {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $exe $ServerScript
        exit $LASTEXITCODE
    }
}

Write-Error 'Could not locate node.exe or Antigravity.exe to launch quota-capsule sidecar.'
exit 1
