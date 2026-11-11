param(
  [ValidateSet('claude', 'codex', 'all')][string]$Backend = 'all',
  [switch]$SkipInstall,
  [switch]$SkipBundle
)
$ErrorActionPreference = 'Stop'
$appDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $appDir '..\..')).Path
function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "MISSING_DEPENDENCY: $Name. $Hint" }
  Write-Host "PASS $Name"
}
Require-Command node 'Install Node.js 22.'
Require-Command pnpm 'Enable Corepack or install pnpm.'
if (Get-Command docker -ErrorAction SilentlyContinue) { Write-Host 'PASS docker' } else { Write-Warning 'Docker is required only for Harbor smoke tests.' }
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'MISSING_DEPENDENCY: Node.js 22 or newer is required' }
if (-not $SkipInstall) { & pnpm install --frozen-lockfile; if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' } }
& npm --prefix $appDir run ensure:binaries
if ($LASTEXITCODE -ne 0) { throw 'Agent binary preparation failed' }
if (-not $SkipBundle) {
  & npm --prefix $appDir run typecheck
  & npm --prefix $appDir test -- --run
  & npm --prefix $appDir run bundle:linux
  & npm --prefix $appDir run verify:bundle
  if ($LASTEXITCODE -ne 0) { throw 'Headless bundle verification failed' }
}
$config = Join-Path $appDir 'config.local.json'
if (-not (Test-Path -LiteralPath $config) -and -not $env:CINDY_HEADLESS_API_KEY) {
  Write-Warning 'Gateway config is not set. Set CINDY_HEADLESS_API_KEY through your environment before a live smoke test.'
}
Write-Host "READY Cindy Headless ($Backend)"
