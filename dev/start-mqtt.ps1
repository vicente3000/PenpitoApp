$ErrorActionPreference = 'Stop'

$mosquitto = 'C:\Program Files\Mosquitto\mosquitto.exe'
$config = Join-Path $PSScriptRoot 'mosquitto-penpito.conf'
$pidFile = Join-Path $PSScriptRoot 'mosquitto-penpito.pid'
$stdout = Join-Path $PSScriptRoot 'mosquitto-penpito.log'
$stderr = Join-Path $PSScriptRoot 'mosquitto-penpito.err.log'

if (-not (Test-Path -LiteralPath $mosquitto)) {
  throw "Mosquitto is not installed at $mosquitto"
}

if (-not (Test-Path -LiteralPath $config)) {
  throw "Missing config file: $config"
}

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Penpito MQTT broker already running. PID=$existingPid"
    exit 0
  }
}

Remove-Item -LiteralPath $stdout, $stderr -ErrorAction SilentlyContinue

$resolvedConfig = (Resolve-Path -LiteralPath $config).Path
$arguments = '-c "' + $resolvedConfig + '"'
$process = Start-Process `
  -FilePath $mosquitto `
  -ArgumentList $arguments `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

Start-Sleep -Seconds 2

$running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
if (-not $running) {
  $errorLog = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
  throw "Mosquitto exited during startup. $errorLog"
}

$process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
Write-Host "Penpito MQTT broker running. PID=$($process.Id)"
Write-Host "TCP:       mqtt://192.168.243.219:1883"
Write-Host "WebSocket: ws://192.168.243.219:9001"
