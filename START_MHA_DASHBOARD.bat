@echo off
setlocal
cd /d "%~dp0"
title MHA Grievance Department Workspace

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.19+ or 22.12+, then run this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dashboard dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Check your network connection and try again.
    pause
    exit /b 1
  )
)

echo Starting the MHA Grievance Department Workspace...
start "MHA Dashboard" http://localhost:5173
call npm run dev -- --host 127.0.0.1
pause

