#requires -Version 5.1
# Unicode-safe Windows launcher for Antigravity Quota Capsule sidecar.
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

# 2. Fallback to Antigravity's bundled Electron runtime in Node mode (zero external Node.js needed)
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Google Antigravity\Antigravity.exe'),
    (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe')
)

foreach ($exe in $candidates) {
    if ($exe -and (Test-Path $exe)) {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $exe $ServerScript
        exit $LASTEXITCODE
    }
}

Write-Error 'Could not locate node.exe or Antigravity.exe to launch quota-capsule sidecar.'
exit 1
