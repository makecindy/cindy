# Explicit Windows regression check. All registry objects are in-memory fakes;
# this never opens HKCU/HKLM or changes the developer's installed applications.
$ErrorActionPreference = 'Stop'
$env:CINDY_VERSION_SYNC_KEY = ''
$env:CINDY_VERSION_SYNC_EXE = ''
. (Join-Path $PSScriptRoot '../resources/windows-installation-version.ps1')

class VersionTestKey {
    [hashtable] $Values = @{}
    [hashtable] $Children = @{}
    [bool] $DenyWrite = $false
    [int] $Writes = 0
    [int] $Disposals = 0
    [object] GetValue([string] $name) { return $this.Values[$name] }
    [object] OpenSubKey([string] $name, [bool] $write) {
        $key = $this.Children[$name]
        if ($write -and $key.DenyWrite) { throw 'Access denied' }
        return $key
    }
    [void] SetValue([string] $name, [object] $value, [object] $kind) {
        if ($name -ne 'DisplayVersion') { throw 'Unexpected registry write' }
        if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Wrong value type' }
        $this.Values[$name] = $value
        $this.Writes++
    }
    [void] Dispose() { $this.Disposals++ }
}

$script:guid = '5a59f1e9-8f21-5646-8eed-e6da4126bb5c'
$script:installPath = 'Software\' + $script:guid
$script:uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $script:guid
$script:roots = @{}
$script:opened = 0
$openBase = { param($hive, $view)
    $script:opened++
    return $script:roots["$hive/$view"]
}

function Reset-Keys {
    $script:opened = 0
    $script:roots = @{}
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @('Registry64', 'Registry32')) {
            $root = [VersionTestKey]::new()
            $install = [VersionTestKey]::new()
            $install.Values.InstallLocation = 'C:\Apps\Cindy'
            $uninstall = [VersionTestKey]::new()
            $uninstall.Values = @{
                DisplayVersion = '0.1.79'
                UninstallString = '"C:\Apps\Cindy\Uninstall Cindy.exe" /currentuser'
                DisplayName = 'Cindy'
            }
            $root.Children[$script:installPath] = $install
            $root.Children[$script:uninstallPath] = $uninstall
            $script:roots["$hive/$view"] = $root
        }
    }
}

function Assert-Equal($actual, $expected, [string] $message) {
    if ($actual -cne $expected) { throw "$message (expected $expected, got $actual)" }
    $script:assertions++
}

function Invoke-Sync([string] $version = '0.1.80', [string] $key = $script:guid) {
    Sync-CindyInstallationVersion $key 'C:\Apps\Cindy\Cindy.exe' $version $openBase -WarningAction SilentlyContinue
}

$script:assertions = 0
Reset-Keys
Invoke-Sync
foreach ($root in $script:roots.Values) {
    $uninstall = $root.Children[$script:uninstallPath]
    Assert-Equal $uninstall.Values.DisplayVersion '0.1.80' 'Both scopes/views synchronize'
    Assert-Equal $uninstall.Values.UninstallString '"C:\Apps\Cindy\Uninstall Cindy.exe" /currentuser' 'Uninstall command unchanged'
    Assert-Equal $uninstall.Writes 1 'Only one metadata write'
    Assert-Equal $root.Disposals 1 'Base key closed'
}
Invoke-Sync
foreach ($root in $script:roots.Values) {
    Assert-Equal $root.Children[$script:uninstallPath].Writes 1 'Repeated repair is idempotent'
}

foreach ($version in @('', '0.0.0', '0.0.0-beta', '1.2', 'bad', '0x0x0', '1.2.3;evil')) {
    Reset-Keys
    Invoke-Sync $version
    Assert-Equal $script:opened 0 'Invalid/placeholder versions never open registry'
}
Reset-Keys
Invoke-Sync '0.1.80' '..\OtherApp'
Assert-Equal $script:opened 0 'Invalid identity never opens registry'

foreach ($scenario in @('other-directory', 'other-uninstaller', 'missing-install', 'missing-uninstall', 'empty-version', 'read-only', 'other-identity')) {
    Reset-Keys
    foreach ($root in $script:roots.Values) {
        switch ($scenario) {
            'other-directory' { $root.Children[$script:installPath].Values.InstallLocation = 'C:\Other\Cindy' }
            'other-uninstaller' { $root.Children[$script:uninstallPath].Values.UninstallString = '"C:\Other\Uninstall Cindy.exe" /currentuser' }
            'missing-install' { $root.Children.Remove($script:installPath) }
            'missing-uninstall' { $root.Children.Remove($script:uninstallPath) }
            'empty-version' { $root.Children[$script:uninstallPath].Values.DisplayVersion = '' }
            'read-only' { $root.Children[$script:uninstallPath].DenyWrite = $true }
            'other-identity' {
                $root.Children['Software\other-app'] = $root.Children[$script:installPath]
                $root.Children.Remove($script:installPath)
            }
        }
    }
    Invoke-Sync
    foreach ($root in $script:roots.Values) {
        if ($root.Children.ContainsKey($script:uninstallPath)) {
            Assert-Equal $root.Children[$script:uninstallPath].Writes 0 "No collateral changes: $scenario"
        } else {
            Assert-Equal $root.Children.ContainsKey($script:uninstallPath) $false 'Never creates uninstall entries'
        }
    }
}

Reset-Keys
foreach ($root in $script:roots.Values) {
    $root.Children[$script:installPath].Values.InstallLocation = 'c:\APPS\CINDY\'
}
Invoke-Sync '0.1.80-beta.2'
foreach ($root in $script:roots.Values) {
    Assert-Equal $root.Children[$script:uninstallPath].Values.DisplayVersion '0.1.80-beta.2' 'Windows path comparison and prerelease version'
}
Write-Output "PASS: $script:assertions Windows metadata assertions (in-memory registry only)."
