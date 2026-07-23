@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ---- Venue Music: double-click launcher for Windows -----------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies ^(first run only, may take a minute^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

REM If the music folder has no audio yet, generate CC0 test tones so it plays.
set "HASMUSIC="
for %%E in (mp3 m4a aac ogg wav flac webm) do (
  if exist "music\*.%%E" set "HASMUSIC=1"
)
if not defined HASMUSIC (
  echo No music found - generating original background tracks ^(takes a moment^)...
  call npm run music
)

echo.
echo   Venue Music is starting at http://127.0.0.1:3100
echo   Keep this window open while you use it. Close it to stop the music.
echo.
start "" http://127.0.0.1:3100
node server.js
