@echo off
setlocal
cd /d "%~dp0"

echo Building client...
call npm --prefix client run build
if errorlevel 1 (
  echo Client build failed - see errors above.
  pause
  exit /b 1
)

echo Building server...
call npm --prefix server run build
if errorlevel 1 (
  echo Server build failed - see errors above.
  pause
  exit /b 1
)

echo.
echo Starting ClearPath AI...
echo Once you see "listening on http://127.0.0.1:4000", open that URL in your browser.
echo Close this window (or press Ctrl+C) to stop the server.
echo.
node server\dist\index.js

echo.
echo Server stopped.
pause
