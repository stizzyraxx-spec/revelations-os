#!/usr/bin/env bash
# Build a self-contained Proverbs release zip and publish it to GitHub Releases.
#
# Why a zip instead of npm: publishing to npm needs a Classic Automation token,
# and the npm `files` field ships only dist/cli.js — no server/, which the CLI
# needs for backend tiering. This bundles everything the target machine needs.
#
# Usage:
#   bash scripts/package-release.sh            # build only, no upload
#   bash scripts/package-release.sh --publish  # build + create the GitHub release
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
STAGE="$(mktemp -d)/proverbs-${VERSION}"
ZIP="${ROOT}/dist/proverbs-${VERSION}.zip"
PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

echo "==> Packaging Proverbs ${TAG}"

# ── 1. Build the obfuscated CLI ──────────────────────────────────────────────
echo "[1/5] Building dist/cli.js…"
node build.js
[ -f dist/cli.js ] || { echo "ERROR: build produced no dist/cli.js"; exit 1; }

# ── 2. Verify the build actually runs before shipping it ─────────────────────
echo "[2/5] Verifying the built CLI boots…"
if ! node dist/cli.js --version >/dev/null 2>&1; then
  echo "ERROR: dist/cli.js failed to start — refusing to package a broken build."
  exit 1
fi

# ── 3. Stage the payload ─────────────────────────────────────────────────────
echo "[3/5] Staging files…"
mkdir -p "$STAGE"
cp dist/cli.js            "$STAGE/cli.js"
cp package.json           "$STAGE/package.json"
mkdir -p "$STAGE/server"
cp server/server.js       "$STAGE/server/server.js"
cp server/package.json    "$STAGE/server/package.json"
[ -d commands ] && cp -R commands "$STAGE/commands"
[ -f README.md ] && cp README.md "$STAGE/README.md"
cp install-release.ps1     "$STAGE/install-release.ps1"

# Windows launcher — npm's bin shim is unavailable without an npm install.
cat > "$STAGE/proverbs.cmd" <<'CMD'
@echo off
node "%~dp0cli.js" %*
CMD

# POSIX launcher, so the same zip works on the Mac/Linux boxes too.
cat > "$STAGE/proverbs" <<'SH'
#!/usr/bin/env bash
exec node "$(dirname "$0")/cli.js" "$@"
SH
chmod +x "$STAGE/proverbs"

# ── 4. Zip it ────────────────────────────────────────────────────────────────
echo "[4/5] Creating zip…"
mkdir -p "$ROOT/dist"
rm -f "$ZIP"
( cd "$(dirname "$STAGE")" && zip -qr "$ZIP" "proverbs-${VERSION}" )
SIZE="$(du -h "$ZIP" | cut -f1)"
echo "      $ZIP  (${SIZE})"

# ── 5. Publish ───────────────────────────────────────────────────────────────
if [ "$PUBLISH" -eq 1 ]; then
  echo "[5/5] Publishing ${TAG} to GitHub…"
  command -v gh >/dev/null || { echo "ERROR: gh CLI not found"; exit 1; }

  # Never publish a release from a tree that is behind its remote.
  git fetch --quiet --all --prune
  BEHIND="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)"
  if [ "$BEHIND" -gt 0 ]; then
    echo "ERROR: local branch is ${BEHIND} commit(s) behind origin. Merge before releasing."
    exit 1
  fi
  git push

  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "      Release ${TAG} exists — replacing asset."
    gh release upload "$TAG" "$ZIP" "$ROOT/install-release.ps1" --clobber
  else
    gh release create "$TAG" "$ZIP" "$ROOT/install-release.ps1" \
      --title "Proverbs ${VERSION}" \
      --notes "Proverbs ${VERSION}

**Install on Windows** (PowerShell, no admin needed):

This repo is private, so the installer needs a GitHub token with
\`Contents: Read-only\` on this repo (https://github.com/settings/tokens).

\`\`\`powershell
# 1. Download install-release.ps1 from this release (or from the repo root)
# 2. Then:
\$env:GITHUB_TOKEN = 'github_pat_...'
.\\install-release.ps1
\`\`\`

Installs to \`%LOCALAPPDATA%\\Proverbs\` and adds it to your user PATH.
Open a new terminal and run \`proverbs\`.

**What's in this release**
- Test Engine: runs your project's real tests after code edits, feeds failures
  back, fixes, and re-tests (\`/verify\`)
- Windows support across the CLI (shell commands, clipboard, venv paths)
"
  fi
  echo "      Published: $(gh release view "$TAG" --json url -q .url)"
else
  echo "[5/5] Skipping publish (pass --publish to upload)."
fi

rm -rf "$(dirname "$STAGE")"
echo "==> Done."
