# Run this in PowerShell as Administrator
# Proverbs AI Coding Assistant — Installer
# Idempotent: safe to run more than once.

#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Banner {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host "  Installing Proverbs AI Coding Assistant..." -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host ""
}

function Ensure-Admin {
    $currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "[ERROR] This script must be run as Administrator." -ForegroundColor Red
        Write-Host "        Right-click PowerShell and choose 'Run as Administrator', then try again." -ForegroundColor Yellow
        exit 1
    }
}

function Get-CommandPath([string]$name) {
    return (Get-Command $name -ErrorAction SilentlyContinue)?.Source
}

function Download-File([string]$url, [string]$dest) {
    Write-Host "  Downloading: $url" -ForegroundColor Gray
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($url, $dest)
    Write-Host "  Saved to: $dest" -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# Step 1 — Banner + admin check
# ---------------------------------------------------------------------------

Write-Banner
Ensure-Admin

# ---------------------------------------------------------------------------
# Step 2 — Node.js 18+
# ---------------------------------------------------------------------------

Write-Host "[1/5] Checking Node.js 18+..." -ForegroundColor Yellow

$nodeOk = $false
$nodePath = Get-CommandPath 'node'

if ($nodePath) {
    try {
        $rawVersion = & node --version 2>&1   # e.g. "v20.11.0"
        $versionNum = [int]($rawVersion.TrimStart('v').Split('.')[0])
        if ($versionNum -ge 18) {
            Write-Host "      Node.js $rawVersion already installed — OK" -ForegroundColor Green
            $nodeOk = $true
        } else {
            Write-Host "      Node.js $rawVersion found but version < 18 — will upgrade." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "      Could not determine Node version — will reinstall." -ForegroundColor Yellow
    }
}

if (-not $nodeOk) {
    try {
        # Resolve the latest LTS installer URL dynamically
        $nodeInstallerUrl = 'https://nodejs.org/dist/lts/node-lts-x64.msi'
        $nodeInstallerPath = "$env:TEMP\node-lts-installer.msi"

        Write-Host "      Downloading Node.js LTS installer..." -ForegroundColor Yellow
        Download-File $nodeInstallerUrl $nodeInstallerPath

        Write-Host "      Running Node.js installer silently..." -ForegroundColor Yellow
        $proc = Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstallerPath`" /qn /norestart ADDLOCAL=ALL" -Wait -PassThru
        if ($proc.ExitCode -notin @(0, 3010)) {
            throw "Node.js installer exited with code $($proc.ExitCode)"
        }

        # Refresh PATH so 'node' is visible in this session
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')

        $rawVersion = & node --version 2>&1
        Write-Host "      Node.js $rawVersion installed successfully." -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Node.js installation failed: $_" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Step 3 — Ollama
# ---------------------------------------------------------------------------

Write-Host "[2/5] Checking Ollama..." -ForegroundColor Yellow

$ollamaPath = Get-CommandPath 'ollama'

if ($ollamaPath) {
    Write-Host "      Ollama already installed at $ollamaPath — OK" -ForegroundColor Green
} else {
    try {
        $ollamaUrl = 'https://ollama.com/download/OllamaSetup.exe'
        $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"

        Write-Host "      Downloading OllamaSetup.exe..." -ForegroundColor Yellow
        Download-File $ollamaUrl $ollamaInstaller

        Write-Host "      Running Ollama installer silently..." -ForegroundColor Yellow
        $proc = Start-Process $ollamaInstaller -ArgumentList '/S' -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            throw "Ollama installer exited with code $($proc.ExitCode)"
        }

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')

        Write-Host "      Ollama installed successfully." -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Ollama installation failed: $_" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Step 4 — Wait for Ollama to be running (poll up to 30 s)
# ---------------------------------------------------------------------------

Write-Host "[3/5] Waiting for Ollama to start (up to 30 s)..." -ForegroundColor Yellow

# Start the Ollama service/server if it isn't already responding
$ollamaExe = Get-CommandPath 'ollama'
if ($ollamaExe) {
    # Attempt to start in background; harmless if already running
    Start-Process $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue
}

$ollamaReady = $false
$deadline = (Get-Date).AddSeconds(30)

while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri 'http://localhost:11434' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $ollamaReady = $true
            break
        }
    } catch {
        # Not ready yet — wait and retry
    }
    Start-Sleep -Seconds 2
}

if (-not $ollamaReady) {
    Write-Host "[ERROR] Ollama did not respond on http://localhost:11434 within 30 seconds." -ForegroundColor Red
    Write-Host "        Try starting Ollama manually ('ollama serve') and re-run this script." -ForegroundColor Yellow
    exit 1
}

Write-Host "      Ollama is running." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 5 — Pull qwen2.5-coder:7b model
# ---------------------------------------------------------------------------

Write-Host "[4/5] Pulling model qwen2.5-coder:7b (~4.7 GB — this may take several minutes)..." -ForegroundColor Yellow
Write-Host "      Please be patient while the model downloads." -ForegroundColor Gray

try {
    # Check if model is already present to stay idempotent
    $modelList = & ollama list 2>&1
    if ($modelList -match 'qwen2\.5-coder:7b') {
        Write-Host "      Model qwen2.5-coder:7b already present — skipping pull." -ForegroundColor Green
    } else {
        & ollama pull qwen2.5-coder:7b
        if ($LASTEXITCODE -ne 0) {
            throw "ollama pull exited with code $LASTEXITCODE"
        }
        Write-Host "      Model pulled successfully." -ForegroundColor Green
    }
} catch {
    Write-Host "[ERROR] Failed to pull model: $_" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Step 6 — Install Proverbs globally via npm
# ---------------------------------------------------------------------------

Write-Host "[5/5] Installing Proverbs AI globally (npm install -g proverbs-ai)..." -ForegroundColor Yellow

try {
    & npm install -g proverbs-ai
    if ($LASTEXITCODE -ne 0) {
        throw "npm install -g proverbs-ai exited with code $LASTEXITCODE"
    }
    Write-Host "      proverbs-ai package installed." -ForegroundColor Green
} catch {
    Write-Host "[ERROR] npm global install failed: $_" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Step 7 — Verify 'proverbs' is in PATH
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Verifying installation..." -ForegroundColor Yellow

# Refresh PATH one more time in case npm just added its bin dir
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

$proverbsPath = Get-CommandPath 'proverbs'

if (-not $proverbsPath) {
    # npm global bin may not yet be on the system PATH; check npm prefix manually
    try {
        $npmBin = (& npm bin -g 2>&1).Trim()
        $proverbsCandidate = Join-Path $npmBin 'proverbs'
        if (Test-Path "$proverbsCandidate.cmd") {
            $proverbsPath = "$proverbsCandidate.cmd"
        } elseif (Test-Path $proverbsCandidate) {
            $proverbsPath = $proverbsCandidate
        }
    } catch { }
}

if ($proverbsPath) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "  Proverbs AI Coding Assistant installed!" -ForegroundColor Green
    Write-Host "  Binary: $proverbsPath"                    -ForegroundColor Green
    Write-Host ""
    Write-Host "  Get started:" -ForegroundColor Green
    Write-Host "    proverbs --help" -ForegroundColor Cyan
    Write-Host "    proverbs chat" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "[WARN] 'proverbs' was not found in the current PATH." -ForegroundColor Yellow
    Write-Host "       The package was installed but you may need to:" -ForegroundColor Yellow
    Write-Host "       1. Close and reopen PowerShell (PATH refresh), or" -ForegroundColor Yellow
    Write-Host "       2. Add the npm global bin directory to your PATH manually." -ForegroundColor Yellow
    Write-Host "          Run: npm bin -g   to find the directory." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Installation otherwise completed successfully." -ForegroundColor Green
    Write-Host ""
}
