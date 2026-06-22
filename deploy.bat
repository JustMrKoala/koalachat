@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REMOTE_HOST="
set "REMOTE_USER=deploy"
set "REMOTE_DIR=/opt/koalachat"
set "ARCHIVE=koalachat-deploy.tar.gz"

if not "%KOALA_REMOTE_HOST%"=="" set "REMOTE_HOST=%KOALA_REMOTE_HOST%"
if not "%KOALA_REMOTE_USER%"=="" set "REMOTE_USER=%KOALA_REMOTE_USER%"
if not "%KOALA_REMOTE_DIR%"=="" set "REMOTE_DIR=%KOALA_REMOTE_DIR%"

if "%REMOTE_HOST%"=="" (
  echo ERROR: Set KOALA_REMOTE_HOST to your server hostname or IP.
  echo Example: set KOALA_REMOTE_HOST=chat.example.com
  exit /b 1
)

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
  --exclude=".env" ^
  backend frontend docker scripts logo.png docker-compose.yml .dockerignore .env.example LICENSE README.md SECURITY.md
if errorlevel 1 (
  echo ERROR: Failed to create archive.
  exit /b 1
)

echo [3/5] Preparing remote directory...
ssh -o ConnectTimeout=10 %REMOTE_USER%@%REMOTE_HOST% "mkdir -p %REMOTE_DIR%"
if errorlevel 1 (
  echo ERROR: SSH connection failed. Check host, user, and SSH key auth.
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
  echo ERROR: Remote start failed. KoalaChat may not be running on %REMOTE_HOST%.
  echo Check logs: ssh %REMOTE_USER%@%REMOTE_HOST% "cd %REMOTE_DIR% && docker compose logs --tail 80"
  exit /b 1
)

echo.
echo  Deploy complete.
echo  App: https://%REMOTE_HOST%:8999
echo  Verify: curl -sk https://%REMOTE_HOST%:8999/health
echo.
echo  Required:
echo    KOALA_REMOTE_HOST   your server hostname or IP
echo  Optional:
echo    KOALA_REMOTE_USER   default: deploy
echo    KOALA_REMOTE_DIR    default: /opt/koalachat
echo.

endlocal
exit /b 0