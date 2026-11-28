# Release source: @SOURCE@
$ErrorActionPreference = 'Stop'
$previousBase = $env:CUA_DRIVER_RS_DOWNLOAD_BASE_URL
$previousVersion = $env:CUA_DRIVER_RS_VERSION
$version = if ($previousVersion) { $previousVersion } else { '@VERSION@' }
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Cua Driver version' }
$dir = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $dir
try {
    $env:CUA_DRIVER_RS_DOWNLOAD_BASE_URL = '@BASE@/releases/download'
    $env:CUA_DRIVER_RS_VERSION = $version
    $base = "$env:CUA_DRIVER_RS_DOWNLOAD_BASE_URL/cua-driver-rs-v$version"
    foreach ($file in 'install.ps1', '_install-common.psm1') {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $dir $file)
    }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'install.ps1') @args
    if ($LASTEXITCODE -ne 0) { throw "Cua Driver installer exited with $LASTEXITCODE" }
} finally {
    $env:CUA_DRIVER_RS_DOWNLOAD_BASE_URL = $previousBase
    $env:CUA_DRIVER_RS_VERSION = $previousVersion
    Remove-Item -LiteralPath $dir -Recurse -Force
}
