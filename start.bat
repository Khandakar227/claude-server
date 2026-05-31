@echo off
REM Double-click launcher for claude-server (bundled JS).
REM Requires: Node.js and Claude Code installed (claude on PATH).
setlocal
cd /d "%~dp0"

if not exist "dist\claude-server.cjs" (
  echo [claude-server] dist\claude-server.cjs not found. Run: npm run build:bundle
  pause
  exit /b 1
)

if not exist ".env" (
  echo [claude-server] No .env found. Generating one with a fresh token...
  for /f "delims=" %%T in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set TOKEN=%%T
  > .env echo HOST=127.0.0.1
  >> .env echo PORT=8787
  >> .env echo AUTH_TOKEN=%TOKEN%
  echo [claude-server] Wrote .env. Your AUTH_TOKEN is: %TOKEN%
)

echo [claude-server] Starting on http://127.0.0.1:8787  (Ctrl+C to stop)
node "dist\claude-server.cjs"
pause
