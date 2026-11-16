@echo off
REM Atomix launcher for Windows. Double-click to start.
cd /d "%~dp0"
title Atomix
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
REM winget's PATH change only reaches windows opened after the install, so also look in its folder.
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links"
REM Some winget installs make no Links copy: use the package's own bin folder (e.g. ffmpeg-9.0.2-full_build\bin).
where ffmpeg >nul 2>nul
if errorlevel 1 for /d %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%V in ("%%P\*") do if exist "%%V\bin\ffmpeg.exe" set "PATH=%PATH%;%%V\bin"
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [note] ffmpeg isn't on PATH or in winget's folders. Atomix will look in a few more places;
  echo        if it then says ffmpeg was not found, install it: winget install Gyan.FFmpeg
  echo.
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8787"
node --disable-warning=ExperimentalWarning server.js
pause
