# Proverbs — Windows installer (private GitHub Release edition)
#
# The repo is private, so anonymous downloads 404. This installer authenticates
# with a GitHub Personal Access Token and pulls the latest release asset.
#
# Get a token: https://github.com/settings/tokens  →  Fine-grained token,
# repository = stizzyraxx-spec/proverbs-ai, permission = Contents: Read-only.
#
# Run (PowerShell, no admin needed):
#   $env:GITHUB_TOKEN = 'github_pat_...'
#   .\install-release.ps1
#
# If GITHUB_TOKEN is not set the script prompts for it (input is masked).
# The token is used only for api.github.com and is never written to disk.
#
# Idempotent: safe to re-run to upgrade in place.

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo      = 'stizzyraxx-spec/proverbs-ai'
$InstallTo = Join-Path $env:LOCALAPPDATA 'Proverbs'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say ""
Say "=============================================" Cyan
Say "  Installing Proverbs"                          Cyan
Say "=============================================" Cyan
Say ""

# ── 1. Node.js 18+ ───────────────────────────────────────────────────────────
Say "[1/5] Checking Node.js 18+..." Yellow
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say "[ERROR] Node.js is not installed." Red
    Say "        Install the LTS build from https://nodejs.org/ then re-run this script." Yellow
    exit 1
}
$verString = (& node --version).TrimStart('v')
$major = [int]($verString -split '\.')[0]
if ($major -lt 18) {
    Say "[ERROR] Node.js $verString found, but 18+ is required." Red
    exit 1
}
Say "      Node.js $verString OK." Green

# ── 2. Token ─────────────────────────────────────────────────────────────────
Say "[2/5] Authenticating to GitHub..." Yellow
$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    Say "      This repo is private, so a GitHub token is required." Gray
    Say "      Create one at https://github.com/settings/tokens (Contents: Read-only)." Gray
    $secure = Read-Host -Prompt '      Paste your GitHub token' -AsSecureString
    $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try   { $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if ([string]::IsNullOrWhiteSpace($token)) {
    Say "[ERROR] No token supplied." Red
    exit 1
}
$headers = @{
    'User-Agent'           = 'proverbs-installer'
    'Accept'               = 'application/vnd.github+json'
    'Authorization'        = "Bearer $token"
    'X-GitHub-Api-Version' = '2022-11-28'
}

# ── 3. Resolve the latest release asset ──────────────────────────────────────
Say "[3/5] Finding the latest release..." Yellow
try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
} catch {
    Say "[ERROR] Could not read releases: $_" Red
    Say "        A 404 here usually means the token lacks access to $Repo." Yellow
    exit 1
}
$asset = $rel.assets | Where-Object { $_.name -like 'proverbs-*.zip' } | Select-Object -First 1
if (-not $asset) {
    Say "[ERROR] No proverbs-*.zip asset on release $($rel.tag_name)." Red
    exit 1
}
Say "      $($rel.tag_name) — $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)" Green

# ── 4. Download + extract ────────────────────────────────────────────────────
Say "[4/5] Downloading and installing to $InstallTo ..." Yellow
$tmp     = Join-Path $env:TEMP "proverbs-$([guid]::NewGuid().ToString('N')).zip"
$staging = Join-Path $env:TEMP "proverbs-extract-$([guid]::NewGuid().ToString('N'))"
try {
    # A private release asset must be fetched from the API URL with
    # Accept: application/octet-stream — browser_download_url will not
    # authenticate via headers and returns 404 for private repos.
    $dlHeaders = $headers.Clone()
    $dlHeaders['Accept'] = 'application/octet-stream'
    Invoke-WebRequest -Uri $asset.url -Headers $dlHeaders -OutFile $tmp -UseBasicParsing

    Expand-Archive -Path $tmp -DestinationPath $staging -Force

    # The zip contains a single proverbs-<version>/ root; install its contents.
    $inner = Get-ChildItem $staging -Directory | Select-Object -First 1
    $src   = if ($inner) { $inner.FullName } else { $staging }

    if (Test-Path $InstallTo) { Remove-Item $InstallTo -Recurse -Force }
    New-Item -ItemType Directory -Path $InstallTo -Force | Out-Null
    Copy-Item -Path (Join-Path $src '*') -Destination $InstallTo -Recurse -Force
} catch {
    Say "[ERROR] Install failed: $_" Red
    exit 1
} finally {
    Remove-Item $tmp, $staging -Recurse -Force -ErrorAction SilentlyContinue
}
Say "      Files installed." Green

# ── 5. PATH (user scope — no admin needed) ───────────────────────────────────
Say "[5/5] Adding Proverbs to your PATH..." Yellow
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallTo*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallTo } else { "$userPath;$InstallTo" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Say "      PATH updated (restart your terminal to pick it up)." Green
} else {
    Say "      Already on PATH." Green
}
$env:Path = "$env:Path;$InstallTo"

# ── Verify ───────────────────────────────────────────────────────────────────
Say ""
$cli = Join-Path $InstallTo 'cli.js'
if (-not (Test-Path $cli)) {
    Say "[ERROR] cli.js missing after install." Red
    exit 1
}
try {
    & node $cli --version | Out-Null
    Say "=============================================" Green
    Say "  Proverbs installed."                         Green
    Say "  Location: $InstallTo"                        Green
    Say ""
    Say "  Open a NEW terminal, then run:"              Green
    Say "    proverbs"                                  Cyan
    Say "=============================================" Green
    Say ""
} catch {
    Say "[WARN] Installed, but the CLI did not start cleanly: $_" Yellow
    Say "       Try running:  node `"$cli`"" Yellow
}
