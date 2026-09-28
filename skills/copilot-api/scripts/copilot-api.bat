@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$url = 'http://127.0.0.1:4821/v1/models';" ^
  "try { $models = Invoke-RestMethod $url -TimeoutSec 2 } catch [System.Net.WebException] { $models = $null };" ^
  "if ($models.data.Count -gt 0) { Write-Host 'copilot-api is already running on port 4821.'; exit 0 };" ^
  "$logDir = Join-Path $env:LOCALAPPDATA 'copilot-api';" ^
  "New-Item -ItemType Directory -Path $logDir -Force | Out-Null;" ^
  "$out = Join-Path $logDir 'startup.log'; $err = Join-Path $logDir 'startup-error.log';" ^
  "Write-Host ('Logs: ' + $logDir);" ^
  "$process = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c copilot-api start --port 4821' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru;" ^
  "for ($i = 0; $i -lt 30; $i++) {" ^
  "  Start-Sleep -Seconds 1;" ^
  "  if ($process.HasExited) { throw ('copilot-api exited. See ' + $err) };" ^
  "  try { $models = Invoke-RestMethod $url -TimeoutSec 2 } catch [System.Net.WebException] { continue };" ^
  "  if ($models.data.Count -gt 0) { Write-Host 'copilot-api is ready at http://127.0.0.1:4821'; exit 0 };" ^
  "};" ^
  "throw ('Startup not confirmed. See ' + $out + ' and ' + $err + '; complete copilot-api auth login first.')"
if errorlevel 1 echo Failed to confirm copilot-api startup. Check the logs above.
pause
