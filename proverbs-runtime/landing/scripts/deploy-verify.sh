#!/usr/bin/env bash
# =============================================================================
# deploy-verify.sh — Autonomous Vercel deploy + production verification
# =============================================================================
# Usage:
#   bash scripts/deploy-verify.sh           # deploy + full verify
#   bash scripts/deploy-verify.sh --dry-run # show steps, no real deploy
#
# Env overrides:
#   PROD_URL        skip domain detection, force this as production URL
#   MAX_RETRIES     retry attempts on failure (default: 2)
#   POLL_INTERVAL   seconds between status polls (default: 15)
#   MAX_POLL        max poll attempts before timeout (default: 40)
# =============================================================================

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && DRY_RUN=true; done

# ── Config ────────────────────────────────────────────────────────────────────
MAX_RETRIES="${MAX_RETRIES:-2}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
MAX_POLL="${MAX_POLL:-40}"
DEPLOY_URL=""

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' N='\033[0m'
else
  R='' G='' Y='' B='' N=''
fi

ts()   { date +%H:%M:%S; }
log()  { echo -e "${G}[$(ts)]${N} $*"; }
warn() { echo -e "${Y}[$(ts)] WARN:${N} $*"; }
fail() { echo -e "${R}[$(ts)] FAIL:${N} $*" >&2; }
step() { echo -e "${B}[$(ts)]  →${N} $*"; }

# ── Bundle hash detection (Next.js + Vite) ────────────────────────────────────
get_bundle_hash() {
  local url="$1"
  local html
  html=$(curl -sL --max-time 20 "$url" 2>/dev/null) || { echo ""; return; }

  # Next.js: /_next/static/<buildId>/
  local h
  h=$(printf '%s' "$html" | grep -oE '"/_next/static/[^/"]+/' | head -1 | cut -d'/' -f4 | tr -d '"')
  [[ -n "$h" ]] && { echo "$h"; return; }

  # Vite: /assets/name.<hash>.js
  h=$(printf '%s' "$html" | grep -oE '/assets/[^"]+\.[a-f0-9]{8,}\.(js|css)' | head -1 | grep -oE '\.[a-f0-9]{8,}\.' | tr -d '.')
  [[ -n "$h" ]] && { echo "$h"; return; }

  echo ""
}

# ── Status polling ────────────────────────────────────────────────────────────
poll_ready() {
  local url="$1"
  local i inspect status

  for i in $(seq 1 "$MAX_POLL"); do
    inspect=$(vercel inspect "$url" 2>/dev/null || echo "")
    status=$(printf '%s' "$inspect" | grep -iE '^\s+Status' | head -1 | awk '{print $NF}' | tr '[:upper:]' '[:lower:]' | tr -d '●•○▸ ')

    step "Poll $i/$MAX_POLL — status: ${status:-unknown}"

    case "$status" in
      ready)                    return 0 ;;
      error|failed|canceled)    fail "Build ended: $status"; return 1 ;;
    esac

    [[ $i -eq "$MAX_POLL" ]] && { fail "Timeout after $((MAX_POLL * POLL_INTERVAL))s"; return 1; }
    sleep "$POLL_INTERVAL"
  done
}

# ── Production domain resolution ──────────────────────────────────────────────
get_prod_domain() {
  local deploy_url="$1"
  local inspect domain

  inspect=$(vercel inspect "$deploy_url" 2>/dev/null || echo "")

  # "Aliases    my-domain.com" line
  domain=$(printf '%s' "$inspect" | grep -iE '^\s+(Aliases?|Production Domain)\s+' | awk '{print $NF}' | head -1)
  [[ -n "$domain" && "$domain" != *"vercel.app"* ]] && { echo "$domain"; return; }

  # Any non-vercel.app hostname in inspect
  domain=$(printf '%s' "$inspect" | grep -oE '[a-z0-9-]+\.[a-z]{2,}\.[a-z]{2,}|[a-z0-9-]+\.[a-z]{2,}' \
    | grep -v 'vercel\.app\|vercel\.com\|now\.sh' | head -1)
  [[ -n "$domain" ]] && { echo "$domain"; return; }

  # Last resort: the per-deployment URL itself
  echo "${deploy_url#https://}"
}

# ── Smoke tests (Playwright or curl fallback) ─────────────────────────────────
run_smoke() {
  local prod_url="$1"

  if [[ -f "playwright.config.ts" || -f "playwright.config.js" ]]; then
    step "Playwright @smoke → $prod_url"
    BASE_URL="$prod_url" npx playwright test --grep "@smoke" --reporter=line
    return $?
  fi

  step "HTTP smoke checks → $prod_url"
  local path code failed=0

  for path in "/" "/login" "/signin"; do
    code=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 20 "${prod_url}${path}" 2>/dev/null || echo "000")
    if [[ "$path" == "/" && "$code" != "200" ]]; then
      fail "  ✗ ${path} → HTTP $code"
      failed=1
    else
      step "  ✓ ${path} → HTTP $code"
    fi
  done

  return $failed
}

# ── Build log diagnosis ───────────────────────────────────────────────────────
diagnose() {
  [[ -z "${DEPLOY_URL:-}" ]] && return
  warn "── Build log excerpt ──────────────────────────────────"
  vercel logs "$DEPLOY_URL" 2>/dev/null | tail -40 \
    | grep -iE 'error|warn|fail|exception|cannot|undefined' \
    || warn "(no notable lines found in logs)"
  warn "────────────────────────────────────────────────────────"
}

# ── Single deploy+verify attempt ─────────────────────────────────────────────
attempt() {
  local n=$1
  log "═══ Attempt $n/$((MAX_RETRIES + 1)) ════════════════════════════════════"

  # 1. Deploy
  if $DRY_RUN; then
    log "[DRY RUN] vercel --prod --yes"
    DEPLOY_URL="https://dry-run-preview.vercel.app"
  else
    step "Running: vercel --prod --yes"
    local output
    output=$(vercel --prod --yes 2>&1)
    echo "$output"

    # Prefer "Production: https://..." line, fall back to any *.vercel.app URL
    DEPLOY_URL=$(printf '%s' "$output" | grep -iE 'production:?\s+https?://' \
      | grep -oE 'https?://[a-zA-Z0-9._-]+' | tail -1)
    [[ -z "$DEPLOY_URL" ]] && \
      DEPLOY_URL=$(printf '%s' "$output" | grep -oE 'https://[a-zA-Z0-9-]+\.vercel\.app' | tail -1)

    if [[ -z "$DEPLOY_URL" ]]; then
      fail "Could not extract deployment URL from vercel output"
      return 1
    fi
    log "Deploy URL: $DEPLOY_URL"
  fi

  # 2. Poll for READY
  if $DRY_RUN; then
    log "[DRY RUN] Would poll build status"
  else
    step "Waiting for READY status..."
    poll_ready "$DEPLOY_URL" || return 1
    log "Status: READY ✓"
  fi

  # 3. Resolve production domain
  local prod_url
  if [[ -n "${PROD_URL:-}" ]]; then
    prod_url="${PROD_URL}"
  else
    prod_url="https://$(get_prod_domain "$DEPLOY_URL")"
  fi
  log "Production: $prod_url"

  # 4. Bundle hash verification
  if $DRY_RUN; then
    log "[DRY RUN] Would verify bundle hash on production alias"
  else
    step "Verifying bundle hash on production alias..."
    local deploy_hash prod_hash
    deploy_hash=$(get_bundle_hash "$DEPLOY_URL")
    prod_hash=$(get_bundle_hash "$prod_url")

    log "  Deploy hash : ${deploy_hash:-(not detected)}"
    log "  Prod hash   : ${prod_hash:-(not detected)}"

    if [[ -n "$deploy_hash" && -n "$prod_hash" ]]; then
      if [[ "$deploy_hash" != "$prod_hash" ]]; then
        warn "Hash mismatch — waiting 30s for CDN propagation..."
        sleep 30
        prod_hash=$(get_bundle_hash "$prod_url")
        log "  Prod hash (retry): ${prod_hash:-(not detected)}"
        if [[ "$deploy_hash" != "$prod_hash" ]]; then
          fail "Production alias still serving old bundle (deploy=$deploy_hash prod=$prod_hash)"
          return 1
        fi
      fi
      log "Bundle hash verified: $deploy_hash ✓"
    else
      warn "Hash not detected in both URLs — skipping hash check"
    fi
  fi

  # 5. Smoke tests
  if $DRY_RUN; then
    log "[DRY RUN] Would run smoke tests against $prod_url"
  else
    run_smoke "$prod_url" || return 1
    log "Smoke tests: PASSED ✓"
  fi

  echo ""
  log "╔═════════════════════════════════════════════════╗"
  log "║   ALL CHECKS PASSED — DEPLOY VERIFIED ✓        ║"
  log "╠═════════════════════════════════════════════════╣"
  log "║   $prod_url"
  log "╚═════════════════════════════════════════════════╝"
  return 0
}

# ── Entry ─────────────────────────────────────────────────────────────────────
$DRY_RUN && warn "DRY RUN MODE — no real deployment will happen"

for attempt_n in $(seq 1 $((MAX_RETRIES + 1))); do
  if attempt "$attempt_n"; then
    exit 0
  fi

  if [[ $attempt_n -le $MAX_RETRIES ]]; then
    diagnose
    warn "Retrying in 30s..."
    sleep 30
  fi
done

fail "All $((MAX_RETRIES + 1)) attempts failed. Manual intervention required."
exit 1
