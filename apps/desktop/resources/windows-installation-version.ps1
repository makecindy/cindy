# Metadata-only repair after a successful ZIP update. Shared by the updater
# (which may already be elevated) and the first launch after an older updater.
# Never create an install record, request elevation, or change UninstallString.
function Sync-CindyInstallationVersion {
    [CmdletBinding()]
    param(
        [string] $InstallKey,
        [string] $ExePath,
        [string] $Version,
        [scriptblock] $OpenBaseKey = { param($hive, $view)
            [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        }
    )
    if ($InstallKey -notmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
        $Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' -or
        $Version -match '^0\.0\.0($|[-+])' -or
        -not [IO.Path]::IsPathRooted($ExePath)) { return }

    $appDir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ExePath)).TrimEnd('\')
    $uninstaller = Join-Path $appDir ('Uninstall ' + [IO.Path]::GetFileName($ExePath))
    $installPath = 'Software\' + $InstallKey
    $uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $InstallKey
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @('Registry64', 'Registry32')) {
            $base = $null; $install = $null; $uninstall = $null
            try {
                $base = & $OpenBaseKey $hive $view
                $install = $base.OpenSubKey($installPath, $false)
                if ($null -eq $install) { continue }
                $location = [string] $install.GetValue('InstallLocation')
                if (-not [IO.Path]::IsPathRooted($location) -or
                    -not [string]::Equals([IO.Path]::GetFullPath($location).TrimEnd('\'),
                        $appDir, [StringComparison]::OrdinalIgnoreCase)) { continue }

                $uninstall = $base.OpenSubKey($uninstallPath, $false)
                if ($null -eq $uninstall) { continue }
                $oldVersion = [string] $uninstall.GetValue('DisplayVersion')
                $command = [string] $uninstall.GetValue('UninstallString')
                # NSIS writes a quoted uninstaller followed by its scope switch.
                # Matching both keys prevents repairing another installation or
                # an orphaned/portable copy merely sharing an app identity.
                if ($command -notmatch '^"([^"]+)"(?:\s|$)' -or
                    -not [string]::Equals($Matches[1], $uninstaller, [StringComparison]::OrdinalIgnoreCase) -or
                    [string]::IsNullOrEmpty($oldVersion) -or $oldVersion -eq $Version) { continue }
                $uninstall.Dispose()
                $uninstall = $base.OpenSubKey($uninstallPath, $true)
                if ($null -ne $uninstall -and
                    $uninstall.GetValue('UninstallString') -eq $command -and
                    $uninstall.GetValue('DisplayVersion') -eq $oldVersion -and
                    $install.GetValue('InstallLocation') -eq $location) {
                    $uninstall.SetValue('DisplayVersion', $Version, [Microsoft.Win32.RegistryValueKind]::String)
                }
            } catch {
                # HKLM may be read-only to the app. The already-elevated updater
                # can repair it; this metadata must never trigger another UAC.
                Write-Warning 'Cindy installation version metadata could not be synchronized.'
            } finally {
                if ($null -ne $uninstall) { $uninstall.Dispose() }
                if ($null -ne $install) { $install.Dispose() }
                if ($null -ne $base) { $base.Dispose() }
            }
        }
    }
}

if ($env:CINDY_VERSION_SYNC_KEY -and $env:CINDY_VERSION_SYNC_EXE) {
    try {
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:CINDY_VERSION_SYNC_EXE).ProductVersion
        # A running old process must not publish its version for a newer exe.
        if (-not $env:CINDY_VERSION_SYNC_EXPECTED -or $env:CINDY_VERSION_SYNC_EXPECTED -eq $version) {
            $syncWarnings = @()
            Sync-CindyInstallationVersion $env:CINDY_VERSION_SYNC_KEY $env:CINDY_VERSION_SYNC_EXE $version -WarningVariable syncWarnings -WarningAction SilentlyContinue
            if ($syncWarnings.Count -gt 0) { exit 1 }
        }
    } catch {
        Write-Warning 'Cindy executable version could not be read.'
        exit 1
    }
}
