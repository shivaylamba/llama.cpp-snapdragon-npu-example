param(
    [string] $Model = "qwen2.5-0.5b-instruct-q4_0.gguf",
    [string] $Device = "HTP0",
    [int] $Port = 8080,
    [string] $HostName = "127.0.0.1",
    [int] $GpuLayers = 99,
    [int] $CtxSize = 1024,
    [int] $UBatchSize = 128,
    [switch] $VerboseHexagon,
    [switch] $OpenBrowser
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgBin = Join-Path $Root "pkg-snapdragon\bin"
$PkgLib = Join-Path $Root "pkg-snapdragon\lib"
$Server = Join-Path $PkgBin "llama-server.exe"
$UiDir = Join-Path $Root "npu-chat"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "npu-chat-server.out.log"
$ErrLog = Join-Path $LogDir "npu-chat-server.err.log"

if (-not (Test-Path $Server)) {
    throw "Missing llama-server.exe at $Server. Build or install pkg-snapdragon first."
}

if (-not (Test-Path $UiDir)) {
    throw "Missing chat frontend at $UiDir."
}

$ModelPath = if ([System.IO.Path]::IsPathRooted($Model)) {
    $Model
} else {
    Join-Path (Join-Path $Root "gguf") $Model
}

if (-not (Test-Path $ModelPath)) {
    throw "Missing model file: $ModelPath"
}

New-Item -ItemType Directory -Force $LogDir | Out-Null
Remove-Item -Force $OutLog, $ErrLog -ErrorAction SilentlyContinue

$env:Path = "$PkgBin;$env:Path"
$env:ADSP_LIBRARY_PATH = $PkgLib

if ($VerboseHexagon) {
    $env:GGML_HEXAGON_VERBOSE = "1"
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    throw "Port $Port is already in use. Run with -Port 8081 or stop the existing listener."
}

$args = @(
    "-m", $ModelPath,
    "-a", "snapdragon-npu",
    "--host", $HostName,
    "--port", "$Port",
    "--path", $UiDir,
    "--no-mmap",
    "--poll", "1000",
    "-t", "6",
    "--ctx-size", "$CtxSize",
    "--ubatch-size", "$UBatchSize",
    "-fa", "on",
    "-ngl", "$GpuLayers",
    "--device", $Device
)

$process = Start-Process -FilePath $Server `
    -ArgumentList $args `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru

$url = "http://$HostName`:$Port/"
Write-Host "Started llama-server PID $($process.Id)"
Write-Host "Chat UI: $url"
Write-Host "NPU target: $Device with -ngl $GpuLayers"
Write-Host "Logs:"
Write-Host "  $OutLog"
Write-Host "  $ErrLog"

for ($i = 0; $i -lt 60; $i++) {
    if ($process.HasExited) {
        throw "llama-server exited early. See $OutLog and $ErrLog"
    }

    try {
        $health = Invoke-RestMethod -Uri "http://$HostName`:$Port/health" -TimeoutSec 2
        Write-Host "Health: $($health.status)"
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($OpenBrowser) {
    Start-Process $url
}
