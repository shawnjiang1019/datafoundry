<#
.SYNOPSIS
  Start or stop the local stack (DataFoundry, D-Trail, optionally DataLink), one window each.

.EXAMPLE
  .\scripts\dev-stack.ps1                              # DataFoundry + D-Trail
  .\scripts\dev-stack.ps1 -DataLink biomedical         # + DataLink serving that domain's graph
  .\scripts\dev-stack.ps1 -DataLink biomedical -Reload # D-Trail restarts when its code changes
  .\scripts\dev-stack.ps1 -Stop                        # stop everything on the stack's ports
#>
param(
    [string]$DataLink,
    [switch]$Reload,
    [switch]$NoDtrail,
    [switch]$Stop,
    [string]$DtrailRoot = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "d-trail"),
    [string]$DtrailPython = $(if ($env:DTRAIL_PYTHON) { $env:DTRAIL_PYTHON } else { Join-Path $env:USERPROFILE "anaconda3\envs\dtrail\python.exe" }),
    [string]$KbRoot = $(if ($env:KB_ROOT) { $env:KB_ROOT } else { Join-Path $env:USERPROFILE "KramaBench" }),
    [int]$TimeoutSec = 180
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$ports = [ordered]@{ "DataFoundry API" = 8787; "DataFoundry web" = 3000; "D-Trail" = 8061; "DataLink" = 8080 }

function Get-Listener([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($Stop) {
    foreach ($name in $ports.Keys) {
        $listener = Get-Listener $ports[$name]
        if ($listener) {
            taskkill /PID $listener.OwningProcess /T /F | Out-Null
            "stopped $name (:$($ports[$name]), pid $($listener.OwningProcess))"
        }
    }
    return
}

function Start-InWindow([string]$Title, [string]$Dir, [string]$Command, [int]$Port) {
    if (Get-Listener $Port) { "$Title already running on :$Port, leaving it"; return }
    $script = "`$Host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$Dir'; $Command"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $script | Out-Null
    "started $Title"
}

function Wait-Ready([string]$Name, [scriptblock]$Check) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try { if (& $Check) { return "$Name OK" } } catch { }
        Start-Sleep -Seconds 2
    }
    "$Name NOT READY after ${TimeoutSec}s (check its window)"
}

$checks = [ordered]@{}

Start-InWindow "DataFoundry" $repo `
    "`$env:DATAFOUNDRY_SCHEMA_MAX_TABLES='200'; `$env:DATAFOUNDRY_MAX_RUN_TIMEOUT_MS='3600000'; npm run start" 8787
$checks["DataFoundry :8787"] = { (Invoke-WebRequest http://127.0.0.1:8787/ready -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }

if (-not $NoDtrail) {
    if (-not (Test-Path $DtrailPython)) { throw "D-Trail python not found: $DtrailPython (set -DtrailPython or DTRAIL_PYTHON)" }
    $reloadArgs = if ($Reload) { " --reload --reload-dir src" } else { "" }
    # Run from the repo root so D-Trail finds its .env.
    Start-InWindow "D-Trail" $DtrailRoot `
        "`$env:PYTHONPATH='src'; & '$DtrailPython' -m uvicorn dtrail_service.api:create_app --factory --host 127.0.0.1 --port 8061$reloadArgs" 8061
    $checks["D-Trail :8061"] = { (Invoke-RestMethod http://127.0.0.1:8061/healthz -TimeoutSec 5).status -eq "ok" }
}

if ($DataLink) {
    $graph = Join-Path $KbRoot "system_scratch\datalink_graphs\$DataLink.db"
    if (-not (Test-Path $graph)) { throw "DataLink graph not found: $graph (build it with datalink add-table)" }
    try { Invoke-WebRequest http://localhost:11434 -UseBasicParsing -TimeoutSec 3 | Out-Null }
    catch { "warning: Ollama is not answering on :11434; DataLink embeddings will fail" }
    Start-InWindow "DataLink ($DataLink)" (Join-Path $repo "services\datalink") `
        "uv run datalink serve --port 8080 --transport streamable-http --db '$graph'" 8080
    $checks["DataLink :8080 ($DataLink)"] = { [bool](Get-Listener 8080) }
}

foreach ($name in $checks.Keys) { Wait-Ready $name $checks[$name] }
