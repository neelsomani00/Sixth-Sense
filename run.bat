@echo off
title Sixth-Sense - Running
cd /d "%~dp0"

set PORT=8000
set PYCMD=python

where python >nul 2>nul
if not %errorlevel%==0 (
    where python3 >nul 2>nul
    if %errorlevel%==0 (
        set PYCMD=python3
    ) else (
        echo Python was not found. Please run setup.bat first.
        pause
        exit /b 1
    )
)

echo ============================================
echo  Starting Sixth-Sense on port %PORT%
echo ============================================
echo.
echo Opening http://localhost:%PORT% in your browser...
echo (Use Chrome or Edge for best webcam / speech support)
echo.
echo Keep this window open while using the app.
echo Close this window (or press Ctrl+C) to stop the server.
echo.

start "" "http://localhost:%PORT%"
%PYCMD% -m http.server %PORT%
