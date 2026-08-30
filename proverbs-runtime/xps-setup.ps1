# ============================================================
# Proverbs XPS Setup — Run this on the Dell XPS (PowerShell)
# ============================================================
# Usage: Right-click PowerShell -> "Run as Administrator"
#        Then: irm https://raw.githubusercontent.com/raxxbeats/proverbs-ai/main/xps-setup.ps1 | iex
#   OR copy this file to the XPS and run: powershell -ExecutionPolicy Bypass -File xps-setup.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$PORT = 11435
$MODELS_DIR = "$env:USERPROFILE\.proverbs\models"
$PROVERBS_DIR = "$env:USERPROFILE\.proverbs"
$SERVER_DIR = "$env:USERPROFILE\.proverbs\server"
$LOG_FILE = "$env:USERPROFILE\.proverbs\server.log"

function Write-Step($msg) { Write-Host "`n  [$([char]0x2714)] $msg" -ForegroundColor Cyan }
function Write-Info($msg) { Write-Host "      $msg" -ForegroundColor Gray }
function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [!!] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║        Proverbs XPS Inference Server         ║" -ForegroundColor Green
Write-Host "  ║     Dell XPS 13  •  Windows 11  •  i7        ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# ── Step 1: Check / install Node.js ──────────────────────────────────────────
Write-Step "Checking Node.js..."
$nodeOk = $false
try {
    $v = (node --version 2>$null)
    $major = [int]($v -replace 'v(\d+).*','$1')
    if ($major -ge 18) { $nodeOk = $true; Write-OK "Node.js $v" }
} catch {}

if (-not $nodeOk) {
    Write-Info "Installing Node.js LTS via winget..."
    try {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        Write-OK "Node.js installed"
    } catch {
        Write-Fail "Could not install Node.js. Install manually from https://nodejs.org then re-run this script."
    }
}

# ── Step 2: Create directories ────────────────────────────────────────────────
Write-Step "Creating Proverbs directories..."
New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $SERVER_DIR  | Out-Null
Write-OK "Directories ready: $PROVERBS_DIR"

# ── Step 3: Download Proverbs inference server ────────────────────────────────
Write-Step "Setting up Proverbs inference server..."
$serverUrl = "https://raw.githubusercontent.com/raxxbeats/proverbs-ai/main/server/server.js"
$pkgUrl    = "https://raw.githubusercontent.com/raxxbeats/proverbs-ai/main/server/package.json"

try {
    Invoke-WebRequest -Uri $serverUrl -OutFile "$SERVER_DIR\server.js" -UseBasicParsing
    Invoke-WebRequest -Uri $pkgUrl    -OutFile "$SERVER_DIR\package.json" -UseBasicParsing
    Write-OK "Server files downloaded"
} catch {
    # Fallback: write minimal server inline if GitHub fetch fails
    Write-Info "Could not fetch from GitHub — writing minimal server inline..."
    @'
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = parseInt(process.env.PROVERBS_SERVER_PORT) || 11435;
const HOST = process.env.PROVERBS_HOST || '0.0.0.0';
const MODELS_DIR = process.env.PROVERBS_MODELS_DIR || path.join(os.homedir(), '.proverbs', 'models');
fs.mkdirSync(MODELS_DIR, { recursive: true });

// Minimal Ollama-compatible API — enough for Proverbs CLI to connect
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/api/tags' || req.url === '/v1/models') {
    const models = fs.existsSync(MODELS_DIR)
      ? fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.gguf')).map(f => ({ name: f.replace('.gguf',''), model: f.replace('.gguf','') }))
      : [];
    return res.end(JSON.stringify({ models }));
  }
  res.end(JSON.stringify({ error: 'Full server not loaded. Check server.js.' }));
});
server.listen(PORT, HOST, () => console.log(`Proverbs server on http://${HOST}:${PORT}`));
'@ | Set-Content "$SERVER_DIR\server.js" -Encoding UTF8

    @'{"type":"module","dependencies":{"node-llama-cpp":"^3"}}'@ | Set-Content "$SERVER_DIR\package.json"
}

# ── Step 4: Install node-llama-cpp ────────────────────────────────────────────
Write-Step "Installing node-llama-cpp (llama.cpp Node bindings)..."
Write-Info "This takes 2-5 minutes — compiling native bindings for your CPU..."
Set-Location $SERVER_DIR
npm install --save node-llama-cpp 2>&1 | Tee-Object -FilePath "$LOG_FILE" -Append | Where-Object { $_ -match "added|warn|error" }
Write-OK "node-llama-cpp installed"

# ── Step 5: Download models ───────────────────────────────────────────────────
Write-Step "Downloading AI models to $MODELS_DIR ..."

# Model 1: Qwen2.5-Coder 7B — best coding model at this size (~5GB)
$model1Name = "qwen2.5-coder-7b-instruct-q4_k_m.gguf"
$model1Path = "$MODELS_DIR\$model1Name"
$model1Url  = "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf"

if (-not (Test-Path $model1Path)) {
    Write-Info "Downloading Qwen2.5-Coder 7B (~5GB) — this is the primary coding model..."
    Write-Info "Equivalent to Codestral in coding quality, smaller download."
    try {
        $client = New-Object System.Net.WebClient
        $client.DownloadFile($model1Url, $model1Path)
        Write-OK "qwen2.5-coder-7b downloaded"
    } catch {
        Write-Info "WebClient failed — trying curl..."
        curl.exe -L -o $model1Path $model1Url
        Write-OK "qwen2.5-coder-7b downloaded via curl"
    }
} else {
    Write-OK "qwen2.5-coder-7b already present — skipping"
}

# Model 2: Llama 3.1 8B — general purpose / fast utility
$model2Name = "llama3.1-8b-Q4_K_M.gguf"
$model2Path = "$MODELS_DIR\$model2Name"
$model2Url  = "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"

if (-not (Test-Path $model2Path)) {
    Write-Info "Downloading Llama 3.1 8B (~5GB) — fast utility model..."
    try {
        $client2 = New-Object System.Net.WebClient
        $client2.DownloadFile($model2Url, $model2Path)
        Write-OK "llama3.1-8b downloaded"
    } catch {
        Write-Info "Trying curl..."
        curl.exe -L -o $model2Path $model2Url
        Write-OK "llama3.1-8b downloaded via curl"
    }
} else {
    Write-OK "llama3.1-8b already present — skipping"
}

Write-Info "Models in $MODELS_DIR :"
Get-ChildItem $MODELS_DIR -Filter "*.gguf" | ForEach-Object {
    $sizeMB = [math]::Round($_.Length / 1MB)
    Write-Info "  $($_.Name)  ($sizeMB MB)"
}

# ── Step 6: Configure server to bind on all interfaces ───────────────────────
Write-Step "Configuring server for network access..."
[System.Environment]::SetEnvironmentVariable("PROVERBS_HOST",       "0.0.0.0",     "Machine")
[System.Environment]::SetEnvironmentVariable("PROVERBS_SERVER_PORT","$PORT",       "Machine")
[System.Environment]::SetEnvironmentVariable("PROVERBS_MODELS_DIR", $MODELS_DIR,   "Machine")
Write-OK "Environment variables set (PROVERBS_HOST=0.0.0.0, PORT=$PORT)"

# ── Step 7: Open Windows Firewall ────────────────────────────────────────────
Write-Step "Opening Windows Firewall on port $PORT ..."
try {
    Remove-NetFirewallRule -DisplayName "Proverbs AI Server" -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "Proverbs AI Server" `
        -Direction Inbound -Protocol TCP -LocalPort $PORT -Action Allow | Out-Null
    Write-OK "Firewall rule created: TCP $PORT inbound allowed"
} catch {
    Write-Info "Could not create firewall rule automatically — run this manually:"
    Write-Info "  New-NetFirewallRule -DisplayName 'Proverbs AI Server' -Direction Inbound -Protocol TCP -LocalPort $PORT -Action Allow"
}

# ── Step 8: Create startup batch file ────────────────────────────────────────
Write-Step "Creating startup script..."
$startScript = "$PROVERBS_DIR\start-server.bat"
@"
@echo off
set PROVERBS_HOST=0.0.0.0
set PROVERBS_SERVER_PORT=$PORT
set PROVERBS_MODELS_DIR=$MODELS_DIR
cd /d "$SERVER_DIR"
echo Starting Proverbs Inference Server on port $PORT...
node server.js --host 0.0.0.0 --port $PORT --models-dir "$MODELS_DIR"
"@ | Set-Content $startScript -Encoding ASCII
Write-OK "Startup script: $startScript"

# ── Step 9: Register as Windows scheduled task (auto-start on boot) ───────────
Write-Step "Registering as Windows startup task..."
try {
    $action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$startScript`" >> `"$LOG_FILE`" 2>&1"
    $trigger  = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

    Unregister-ScheduledTask -TaskName "Proverbs AI Server" -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName "Proverbs AI Server" `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-OK "Scheduled task registered — server starts at every login"
} catch {
    Write-Info "Could not register scheduled task: $_"
    Write-Info "Start the server manually: $startScript"
}

# ── Step 10: Get IP address ───────────────────────────────────────────────────
Write-Step "Getting network IP address..."
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch "Loopback|vEthernet" -and $_.IPAddress -match "^(192|10|172)"
} | Select-Object -First 1).IPAddress

if ($ip) {
    Write-OK "XPS IP Address: $ip"
} else {
    $ip = (ipconfig | Select-String "IPv4" | Select-Object -First 1) -replace ".*:\s*",""
    Write-Info "IP (from ipconfig): $ip"
}

# ── Step 11: Start the server now ────────────────────────────────────────────
Write-Step "Starting Proverbs server now..."
$env:PROVERBS_HOST = "0.0.0.0"
$env:PROVERBS_SERVER_PORT = "$PORT"
$env:PROVERBS_MODELS_DIR = $MODELS_DIR

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c `"$startScript`" >> `"$LOG_FILE`" 2>&1" `
    -WindowStyle Hidden

Start-Sleep -Seconds 4

# Verify it's listening
$listening = netstat -an 2>$null | Select-String "0.0.0.0:$PORT.*LISTENING"
if ($listening) {
    Write-OK "Server is listening on 0.0.0.0:$PORT"
} else {
    Write-Info "Server may still be starting. Check: $LOG_FILE"
    Write-Info "Manual start: $startScript"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║              XPS Setup Complete!                         ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  XPS IP Address   : " -NoNewline; Write-Host $ip -ForegroundColor Cyan
Write-Host "  Server Port      : " -NoNewline; Write-Host $PORT -ForegroundColor Cyan
Write-Host "  Proverbs API     : " -NoNewline; Write-Host "http://${ip}:${PORT}" -ForegroundColor Cyan
Write-Host "  Models directory : $MODELS_DIR" -ForegroundColor Gray
Write-Host "  Log file         : $LOG_FILE" -ForegroundColor Gray
Write-Host ""
Write-Host "  Models installed:" -ForegroundColor White
Get-ChildItem $MODELS_DIR -Filter "*.gguf" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "    ✔  $($_.Name)" -ForegroundColor Green
}
Write-Host ""
Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  On your Mac, open Proverbs and run:" -ForegroundColor White
Write-Host "    /backend http://${ip}:${PORT}" -ForegroundColor Cyan
Write-Host "  or:" -ForegroundColor Gray
Write-Host "    /backend auto" -ForegroundColor Cyan
Write-Host ""
Write-Host "  The XPS will now handle all AI inference over the local network." -ForegroundColor Gray
Write-Host "  Server auto-starts on login. Manual start: $startScript" -ForegroundColor Gray
Write-Host ""
