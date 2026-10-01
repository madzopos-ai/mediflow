@echo off
REM MediFlow local starter — double-click and everything you need comes up:
REM   1. frees ports 4000 (API) and 5171 (web) so a stale server can never
REM      block the new one with EADDRINUSE,
REM   2. seeds the dev database (idempotent: existing data is untouched),
REM   3. starts the API, the web app, and — only when it is configured —
REM      the Baileys gateway, each in its own window.
setlocal
cd /d "%~dp0"

echo === MediFlow local start ===
echo [1/4] Freeing ports 4000 and 5171 if busy...
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1; if ($p) { Stop-Process -Id $p -Force; 'freed 4000' } else { '4000 free' }"
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 5171 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1; if ($p) { Stop-Process -Id $p -Force; 'freed 5171' } else { '5171 free' }"

echo [2/4] Seeding dev database (safe to re-run)...
set SEED_OWNER_EMAIL=admin@mediflow.test
set SEED_OWNER_PASSWORD=admin126342
cmd /c "npm run db:seed --workspace @mediflow/api"
if errorlevel 1 (
  echo SEED FAILED - fix the error above, then run start.bat again.
  pause
  exit /b 1
)

echo [3/4] Starting API on :4000 ...
start "MediFlow API :4000" /d "%~dp0apps\api" cmd /k "set CORS_ORIGINS=http://localhost:5171 && npm run dev"

echo [4/4] Starting Web on :5171 ...
REM Vite pre-bundles @mediflow/shared and never notices when it is rebuilt,
REM so a stale parser would keep running in the browser forever. Clearing the
REM optimizer cache forces a fresh bundle on every start.
if exist "apps\web\node_modules\.vite" rmdir /s /q "apps\web\node_modules\.vite"
start "MediFlow Web :5171" /d "%~dp0apps\web" cmd /k "npm run dev"

if exist "apps\baileys-gateway\gateway-config.json" (
  echo Starting Baileys gateway ...
  start "MediFlow Baileys" /d "%~dp0apps\baileys-gateway" cmd /k "npm run dev"
) else (
  echo Skipping Baileys gateway - no apps\baileys-gateway\gateway-config.json yet.
  echo Copy gateway-config.example.json to get WhatsApp sending.
)

echo.
echo Open: http://localhost:5171
echo Login: admin@mediflow.test / admin126342
endlocal
