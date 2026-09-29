@echo off
REM NodeFlix launcher for Windows. Double-click to start.
cd /d "%~dp0"
title NodeFlix
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [warning] ffmpeg was not found. MKV/HEVC files will not play until you install it:
  echo           winget install Gyan.FFmpeg     then close and reopen this window.
  echo.
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8787"
node --disable-warning=ExperimentalWarning server.js
pause
