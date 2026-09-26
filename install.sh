#!/usr/bin/env bash
#
# Telos installer — one line:
#
#   curl -fsSL https://raw.githubusercontent.com/zainaqdas/Telos/main/install.sh | bash
#
# What it does:
#   1. verifies a Node.js runtime capable of type stripping (>= 22.18, 24+ ideal)
#   2. clones (or updates) the Telos checkout at ~/.telos
#   3. `npm link`s it so the `telos` command is on your PATH
#   4. prints the two config lines to set before the first run
#
# Also runnable from a checkout:  bash install.sh
# Update an existing install:     bash install.sh --update   (or just re-run)
# Uninstall:                      bash install.sh --uninstall
#
# Private repo? Provide a GitHub token with repo read access:
#   curl -fsSL .../install.sh | bash -s -- --token ghp_xxx
#   (or: TELOS_GITHUB_TOKEN=ghp_xxx bash install.sh)
# The token is used for the clone/pull only and is not written to disk.
#
set -euo pipefail

REPO="https://github.com/zainaqdas/Telos.git"
INSTALL_DIR="$HOME/.telos"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
TOKEN=""

# --token flag or TELOS_GITHUB_TOKEN / GITHUB_TOKEN env.
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$TOKEN" ] && TOKEN="${TELOS_GITHUB_TOKEN:-${GITHUB_TOKEN:-$TOKEN}}"

# Token-scoped clone URL; we scrub the token from the checkout's remote afterwards.
repo_url() {
  if [ -n "$TOKEN" ]; then echo "https://x-access-token:${TOKEN}@github.com/zainaqdas/Telos.git"; else echo "$REPO"; fi
}

say()  { printf '%s\n' "$*"; }
fail() { printf 'telos installer: %s\n' "$*" >&2; exit 1; }

# ── uninstall ────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  npm unlink -g telos >/dev/null 2>&1 || true
  rm -rf "$INSTALL_DIR"
  say "Telos removed (config in your projects' .project-agent/ dirs was kept)."
  exit 0
fi

# ── node check ───────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node 22.18+ or 24+ from https://nodejs.org first."
NODE_VER=$(node -p "process.versions.node")
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "Node $NODE_VER is too old. Telos needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (type stripping). Install 24 LTS and re-run."
fi
say "✓ Node $NODE_VER"

# ── git check ────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git not found. Install git first."

# ── clone or update ──────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "✓ updating existing checkout at $INSTALL_DIR"
  if [ -n "$TOKEN" ]; then
    git -C "$INSTALL_DIR" pull "$(repo_url)" main --ff-only >/dev/null 2>&1 || say "  (update skipped: pull failed; keeping your checkout)"
  else
    git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || say "  (update skipped: local changes or private repo without --token)"
  fi
else
  say "✓ cloning Telos to $INSTALL_DIR"
  git clone --depth 1 "$(repo_url)" "$INSTALL_DIR" >/dev/null 2>&1 || {
    [ -z "$TOKEN" ] && fail "clone failed. If $REPO is private, re-run with --token <github-token> (repo read access)."
    fail "clone failed — check the token (needs repo read access) and your network."
  }
  # Never leave the credential in the checkout's git config.
  git -C "$INSTALL_DIR" remote set-url origin "$REPO"
fi

# ── link ─────────────────────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found (it ships with Node). Reinstall Node from https://nodejs.org."
fi
( cd "$INSTALL_DIR" && npm install --silent >/dev/null 2>&1 && npm run build --silent >/dev/null 2>&1 ) \
  && say "✓ compiled dist/ (npm installs of your projects will use plain JS)" \
  || say "  (build skipped — the clone will run src/ via Node's native type stripping)"
( cd "$INSTALL_DIR" && npm link --silent >/dev/null 2>&1 ) || fail "npm link failed — run 'cd $INSTALL_DIR && npm link' manually to see the error."
say "✓ linked the telos command"

# ── done ─────────────────────────────────────────────────────────────────────
command -v telos >/dev/null 2>&1 && LINK_OK=1 || LINK_OK=0
if [ "$LINK_OK" -eq 0 ]; then
  say "  (telos not on PATH yet — open a new shell, or add \"\$HOME/.npm-global/bin\" to PATH)"
fi
say ""
say "Telos installed. To start in any project directory:"
say ""
say "    cd your-project"
say "    telos                 # first run scaffolds .project-agent/config.toml"
say ""
say "then set the model name and your API key env var as it printed, and run"
say "\`telos\` again. Full config reference: $INSTALL_DIR/README.md"
