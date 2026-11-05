# 换网测试用：到点禁用有线网卡，过 Hold 秒再启用。只用于这次真机测试。
param([long]$At, [int]$Hold, [int]$Index, [string]$Log)
function Note($text) { Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $text) }
Note "elevated, waiting"
while ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -lt $At) { Start-Sleep -Milliseconds 100 }
$adapter = Get-NetAdapter -InterfaceIndex $Index
try {
    Note ("disable " + $adapter.InterfaceDescription)
    Disable-NetAdapter -InputObject $adapter -Confirm:$false
    Note "disabled"
    Start-Sleep -Seconds $Hold
} finally {
    for ($try = 0; $try -lt 5; $try++) {
        try { Enable-NetAdapter -InputObject (Get-NetAdapter -InterfaceIndex $Index) -Confirm:$false; Note "enabled"; break }
        catch { Note ("enable failed: " + $_); Start-Sleep -Seconds 2 }
    }
}
