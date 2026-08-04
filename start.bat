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
echo Your PC's IPv4 addresses (look for your Wi-Fi/LAN adapter's, ignore 127.0.0.1):
ipconfig | findstr /R /C:"IPv4 Address"
echo.
echo Starting ClearPath AI...
echo   - On this PC:            http://127.0.0.1:4000
echo   - On phone/tablet (same Wi-Fi): http://THE-IP-ABOVE:4000
echo If this is the first run, Windows Firewall may prompt to allow node.exe
echo through the firewall - choose "Private networks" only, then Allow.
echo Close this window (or press Ctrl+C) to stop the server.
echo.
set HOST=0.0.0.0
node server\dist\index.js

echo.
echo Server stopped.
pause
