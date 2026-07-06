$ErrorActionPreference = 'Stop'

$pidFile = Join-Path $PSScriptRoot 'mosquitto-penpito.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "Penpito MQTT broker PID file not found. Nothing to stop."
  exit 0
}

$brokerPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $brokerPid -ErrorAction SilentlyContinue

if ($process) {
  Stop-Process -Id $brokerPid
  Write-Host "Stopped Penpito MQTT broker. PID=$brokerPid"
} else {
  Write-Host "Penpito MQTT broker was not running. PID=$brokerPid"
}

Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
