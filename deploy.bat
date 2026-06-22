@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REMOTE_HOST=enterlanip"
set "REMOTE_USER=server"
set "REMOTE_DIR=/home/server/koalachat"
set "ARCHIVE=koalachat-deploy.tar.gz"

if not "%KOALA_REMOTE_HOST%"=="" set "REMOTE_HOST=%KOALA_REMOTE_HOST%"
if not "%KOALA_REMOTE_USER%"=="" set "REMOTE_USER=%KOALA_REMOTE_USER%"
if not "%KOALA_REMOTE_DIR%"=="" set "REMOTE_DIR=%KOALA_REMOTE_DIR%"

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo.
echo  KoalaChat Deploy
echo  Target: %REMOTE_USER%@%REMOTE_HOST%:%REMOTE_DIR%
echo.

where ssh >nul 2>&1
if errorlevel 1 (
  echo ERROR: OpenSSH client not found. Install via Settings ^> Apps ^> Optional Features ^> OpenSSH Client
  exit /b 1
)

where scp >nul 2>&1
if errorlevel 1 (
  echo ERROR: scp not found. Install OpenSSH Client.
  exit /b 1
)

where tar >nul 2>&1
if errorlevel 1 (
  echo ERROR: tar not found. Requires Windows 10+ built-in tar.
  exit /b 1
)

echo [1/5] Syncing logo assets...
python scripts\generate_icons.py
if errorlevel 1 (
  echo ERROR: Failed to sync logo.png to frontend/icons/.
  exit /b 1
)

echo [2/5] Creating deployment archive...
if exist "%ARCHIVE%" del /f "%ARCHIVE%"
tar -czf "%ARCHIVE%" ^
  --exclude="__pycache__" ^
  --exclude="*.pyc" ^
  --exclude="terminals" ^
  --exclude="certs" ^
  --exclude="*.pem" ^
  --exclude=".git" ^
  --exclude=".venv" ^
  --exclude="venv" ^
  backend frontend docker scripts logo.png docker-compose.yml .dockerignore .env.example LICENSE README.md
if errorlevel 1 (
  echo ERROR: Failed to create archive.
  exit /b 1
)

echo [3/5] Preparing remote directory...
ssh -o ConnectTimeout=10 %REMOTE_USER%@%REMOTE_HOST% "mkdir -p %REMOTE_DIR%"
if errorlevel 1 (
  echo ERROR: SSH connection failed. Check host, user, and key/password auth.
  del /f "%ARCHIVE%" 2>nul
  exit /b 1
)

echo [4/5] Uploading via SCP...
scp -o ConnectTimeout=30 "%ARCHIVE%" %REMOTE_USER%@%REMOTE_HOST%:%REMOTE_DIR%/
if errorlevel 1 (
  echo ERROR: SCP upload failed.
  del /f "%ARCHIVE%" 2>nul
  exit /b 1
)

echo [5/5] Stopping old server and starting fresh...
ssh %REMOTE_USER%@%REMOTE_HOST% "cd %REMOTE_DIR% && tar -xzf %ARCHIVE% && chmod +x scripts/remote-start.sh && sh scripts/remote-start.sh"
set "DEPLOY_EXIT=%ERRORLEVEL%"

del /f "%ARCHIVE%" 2>nul

if not "%DEPLOY_EXIT%"=="0" (
  echo.
  echo ERROR: Remote docker compose failed. Ensure Docker is installed on %REMOTE_HOST%.
  exit /b 1
)

echo.
echo  Deploy complete.
echo  App: https://%REMOTE_HOST%:8999
echo.
echo  Override defaults with environment variables:
echo    KOALA_REMOTE_USER   (default: server)
echo    KOALA_REMOTE_HOST   (default: 192.168.178.111)
echo    KOALA_REMOTE_DIR    (default: /home/server/koalachat)
echo.

endlocal
exit /b 0
