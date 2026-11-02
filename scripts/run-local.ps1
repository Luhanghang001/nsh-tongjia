$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$mutex = [System.Threading.Mutex]::new($false, 'Local\NSH_TongjiaPriceFetch')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
$taskExit = 1
$transcriptStarted = $false
try {
    Set-Location -LiteralPath $repoRoot
    $logDir = Join-Path $repoRoot 'logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Start-Transcript -Path (Join-Path $logDir ((Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')) | Out-Null
    $transcriptStarted = $true
    $branch = (& git branch --show-current).Trim()
    if ($branch -ne 'main') { throw '本机定时采集只允许在 main 分支运行。' }
    $dirty = & git status --porcelain
    if ($dirty) { throw '仓库有未提交改动，停止以保护现有文件。' }
    & git pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw '同步 main 失败，未运行采集。' }
    . (Join-Path $PSScriptRoot 'isolated-desktop.ps1')
    $workerLog = Join-Path $logDir ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-collector.log')
    $taskExit = Invoke-TongjiaIsolatedDesktop -LogPath $workerLog
    if (Test-Path -LiteralPath $workerLog) { Get-Content -LiteralPath $workerLog | Write-Output }
    & git add -- data/tongjia.csv data/status.json
    if ($LASTEXITCODE -ne 0) { throw '暂存采集结果失败。' }
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
        & git -c user.name=tongjia-local -c user.email=tongjia-local@users.noreply.github.com commit -m ('本机更新铜价 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm zzz'))
        if ($LASTEXITCODE -ne 0) { throw '提交采集结果失败，文件保留在本机。' }
    }
    & git push origin main
    if ($LASTEXITCODE -ne 0) { throw '上传失败，本机数据和提交均已保留。' }
} catch {
    Write-Output ('[ERROR] ' + $_.Exception.Message)
    $taskExit = 1
} finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
exit $taskExit
