param([long]$WindowHandle, [int]$ExpectedProcessId, [int]$Seconds)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
if ($root.Current.ProcessId -ne $ExpectedProcessId) { throw 'Unexpected fixture window owner' }
$clock = [Diagnostics.Stopwatch]::StartNew()
$queries = 0; $ranges = 0; $errors = 0; $iterations = 0; $lastError = ''
while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
  try {
    # Search only the fixture HWND, never the desktop or another application.
    $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true))
    for ($i = 0; $i -lt [Math]::Min(8, $nodes.Count); $i++) {
      $pattern = $nodes[$i].GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $range = $pattern.DocumentRange
      $null = $range.GetText(1024)
      $queries++
      $range.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
      $null = $range.GetBoundingRectangles()
      $null = $range.Move([System.Windows.Automation.Text.TextUnit]::Line, 1)
      $ranges++
    }
  } catch { $errors++; $lastError = $_.Exception.Message }
  $iterations++
  if ($iterations % 20 -eq 0) {
    @{ queries=$queries; ranges=$ranges; errors=$errors; lastError=$lastError; elapsedMs=$clock.ElapsedMilliseconds } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 30
}
@{ queries=$queries; ranges=$ranges; errors=$errors; lastError=$lastError; elapsedMs=$clock.ElapsedMilliseconds } | ConvertTo-Json -Compress
