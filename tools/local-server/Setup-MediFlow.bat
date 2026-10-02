@echo off
setlocal EnableDelayedExpansion
title MediFlow - One-Click Server Setup

:: =====================================================================
::  MediFlow - Setup + Run EVERYTHING on this Windows PC. Double-click it.
::  Save this file as  C:\mediflow-setup\Setup-MediFlow.bat  and ALWAYS
::  run it from there (secrets live next to it, outside the program).
::
::  It does, by itself, in order:
::    [1] checks Node.js and Git (installs them if missing)
::    [2] downloads/updates the program into C:\mediflow
::    [3] installs libraries + builds everything
::    [4] finds this PC's address on the clinic network
::    [5] asks TWO things only: Firebase key file + project name
::    [6] registers auto-start tasks (API, gateway, website - back after
::        every reboot with no login needed, sessions survive on disk)
::    [7] starts everything NOW and adds doctors (loop, as many as you have)
::    [8] prints the website address + what to test
::  Run it again any time to update + repair. It never deletes your data.
:: =====================================================================

:: ---------- must run as Administrator (auto-relaunch) ----------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights - needed once for auto-start...
  echo If a permission window pops up, click YES.
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b 0
)

set "SETUPDIR=%~dp0"
set "ROOT=C:\mediflow"
set "BRANCH=feat/local-whatsapp"

echo.
echo  ============================================================
echo   MediFlow server setup - everything happens automatically.
echo   Keep this window open until you see DONE at the end.
echo  ============================================================
echo.

:: ---------- [1] Node.js ----------
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [1/8] Node.js not found - trying to install it...
  where winget >nul 2>&1
  if %errorlevel% equ 0 (
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    set "PATH=%PATH%;C:\Program Files\nodejs"
  )
  where node >nul 2>&1
  if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js is missing. Install LTS from https://nodejs.org
    echo  then double-click this file again.
    pause
    exit /b 1
  )
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
set "NODEVER=%NODEVER:v=%"
for /f "delims=." %%m in ("%NODEVER%") do set "NODEMAJOR=%%m"
if %NODEMAJOR% LSS 20 (
  echo  ERROR: Node.js %NODEVER% is too old - need 20 or newer from https://nodejs.org
  pause
  exit /b 1
)
echo [1/8] Node.js %NODEVER% found.

for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODEPATH set "NODEPATH=%%i"
)

:: ---------- [1b] Git ----------
where git >nul 2>&1
if %errorlevel% neq 0 (
  echo [1/8] Git not found - trying to install it...
  where winget >nul 2>&1
  if %errorlevel% equ 0 (
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
    set "PATH=%PATH%;C:\Program Files\Git\cmd"
  )
  where git >nul 2>&1
  if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Git is missing. Install it from https://git-scm.com
    echo  then double-click this file again.
    pause
    exit /b 1
  )
)
echo [1/8] Git found.

:: ---------- [2] download / update the program ----------
if not exist "%ROOT%\.git" (
  echo [2/8] Downloading MediFlow into %ROOT% ...
  call :tryclone
  if errorlevel 1 (
    echo  ERROR: download failed 3 times. Check the internet and run again.
    pause
    exit /b 1
  )
) else (
  echo [2/8] Updating MediFlow to the newest version...
  git -C "%ROOT%" fetch origin
  git -C "%ROOT%" checkout %BRANCH%
  git -C "%ROOT%" pull --ff-only origin %BRANCH%
  if errorlevel 1 (
    echo  WARNING: update did not apply cleanly - continuing with what is there.
  )
)

:: ---------- [3] libraries ----------
if not exist "%ROOT%\node_modules\.package-lock.json" (
  echo [3/8] Installing libraries - first time takes a few minutes...
  call :trynpm
  if errorlevel 1 (
    echo  ERROR: library install failed 3 times. Check the internet and run again.
    pause
    exit /b 1
  )
) else (
  echo [3/8] Libraries already installed.
)

:: ---------- [4] this PC's network address (helper file: no quoting traps) ----------
echo [4/8] Finding this PC's address on the clinic network...
set "LANIP="
for /f "delims=" %%i in ('node "%ROOT%\tools\local-server\lan-ip.cjs"') do set "LANIP=%%i"
if not defined LANIP set "LANIP=127.0.0.1"
echo       Address: %LANIP%  (staff will open http://%LANIP%:8080)
echo       Tip: give this PC a fixed address on the router (DHCP
echo       reservation) so the address never changes, then run this file again.

:: ---------- folders ----------
if not exist "%ROOT%\data" mkdir "%ROOT%\data"
if not exist "%ROOT%\uploads" mkdir "%ROOT%\uploads"
if not exist "%ROOT%\backups" mkdir "%ROOT%\backups"
if not exist "%SETUPDIR%logs" mkdir "%SETUPDIR%logs"
:: An empty clinic list lets the gateway idle gracefully until the first
:: doctor is added below (a missing file would crash it instead).
if not exist "%ROOT%\gateway-config.json" echo {"clinics": []} > "%ROOT%\gateway-config.json"

:: ---------- [5] the two things only you know ----------
echo.
echo [5/8] Two quick questions.
call :loadsecrets

if not defined JWT_SECRET (
  for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "JWT_SECRET=%%s"
  echo       Login key generated and saved.
)
if not defined ENCRYPTION_KEY (
  for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "ENCRYPTION_KEY=%%s"
  echo       Data key generated and saved.
)
if not defined GATEWAY_ADMIN_TOKEN (
  for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"') do set "GATEWAY_ADMIN_TOKEN=%%s"
  echo       WhatsApp shared secret generated and saved.
)
if not defined GW_PROJECT_ID (
  echo.
  echo  Firebase project of the clinics - same one for all doctors.
  echo  Press Enter to accept [mediflow-baalbeck]:
  set /p "GW_PROJECT_ID=  Project: "
  if not defined GW_PROJECT_ID set "GW_PROJECT_ID=mediflow-baalbeck"
)
if not defined FIREBASE_KEY (
  echo.
  echo  Firebase service-account key file - needed by WhatsApp.
  echo  Drag the .json file into THIS window and press Enter.
  echo  Empty = skip for now - WhatsApp waits, the rest works.
  set /p "FIREBASE_KEY=  Key file (empty to skip): "
)
if defined FIREBASE_KEY (
  set "FIREBASE_KEY=!FIREBASE_KEY:"=!"
  if not exist "!FIREBASE_KEY!" (
    echo  WARNING: file not found - WhatsApp will wait for a valid key.
    set "FIREBASE_KEY="
  )
)

:: save everything next to this file (outside the program, never uploaded)
(
echo @echo off
echo set "JWT_SECRET=!JWT_SECRET!"
echo set "ENCRYPTION_KEY=!ENCRYPTION_KEY!"
echo set "GATEWAY_ADMIN_TOKEN=!GATEWAY_ADMIN_TOKEN!"
echo set "GW_PROJECT_ID=!GW_PROJECT_ID!"
echo set "FIREBASE_KEY=!FIREBASE_KEY!"
echo set "LANIP=!LANIP!"
) > "%SETUPDIR%server.env.bat"
echo       Saved. Secrets live ONLY in this folder, never on the internet.

:: ---------- [6] build everything (website points at this PC) ----------
echo.
echo [6/8] Building the program (a minute or two)...
set "VITE_API_URL=http://%LANIP%:4000"
call npm --prefix "%ROOT%" run build
if errorlevel 1 (
  echo  ERROR: build failed. Send a photo of the red lines above.
  pause
  exit /b 1
)
echo       Build OK.

:: ---------- runners (restart themselves if anything stops) ----------
call :writerunner "run-api.bat" "apps\api" "dist\index.js" "api.log" "PORT=4000" "GATEWAY_URL=http://localhost:10000"
call :writerunner "run-gateway.bat" "apps\baileys-gateway" "dist\index.js" "gateway.log" "PORT=10000" "GATEWAY_CONFIG=%ROOT%\gateway-config.json"

:: website preview needs its own folder + fixed port
(
echo @echo off
echo cd /d "%ROOT%\apps\web"
echo :loop
echo "%ROOT%\node_modules\.bin\vite.cmd" preview --host 0.0.0.0 --port 8080 ^>^> "%SETUPDIR%logs\web.log" 2^>^&1
echo timeout /t 5 /nobreak ^>nul
echo goto loop
) > "%SETUPDIR%run-web.bat"

:: ---------- [7] auto-start tasks (back after every reboot, no login) ----------
echo.
echo [7/8] Registering auto-start...
call :registertask "MediFlowAPI" "run-api.bat"
call :registertask "MediFlowGateway" "run-gateway.bat"
call :registertask "MediFlowWeb" "run-web.bat"

:: ---------- firewall (clinic WiFi reaches site + API) ----------
netsh advfirewall firewall add rule name="MediFlow API" dir=in action=allow protocol=TCP localport=4000 >nul 2>&1
netsh advfirewall firewall add rule name="MediFlow Web" dir=in action=allow protocol=TCP localport=8080 >nul 2>&1

:: ---------- stop anything squatting our ports, then start now ----------
echo.
echo [8/8] Starting everything now...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 4000,8080,10000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
schtasks /Run /TN "MediFlowAPI" >nul 2>&1
schtasks /Run /TN "MediFlowGateway" >nul 2>&1
schtasks /Run /TN "MediFlowWeb" >nul 2>&1
timeout /t 12 /nobreak >nul

:: ---------- doctors (loop: as many clinics as you have) ----------
echo.
echo [9/9] Doctor accounts - one per clinic, each gets its own WhatsApp number.
echo       You can add more any time by running this file again.
call "%SETUPDIR%server.env.bat"
set "DATABASE_FILE=%ROOT%\data\mediflow.db"
set "GW_CONFIG=%ROOT%\gateway-config.json"
set "GW_SESSION_BASE=%ROOT%\gateway-sessions"
set "GW_KEY_PATH=%FIREBASE_KEY%"
node "%ROOT%\tools\local-server\add-doctor.cjs"

:: gateway must re-read the clinic list it just gained
schtasks /End /TN "MediFlowGateway" >nul 2>&1
timeout /t 3 /nobreak >nul
schtasks /Run /TN "MediFlowGateway" >nul 2>&1

echo.
echo  ============================================================
echo   DONE! Everything runs on this PC now.
echo.
echo   Website (clinic WiFi):  http://%LANIP%:8080
echo   Each doctor logs in, opens the WhatsApp page once, scans
echo   the QR with the clinic phone - afterwards it only says linked.
echo   If the connection drops, the QR comes back by itself.
echo.
echo   Booking test from any phone, send to a clinic number:
echo     "badi ehjz bokra" - answer the follow-up - yes,
echo     then approve it on the calendar with one tap.
echo   After a reboot everything returns alone: tasks + disk sessions.
echo  ============================================================
echo.
start "" "http://%LANIP%:8080"
pause
exit /b 0

:: ================= helpers =================
:loadsecrets
if exist "%SETUPDIR%server.env.bat" call "%SETUPDIR%server.env.bat"
exit /b 0

:tryclone
set "TRIES=0"
:cloneretry
git clone -b %BRANCH% https://github.com/madzopos-ai/mediflow.git "%ROOT%"
if errorlevel 1 (
  set /a TRIES+=1
  if !TRIES! LSS 3 (
    echo  Internet hiccup - retrying download, attempt !TRIES! of 3...
    timeout /t 5 /nobreak >nul
    goto cloneretry
  )
  exit /b 1
)
exit /b 0

:trynpm
set "TRIES=0"
:npmretry
call npm --prefix "%ROOT%" ci --no-audit --no-fund
if errorlevel 1 (
  set /a TRIES+=1
  if !TRIES! LSS 3 (
    echo  Internet hiccup - retrying install, attempt !TRIES! of 3...
    timeout /t 5 /nobreak >nul
    goto npmretry
  )
  exit /b 1
)
exit /b 0

:writerunner
:: %1=file  %2=app folder  %3=entry js  %4=log  %5=PORT line  %6=extra SET line
(
echo @echo off
echo cd /d "%ROOT%\%~2"
echo call "%SETUPDIR%server.env.bat"
echo set "NODE_ENV=production"
echo set "HOST=0.0.0.0"
echo set "%~5"
if not "%~6"=="" echo set "%~6"
echo set "DATABASE_FILE=%ROOT%\data\mediflow.db"
echo set "UPLOADS_DIR=%ROOT%\uploads"
echo set "BACKUP_DIR=%ROOT%\backups"
echo set "CORS_ORIGINS=http://%LANIP%:8080"
echo set "PUBLIC_WEB_URL=http://%LANIP%:8080"
echo set "WHATSAPP_PROVIDER=cloud"
echo set "REMINDER_WORKER_ENABLED=false"
echo set "DEFAULT_TIMEZONE=Asia/Beirut"
echo set "MEDIFLOW_API_URL=http://localhost:4000"
echo set "GOOGLE_APPLICATION_CREDENTIALS=%%FIREBASE_KEY%%"
echo :loop
echo "%NODEPATH%" "%ROOT%\%~2\%~3" ^>^> "%SETUPDIR%logs\%~4" 2^>^&1
echo timeout /t 5 /nobreak ^>nul
echo goto loop
) > "%SETUPDIR%\%~1"
exit /b 0

:registertask
schtasks /Delete /TN "%~1" /F >nul 2>&1
schtasks /Create /TN "%~1" /TR "\"%SETUPDIR%%~2\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (
  echo  WARNING: task %~1 did not register. Right-click this file ^> Run as administrator.
)
exit /b 0
