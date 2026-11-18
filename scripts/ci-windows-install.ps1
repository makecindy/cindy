# Windows unit shards use this wrapper before tests so an eventual job timeout
# cannot discard an already uploaded install report. Keep arbitrary output in
# the normal job log; the artifact contains only the fields selected below.
param(
    [Parameter(Mandatory)][string]$ReportPath,
    [ValidateRange(0, 86400)][int]$SlowSeconds = 120
)

$events = [Collections.Generic.List[object]]::new()
$timer = [Diagnostics.Stopwatch]::new()
$startedAt = [DateTime]::UtcNow
$omitted = 0
$packagePattern = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+'
$packages = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
try {
    foreach ($line in [IO.File]::ReadLines((Join-Path $PWD 'pnpm-lock.yaml'))) {
        if ($line -cmatch "^  '?($packagePattern)@") { [void]$packages.Add($Matches[1]) }
    }
} catch {
    Write-Warning 'Package names unavailable for install diagnostics.'
}

function Get-InstallEvent([string]$line) {
    if ($line -match '^Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)') {
        return @{ event = 'progress'; resolved = [long]$Matches[1]; reused = [long]$Matches[2]; downloaded = [long]$Matches[3]; added = [long]$Matches[4] }
    }
    if ($line -match '^[^\w]*Verifying lockfile against supply-chain policies') { return @{ event = 'verification-start' } }
    if ($line -match '^[^\w]*Lockfile passes supply-chain policies \((verified|[0-9])') {
        return @{ event = 'verification-passed'; cached = $Matches[1] -eq 'verified' }
    }
    if ($line -match '^(?<path>\.|(?:node_modules/\S+)) (?<stage>preinstall|install|postinstall|prepare)(?<status>\$|: Done$|: Failed\b)') {
        $stage = $Matches.stage
        $status = switch ($Matches.status.Trim()) { '$' { 'start' } ': Done' { 'done' } default { 'failed' } }
        $name = ($Matches.path -split 'node_modules/')[-1]
        if ($name -eq '.') { $name = '(workspace root)' }
        elseif (!$packages.Contains($name)) { $name = '(other)' }
        return @{ event = 'lifecycle'; package = $name; stage = $stage; status = $status }
    }

    if ($line -notmatch '^\[WARN\] ') { return }
    $result = if ($line -match 'Request took (\d+)ms:') {
        @{ event = 'slow-request'; durationMs = [long]$Matches[1] }
    } elseif ($line -match 'Will retry in (\d+) (second|minute)') {
        $delay = [long]$Matches[1]
        if ($Matches[2] -eq 'minute') { $delay *= 60 }
        @{ event = 'request-retry'; delaySeconds = $delay }
    } elseif ($line -match 'Tarball download average speed') {
        @{ event = 'slow-download' }
    } else { return }

    # Only identify packages already named in the public lockfile. Never copy a
    # URL, query string, package script command or registry response into JSON.
    if ($line -match 'https://registry\.npmjs\.org/([^\s?#]+)') {
        $path = $Matches[1].Replace('%2F', '/').Replace('%2f', '/')
        $name = ($path -split '/-/')[0]
        if ($packages.Contains($name)) { $result.package = $name }
    }
    return $result
}

$drive = (Get-Item .).PSDrive.Name + ':'
$sampleResources = {
    param($drive)
    $paths = @('\Processor(_Total)\% Processor Time', "\LogicalDisk($drive)\Avg. Disk sec/Read", "\LogicalDisk($drive)\Avg. Disk sec/Write")
    Get-Counter -Counter $paths -SampleInterval 10 -Continuous -ErrorAction Stop | ForEach-Object {
        $sample = @{ atUtc = $_.Timestamp.ToUniversalTime().ToString('o') }
        foreach ($counter in $_.CounterSamples) {
            if ($counter.Status -notin 0, 1) { continue }
            switch -Wildcard ($counter.Path) {
                '*\% Processor Time' { $sample.cpuPercent = [math]::Round($counter.CookedValue, 2) }
                '*\Avg. Disk sec/Read' { $sample.diskReadMs = [math]::Round(1000 * $counter.CookedValue, 2) }
                '*\Avg. Disk sec/Write' { $sample.diskWriteMs = [math]::Round(1000 * $counter.CookedValue, 2) }
            }
        }
        $sample
    }
}
try { $sampler = Start-ThreadJob -ArgumentList $drive -ScriptBlock $sampleResources -ErrorAction Stop }
catch { $sampler = $null }

$exitCode = 1
$PSNativeCommandUseErrorActionPreference = $false
$timer.Start()
try {
    pnpm install --frozen-lockfile --reporter=append-only 2>&1 | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        try { $event = Get-InstallEvent ($line -replace '\x1b\[[0-9;]*m', '') }
        catch { $omitted++; return }
        if ($null -ne $event) {
            if ($events.Count -lt 4096) {
                $event.elapsedMs = $timer.ElapsedMilliseconds
                $events.Add($event)
            } else { $omitted++ }
        }
    }
    $exitCode = $LASTEXITCODE
} finally {
    $timer.Stop()
    $samples = @()
    if ($sampler) {
        Stop-Job $sampler -ErrorAction SilentlyContinue
        $samples = @(Receive-Job $sampler -ErrorAction SilentlyContinue)
        Remove-Job $sampler -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0 -or $timer.Elapsed.TotalSeconds -ge $SlowSeconds) {
        try {
            $cache = switch ($env:PNPM_STORE_CACHE_HIT) { 'true' { 'hit' } 'false' { 'miss' } default { 'unknown' } }
            $report = [ordered]@{
                startedAtUtc = $startedAt.ToString('o'); durationMs = $timer.ElapsedMilliseconds
                exitCode = $exitCode; storeCache = $cache; events = $events
                omittedEvents = $omitted; resourceSamples = $samples
            }
            $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8 -ErrorAction Stop
            if ($env:GITHUB_OUTPUT) { 'report=true' >> $env:GITHUB_OUTPUT }
        } catch { Write-Warning 'Could not save the pnpm install diagnostics.' }
    }
}
exit $exitCode
