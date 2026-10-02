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
::    [3] installs libraries + builds the servers
::    [4] publishes this PC on its stable ngrok address (one-time authtoken)
::    [5] asks TWO things only: Firebase key file + project name
::    [6] registers auto-start tasks (API, gateway, tunnel - back after
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

:: ---------- [1b] Git (automatic: system, else winget, else portable download) ----------
set "GITBIN=git"
where git >nul 2>&1
if %errorlevel% neq 0 call :ensuregit
"%GITBIN%" --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Git could not be installed automatically.
  echo  Install it from https://git-scm.com then double-click this file again.
  pause
  exit /b 1
)
echo [1/8] Git ready.

:: ---------- [2] download / update the program ----------
if not exist "%ROOT%\.git" (
  echo [2/8] Downloading MediFlow into %ROOT% ...
  call :tryclone
  if errorlevel 1 (
    echo  ERROR: download failed 3 times. Check the internet and run again.
    pause
    exit /b 1
  )
) else (  echo [2/8] Updating MediFlow to the newest version...
  "%GITBIN%" -C "%ROOT%" fetch origin
  "%GITBIN%" -C "%ROOT%" checkout %BRANCH%
  "%GITBIN%" -C "%ROOT%" pull --ff-only origin %BRANCH%
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

:: ---------- [4] public address via ngrok (proven on this machine before) ----------
:: The website lives on Firebase (public internet) and must reach the API on
:: this PC. ngrok opens an outbound-only line - no router changes, no open
:: ports. Your static domain keeps working, so the address never changes.
:: ngrok runs as a plain process: no services, no permission split, none of
:: the Tailscale daemon trouble.
echo [4/8] Making this PC reachable from anywhere (ngrok tunnel)...
set "NGROK_EXE="
if exist "%SETUPDIR%ngrok.exe" set "NGROK_EXE=%SETUPDIR%ngrok.exe"
if not defined NGROK_EXE if exist "%USERPROFILE%\Desktop\ngrok.exe" set "NGROK_EXE=%USERPROFILE%\Desktop\ngrok.exe"
if not defined NGROK_EXE for /f "delims=" %%n in ('where ngrok 2^>nul') do if not defined NGROK_EXE set "NGROK_EXE=%%n"
if not defined NGROK_EXE (
  echo  ERROR: ngrok.exe not found. Copy it next to this file
  echo  - you already have it on the Desktop - and run again.
  pause
  exit /b 1
)
echo       Found ngrok.
if not defined NGROK_DOMAIN (
  echo.
  echo  Your public name, kept forever. Press Enter to accept
  echo  [imagerial-unconflictive-faviola.ngrok-free.dev]:
  set /p "NGROK_DOMAIN=  Domain: "
  if not defined NGROK_DOMAIN set "NGROK_DOMAIN=imagerial-unconflictive-faviola.ngrok-free.dev"
)
if not exist "%SETUPDIR%ngrok.yml" (
  echo.
  echo  ONE-TIME step: paste your ngrok authtoken.
  echo  Find it at dashboard.ngrok.com, top-left, Your Authtoken.
  echo  Copy the whole token, paste here, Enter. Asked once ever.
  set /p "NGROK_TOKEN=  Authtoken: "
  if not defined NGROK_TOKEN (
    echo  ERROR: authtoken is required once. Run again when you have it.
    pause
    exit /b 1
  )
  (
  echo version: 3
  echo authtoken: !NGROK_TOKEN!
  ) > "%SETUPDIR%ngrok.yml"
  set "NGROK_TOKEN="
  echo       Saved next to this file, never uploaded anywhere.
)

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
echo set "NGROK_DOMAIN=!NGROK_DOMAIN!"
) > "%SETUPDIR%server.env.bat"
echo       Saved. Secrets live ONLY in this folder, never on the internet.

:: ---------- [6] build the servers (website builds on the developer PC) ----------
echo.
echo [6/8] Building the program (a minute or two)...
call npm --prefix "%ROOT%" run build --workspace @mediflow/api
if errorlevel 1 goto builderror
call npm --prefix "%ROOT%" run build --workspace @mediflow/baileys-gateway
if errorlevel 1 goto builderror
goto buildok
:builderror
echo  ERROR: build failed. Send a photo of the red lines above.
pause
exit /b 1
:buildok
echo       Build OK.

:: ---------- runners (restart themselves if anything stops) ----------
call :writerunner "run-api.bat" "apps\api" "dist\index.js" "api.log" "PORT=4000" "GATEWAY_URL=http://localhost:10000"
call :writerunner "run-gateway.bat" "apps\baileys-gateway" "dist\index.js" "gateway.log" "PORT=10000" "GATEWAY_CONFIG=%ROOT%\gateway-config.json"

:: Ngrok runner: publishes localhost:4000 as https://<your-domain> for the
:: Firebase website to call. Restart-loop like the rest; a static domain
:: means the address survives every restart and every rerun.
(
echo @echo off
echo :loop
echo "%NGROK_EXE%" http --config="%SETUPDIR%ngrok.yml" --url=%NGROK_DOMAIN% 4000 ^>^> "%SETUPDIR%logs\ngrok.log" 2^>^&1
echo timeout /t 30 /nobreak ^>nul
echo goto loop
) > "%SETUPDIR%run-ngrok.bat"

:: ---------- [7] auto-start tasks (back after every reboot, no login) ----------
echo.
echo [7/8] Registering auto-start...
call :registertask "MediFlowAPI" "run-api.bat"
call :registertask "MediFlowGateway" "run-gateway.bat"
call :registertask "MediFlowNgrok" "run-ngrok.bat"
schtasks /Delete /TN "MediFlowFunnel" /F >nul 2>&1
schtasks /Delete /TN "MediFlowWeb" /F >nul 2>&1

:: ---------- publish the API address (static domain: known, not discovered) ----------
echo.
echo [7/8] Publishing the public address...
set "PUBLIC_URL=https://%NGROK_DOMAIN%"
echo !PUBLIC_URL! > "%SETUPDIR%public-url.txt"
schtasks /Run /TN "MediFlowNgrok" >nul 2>&1
set "NGROK_TRIES=0"
:ngrokverify
for /f "delims=" %%c in ('curl -s --max-time 15 -o nul -w "%%{http_code}" "!PUBLIC_URL!/health" 2^>nul') do set "HCODE=%%c"
if "!HCODE!"=="200" goto ngrokok
set /a NGROK_TRIES+=1
if !NGROK_TRIES! GEQ 8 (
  echo  WARNING: tunnel not answering yet - continuing anyway, doctors next.
  echo  If the site cannot reach the API later, open logs\ngrok.log:
  echo  a domain error there means the name is taken - pick another at
  echo  dashboard.ngrok.com under Static Domains and run again.
  goto ngrokok
)
echo       Waiting for tunnel (!NGROK_TRIES!/8)...
timeout /t 15 /nobreak >nul
goto ngrokverify
:ngrokok
echo       Public address: !PUBLIC_URL!
echo       It never changes. The website already points at it.

:: ---------- stop anything squatting our ports, then start now ----------
echo.
echo [8/8] Starting everything now...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 4000,10000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
schtasks /Run /TN "MediFlowAPI" >nul 2>&1
schtasks /Run /TN "MediFlowGateway" >nul 2>&1
schtasks /Run /TN "MediFlowNgrok" >nul 2>&1
timeout /t 20 /nobreak >nul

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
echo   DONE! Your clinic is online.
echo.
echo   Website (phone, 3G, WiFi, anywhere):
echo     https://mediflow-baalbeck.web.app
echo   It reaches this PC through your public address, saved in:
echo     public-url.txt (next to this file - already sent to developer)
echo.
echo   Each doctor logs in, opens the WhatsApp tab once, scans
echo   the QR with the clinic phone - afterwards it only says linked.
echo   If the connection drops, the QR comes back by itself.
echo.
echo   Booking test from any phone, send to a clinic number:
echo     "badi ehjz bokra" - answer the follow-up - yes,
echo     then approve it on the calendar with one tap.
echo   After a reboot everything returns alone: tasks + disk sessions.
echo  ============================================================
echo.
start "" "https://mediflow-baalbeck.web.app"
pause
exit /b 0

:: ================= helpers =================
:loadsecrets
if exist "%SETUPDIR%server.env.bat" call "%SETUPDIR%server.env.bat"
exit /b 0

:ensuregit
:: Already handled by a previous run: portable Git waiting next to this file.
if exist "%SETUPDIR%PortableGit\cmd\git.exe" (
  set "GITBIN=%SETUPDIR%PortableGit\cmd\git.exe"
  exit /b 0
)
where winget >nul 2>&1
if %errorlevel% equ 0 (
  echo [1/8] Installing Git with winget...
  winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
where git >nul 2>&1
if %errorlevel% equ 0 exit /b 0
echo [1/8] Winget did not work - downloading portable Git directly, one time...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=(Invoke-RestMethod -UseBasicParsing https://api.github.com/repos/git-for-windows/git/releases/latest).tag_name; $v=$t.TrimStart('v') -replace '\.windows\.\d+$',''; $u='https://github.com/git-for-windows/git/releases/download/'+$t+'/PortableGit-'+$v+'-64-bit.7z.exe'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile '%SETUPDIR%PortableGit-installer.exe'"
if errorlevel 1 exit /b 1
"%SETUPDIR%PortableGit-installer.exe" -o"%SETUPDIR%PortableGit" -y >nul
del "%SETUPDIR%PortableGit-installer.exe" >nul 2>&1
if not exist "%SETUPDIR%PortableGit\cmd\git.exe" exit /b 1
set "GITBIN=%SETUPDIR%PortableGit\cmd\git.exe"
exit /b 0

:tryclone
set "TRIES=0"
:cloneretry
"%GITBIN%" clone -b %BRANCH% https://github.com/madzopos-ai/mediflow.git "%ROOT%"
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
echo set "HOST=127.0.0.1"
echo set "%~5"
if not "%~6"=="" echo set "%~6"
echo set "DATABASE_FILE=%ROOT%\data\mediflow.db"
echo set "UPLOADS_DIR=%ROOT%\uploads"
echo set "BACKUP_DIR=%ROOT%\backups"
echo set "CORS_ORIGINS=https://mediflow-baalbeck.web.app"
echo set "PUBLIC_WEB_URL=https://mediflow-baalbeck.web.app"
echo set "WHATSAPP_PROVIDER=cloud"
echo set "REMINDER_WORKER_ENABLED=false"
echo set "DEFAULT_TIMEZONE=Asia/Beirut"
echo set "MEDIFLOW_API_URL=http://localhost:4000"
echo set "GOOGLE_APPLICATION_CREDENTIALS=%%FIREBASE_KEY%%"
echo set "FIREBASE_PROJECT_ID=%%GW_PROJECT_ID%%"
echo set "FIREBASE_SERVICE_ACCOUNT_PATH=%%FIREBASE_KEY%%"
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
