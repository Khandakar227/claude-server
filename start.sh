#!/usr/bin/env bash
# Launcher for claude-server (bundled JS). Requires Node.js and Claude Code (claude on PATH).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dist/claude-server.cjs ]; then
  echo "[claude-server] dist/claude-server.cjs not found. Run: npm run build:bundle"
  exit 1
fi

if [ ! -f .env ]; then
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf 'HOST=127.0.0.1\nPORT=8787\nAUTH_TOKEN=%s\n' "$TOKEN" > .env
  echo "[claude-server] Wrote .env. Your AUTH_TOKEN is: $TOKEN"
fi

echo "[claude-server] Starting on http://127.0.0.1:8787  (Ctrl+C to stop)"
exec node dist/claude-server.cjs
