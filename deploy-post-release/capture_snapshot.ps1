param(
  [string]$ProjectDir = "D:\OpenClaw\Develop\openclaw",
  [string]$DeployDir = "D:\OpenClaw\deploy",
  [string]$BaseDir = "D:\OpenClaw\Develop\openclaw\deploy-post-release"
)

$ErrorActionPreference = "Stop"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$isoNow = Get-Date -Format "o"
$logsDir = Join-Path $BaseDir "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$branch = "N/A"
$commit = "N/A"
try {
  if (Test-Path (Join-Path $ProjectDir ".git")) {
    $branch = (git -C $ProjectDir rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
    $commit = (git -C $ProjectDir rev-parse --short HEAD 2>$null | Out-String).Trim()
    if (-not $branch) { $branch = "N/A" }
    if (-not $commit) { $commit = "N/A" }
  }
} catch {
}

$nodeVersion = "N/A"
try {
  $nodeCmd = Get-Command node -ErrorAction Stop
  $nodeOut = & $nodeCmd.Source --version 2>$null
  if ($LASTEXITCODE -eq 0) { $nodeVersion = (($nodeOut | Out-String).Trim()) }
} catch {
}

$pnpmVersion = "N/A"
try {
  $pnpmCmd = Get-Command pnpm -ErrorAction Stop
  $pnpmOut = & $pnpmCmd.Source --version 2>$null
  if ($LASTEXITCODE -eq 0) { $pnpmVersion = (($pnpmOut | Out-String).Trim()) }
} catch {
}
$pwshVersion = $PSVersionTable.PSVersion.ToString()

$required = @(
  @{ Name = "deploy_menu.bat"; Path = (Join-Path $ProjectDir "deploy_menu.bat") },
  @{ Name = "config.runtime.json"; Path = (Join-Path $DeployDir "config.runtime.json") },
  @{ Name = "gateway.log"; Path = (Join-Path $DeployDir "gateway.log") },
  @{ Name = "verify_post_release.ps1"; Path = (Join-Path $BaseDir "verify_post_release.ps1") },
  @{ Name = "00_post_release_menu.bat"; Path = (Join-Path $BaseDir "00_post_release_menu.bat") },
  @{ Name = "03_publish_restart_verify.bat"; Path = (Join-Path $BaseDir "03_publish_restart_verify.bat") }
)

$checks = @()
foreach ($item in $required) {
  $exists = Test-Path $item.Path
  $size = if ($exists) { (Get-Item $item.Path).Length } else { 0 }
  $checks += [pscustomobject]@{
    name = $item.Name
    path = $item.Path
    exists = $exists
    sizeBytes = $size
  }
}

$data = [pscustomobject]@{
  capturedAt = $isoNow
  machine = $env:COMPUTERNAME
  user = $env:USERNAME
  projectDir = $ProjectDir
  deployDir = $DeployDir
  baseDir = $BaseDir
  git = [pscustomobject]@{
    branch = $branch
    commit = $commit
  }
  runtime = [pscustomobject]@{
    powershell = $pwshVersion
    node = $nodeVersion
    pnpm = $pnpmVersion
  }
  files = $checks
}

$outFile = Join-Path $logsDir ("snapshot-" + $timestamp + ".json")
$data | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding UTF8
Write-Host "[PASS] Snapshot saved: $outFile" -ForegroundColor Green
exit 0
