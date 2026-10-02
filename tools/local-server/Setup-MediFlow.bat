@echo off
setlocal EnableDelayedExpansion
title MediFlow - One-Click Server Setup

:: =====================================================================
::  MediFlow - Setup + Run EVERYTHING on this Windows PC.
::  Save this file as  C:\mediflow-setup\Setup-MediFlow.bat
::  then double-click it. ALWAYS run it from this same folder.
::
::  It does, by itself, in order:
::    [1] checks Node.js and Git (tries to install them if missing)
::    [2] downloads/updates the program into C:\mediflow
::    [3] installs libraries + builds everything
::    [4] finds this PC's network address for the clinic WiFi
::    [5] asks you for 5 small things (explained below, one by one)
::    [6] registers auto-start (works after every reboot, no login needed)
::    [7] starts API + WhatsApp gateway + website NOW
::    [8] creates the doctor's login account
::    [9] prints the website address + what to test
::  Run it again any time to update + repair (it never deletes your data).
:: =====================================================================

:: ---------- must run as Administrator (auto-relaunch) ----------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights (needed once for auto-start)...
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
  echo [1/9] Node.js not found - trying to install it...
  where winget >nul 2>&1
  if %errorlevel% equ 0 (
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    set "PATH=%PATH%;C:\Program Files\nodejs"
  )
  where node >nul 2>&1
  if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js is missing. Install it from https://nodejs.org
    echo  (LTS version), then double-click this file again.
    pause
    exit /b 1
  )
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
set "NODEVER=%NODEVER:v=%"
for /f "delims=." %%m in ("%NODEVER%") do set "NODEMAJOR=%%m"
if %NODEMAJOR% LSS 20 (
  echo  WARNING: Node.js %NODEVER% is too old - MediFlow needs 20 or newer.
  echo  Install LTS from https://nodejs.org then run again.
  pause
  exit /b 1
)
echo [1/9] Node.js found: %NODEVER%

:: ---------- Node full path (tasks run as SYSTEM, no PATH guaranteed) ----------
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODEPATH set "NODEPATH=%%i"
)

:: ---------- [1b] Git ----------
where git >nul 2>&1
if %errorlevel% neq 0 (
  echo [1/9] Git not found - trying to install it...
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
echo [1/9] Git found.

:: ---------- [2] download / update the program ----------
if not exist "%ROOT%\.git" (
  echo [2/9] Downloading MediFlow into %ROOT% ...
  git clone -b %BRANCH% https://github.com/madzopos-ai/mediflow.git "%ROOT%"
  if errorlevel 1 (
    echo  ERROR: download failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
) else (
  echo [2/9] Updating MediFlow to the newest version...
  git -C "%ROOT%" fetch origin
  git -C "%ROOT%" checkout %BRANCH%
  git -C "%ROOT%" pull --ff-only origin %BRANCH%
  if errorlevel 1 (
    echo  WARNING: update did not apply cleanly - continuing with what is there.
  )
)

:: ---------- [3] libraries ----------
if not exist "%ROOT%\node_modules\.package-lock.json" (
  echo [3/9] Installing libraries (takes a few minutes, once)...
  call npm --prefix "%ROOT%" ci
  if errorlevel 1 (
    echo  ERROR: library install failed. Check the internet and run again.
    pause
    exit /b 1
  )
) else (
  echo [3/9] Libraries already installed.
)

:: ---------- [4] this PC's network address ----------
echo [4/9] Finding this PC's address on the clinic network...
set "LANIP="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress"') do set "LANIP=%%i"
if not defined LANIP (
  for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress"') do set "LANIP=%%i"
)
if not defined LANIP set "LANIP=127.0.0.1"
echo       Address: %LANIP%  (staff open http://%LANIP%:8080)
echo       If staff PCs cannot reach it later, give this PC a fixed
echo       address on the router (DHCP reservation) and run this file again.

:: ---------- folders ----------
if not exist "%ROOT%\data" mkdir "%ROOT%\data"
if not exist "%ROOT%\uploads" mkdir "%ROOT%\uploads"
if not exist "%ROOT%\backups" mkdir "%ROOT%\backups"
if not exist "%ROOT%\gateway-sessions" mkdir "%ROOT%\gateway-sessions"
if not exist "%SETUPDIR%logs" mkdir "%SETUPDIR%logs"

:: ---------- [5] the 5 small things only you know ----------
echo.
echo [5/9] Five quick questions (paste the values, Enter to accept).
echo       Anything already saved is kept - press Enter to keep it.
echo.
call :loadsecrets

if not defined JWT_SECRET (
  for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "JWT_SECRET=%%s"
  echo       Generated a login key.
)
if not defined ENCRYPTION_KEY (
  for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "ENCRYPTION_KEY=%%s"
  echo       Generated a data key.
)

if not defined GATEWAY_ADMIN_TOKEN (
  echo.
  echo  A shared password between the API and WhatsApp parts.
  echo  Type ANY long random text (example: clinic-wa-2026-secret-9f3k):
  set /p "GATEWAY_ADMIN_TOKEN=  Token: "
)
if not defined GATEWAY_PHONE_NUMBER (
  echo.
  echo  The clinic WhatsApp number WITH country code, digits only.
  echo  Example for Lebanon mobile 70 123456 : 96170123456
  set /p "GATEWAY_PHONE_NUMBER=  Number: "
)
if not defined GATEWAY_PROJECT_ID (
  echo.
  echo  The Firebase project of the clinic (example: mediflow-baalbeck).
  echo  If you do not know it, type: mediflow-baalbeck
  set /p "GATEWAY_PROJECT_ID=  Project: "
)
if not defined GATEWAY_CLINIC_ID (
  set "GATEWAY_CLINIC_ID=clc_clinic"
)
if not defined FIREBASE_KEY (
  echo.
  echo  Firebase service-account key file (needed by the WhatsApp part).
  echo  Drag the .json file into THIS window and press Enter,
  echo  or type its full path. Empty = skip for now (WhatsApp waits).
  set /p "FIREBASE_KEY=  Key file (empty to skip): "
)
if defined FIREBASE_KEY (
  :: Drag-and-drop adds quotes around the path - strip them.
  set "FIREBASE_KEY=!FIREBASE_KEY:"=!"
  if not exist "!FIREBASE_KEY!" (
    echo  WARNING: file not found - WhatsApp will wait for a valid key.
    set "FIREBASE_KEY="
  )
)

:: save everything (outside the program folder, so updates never touch it)
(
echo @echo off
echo set "JWT_SECRET=!JWT_SECRET!"
echo set "ENCRYPTION_KEY=!ENCRYPTION_KEY!"
echo set "GATEWAY_ADMIN_TOKEN=!GATEWAY_ADMIN_TOKEN!"
echo set "GATEWAY_PHONE_NUMBER=!GATEWAY_PHONE_NUMBER!"
echo set "GATEWAY_PROJECT_ID=!GATEWAY_PROJECT_ID!"
echo set "GATEWAY_CLINIC_ID=!GATEWAY_CLINIC_ID!"
echo set "FIREBASE_KEY=!FIREBASE_KEY!"
echo set "LANIP=!LANIP!"
) > "%SETUPDIR%server.env.bat"
echo       Saved. Your secrets live ONLY in this folder, never on the internet.

:: ---------- [6] build everything (web uses this PC's address) ----------
echo.
echo [6/9] Building the program (takes a minute or two)...
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
call :writerunner "run-gateway.bat" "apps\baileys-gateway" "dist\index.js" "gateway.log" "PORT=10000" ""

:: web preview needs its own folder + fixed port
(
echo @echo off
echo cd /d "%ROOT%\apps\web"
echo :loop
echo "%ROOT%\node_modules\.bin\vite.cmd" preview --host 0.0.0.0 --port 8080 ^>^> "%SETUPDIR%logs\web.log" 2^>^&1
echo timeout /t 5 /nobreak ^>nul
echo goto loop
) > "%SETUPDIR%run-web.bat"

:: ---------- [7] auto-start tasks ----------
echo.
echo [7/9] Registering auto-start (works after every reboot, no login needed)...
call :registertask "MediFlowAPI" "run-api.bat"
call :registertask "MediFlowGateway" "run-gateway.bat"
call :registertask "MediFlowWeb" "run-web.bat"

:: ---------- firewall (clinic WiFi reaches the site + API) ----------
echo       Opening the clinic network ports (4000 website-data, 8080 website)...
netsh advfirewall firewall add rule name="MediFlow API" dir=in action=allow protocol=TCP localport=4000 >nul 2>&1
netsh advfirewall firewall add rule name="MediFlow Web" dir=in action=allow protocol=TCP localport=8080 >nul 2>&1

:: ---------- stop anything squatting our ports, then start now ----------
echo.
echo [8/9] Starting everything now...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 4000,8080,10000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
schtasks /Run /TN "MediFlowAPI" >nul 2>&1
schtasks /Run /TN "MediFlowGateway" >nul 2>&1
schtasks /Run /TN "MediFlowWeb" >nul 2>&1
timeout /t 12 /nobreak >nul

:: ---------- [8] doctor account ----------
echo.
echo [9/9] Doctor login account (once - skipped automatically if it exists).
set "DOCEMAIL="
set /p "DOCEMAIL=  Doctor email (example: doctor@clinic.com): "
if defined DOCEMAIL (
  set "DOCPASS="
  set /p "DOCPASS=  Password (at least 10 characters, avoid the ! character): "
  set "DOCCLINIC="
  set /p "DOCCLINIC=  Clinic name: "
  call "%SETUPDIR%server.env.bat"
  set "DATABASE_FILE=%ROOT%\data\mediflow.db"
  node "%ROOT%\apps\api\scripts\create-owner.mjs" "!DOCEMAIL!" "!DOCPASS!" "!DOCCLINIC!"
  echo       (If it said the account exists, that is fine - it kept yours.)
)

echo.
echo  ============================================================
echo   DONE! Everything is running on this PC.
echo.
echo   Website (clinic WiFi):  http://%LANIP%:8080
echo   Login with the email + password you just typed.
echo   WhatsApp page: first QR scan links the clinic number,
echo   afterwards it only says "linked".
echo.
echo   Booking test from any phone: send to the clinic number:
echo     "badi ehjz bokra" -^> answer the follow-up -^> yes,
echo     then approve it on the calendar with one tap.
echo  ============================================================
echo.
start "" "http://%LANIP%:8080"
pause
exit /b 0

:: ================= helpers =================
:loadsecrets
if exist "%SETUPDIR%server.env.bat" call "%SETUPDIR%server.env.bat"
exit /b 0

:writerunner
:: %1=file  %2=app folder under ROOT  %3=entry js  %4=log  %5=PORT line  %6=extra SET line (may be empty)
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
echo set "GATEWAY_SESSION_DIR=%ROOT%\gateway-sessions"
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
