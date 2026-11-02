param([Parameter(Mandatory)][string]$LogPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$taskExit = 1
try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    Set-Location -LiteralPath $repoRoot
    $env:TONGJIA_PROFILE = Join-Path $repoRoot '.browser-profile'
    & node (Join-Path $PSScriptRoot 'collect.js') --headed 2>&1 |
        Out-File -LiteralPath $LogPath -Encoding utf8
    $taskExit = $LASTEXITCODE
} catch {
    ('[ERROR] ' + $_.Exception.Message) | Out-File -LiteralPath $LogPath -Encoding utf8 -Append
} finally {
    exit $taskExit
}
