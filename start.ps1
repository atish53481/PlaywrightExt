# One-click start for the whole stack: Docker + PostgreSQL, migrations, the
# platform API, the web app, and the Bridge. Safe to run again: anything already
# listening on its port is left alone. Run Start.bat to launch this by double-click.

param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$platform = Join-Path $root 'PlaywrightPlatform'
$bridge = Join-Path $root 'PlaywrightBridge'
$dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   $text" -ForegroundColor Green }
function Fail($text) { Write-Host "`n   FAILED: $text" -ForegroundColor Red; exit 1 }

function Listening($port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function DockerReady {
  cmd /c 'docker info >nul 2>&1'
  $LASTEXITCODE -eq 0
}

function WaitFor($what, $seconds, [scriptblock]$test) {
  for ($i = 0; $i -lt $seconds; $i += 2) {
    if (& $test) { return }
    Start-Sleep -Seconds 2
  }
  Fail "$what did not come up within $seconds seconds."
}

# Each service gets its own window so its log stays visible; closing the window stops it.
function StartWindow($title, $dir, $command) {
  Start-Process cmd -ArgumentList '/k', "title $title && $command" -WorkingDirectory $dir
}

function EnvValue($name, $default) {
  $line = Get-Content (Join-Path $platform '.env') | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { ($line -split '=', 2)[1].Trim() } else { $default }
}

if (-not (Test-Path (Join-Path $platform '.env'))) {
  Fail 'PlaywrightPlatform\.env is missing. Copy .env.example to .env and fill it in (see PlaywrightPlatform\README.md).'
}
$appPort = [int](EnvValue 'APP_PORT' '3000')
$webPort = 5173
$bridgePort = 8787

Step 'Docker'
if (DockerReady) {
  Ok 'already running'
} else {
  if (-not (Test-Path $dockerDesktop)) { Fail "Docker Desktop not found at $dockerDesktop." }
  Write-Host '   starting Docker Desktop (can take a minute or two)...'
  Start-Process $dockerDesktop
  WaitFor 'Docker' 240 { DockerReady }
  Ok 'started'
}

Step 'PostgreSQL'
Push-Location $platform
try {
  docker compose up -d --wait postgres
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose could not start postgres.' }
  Ok 'healthy'

  Step 'Database migrations'
  npm run db:migrate
  if ($LASTEXITCODE -ne 0) { Fail 'npm run db:migrate failed.' }
  Ok 'up to date'
} finally {
  Pop-Location
}

Step "Platform API (port $appPort)"
if (Listening $appPort) { Ok 'already running' } else {
  StartWindow 'Platform API' $platform 'npm run dev:server'
  WaitFor 'The platform API' 60 { Listening $appPort }
  Ok 'started'
}

Step "Web app (port $webPort)"
if (Listening $webPort) { Ok 'already running' } else {
  StartWindow 'Platform Web' $platform 'npm run dev:web'
  WaitFor 'The web app' 60 { Listening $webPort }
  Ok 'started'
}

Step "Bridge (port $bridgePort)"
if (Listening $bridgePort) { Ok 'already running' } else {
  StartWindow 'Playwright Bridge' $bridge 'npm start'
  WaitFor 'The Bridge' 30 { Listening $bridgePort }
  Ok 'started'
}

Step 'Jenkins'
$jenkins = Get-Service Jenkins -ErrorAction SilentlyContinue
if (-not $jenkins) {
  Write-Host '   no Jenkins service on this machine (only needed for Run on Jenkins)' -ForegroundColor Yellow
} elseif ($jenkins.Status -eq 'Running') {
  Ok 'service running'
} else {
  Write-Host '   service is stopped. Start it from an administrator prompt: Start-Service Jenkins' -ForegroundColor Yellow
}

Write-Host "`nAll up." -ForegroundColor Green
Write-Host "   Web app : http://localhost:$webPort"
Write-Host "   API     : http://127.0.0.1:$appPort"
Write-Host "   Bridge  : ws://127.0.0.1:$bridgePort"
Write-Host '   Stop    : close the three service windows (PostgreSQL keeps running in Docker)'

if (-not $NoBrowser) { Start-Process "http://localhost:$webPort" }
