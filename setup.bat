@echo off
title Sixth-Sense - Setup
echo ============================================
echo  Sixth-Sense - Setup
echo ============================================
echo.
echo Checking for Python (needed to serve this app locally)...
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Python found:
    python --version
    echo.
    echo Setup complete. You can now double-click run.bat to start the app.
    goto :end
)

where python3 >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Python3 found:
    python3 --version
    echo.
    echo Setup complete. You can now double-click run.bat to start the app.
    goto :end
)

echo [MISSING] Python was not found on this machine.
echo.
echo This app has no other dependencies - it just needs Python to run a
echo local web server (webcam access and JS modules require a real server,
echo not a plain double-clicked HTML file).
echo.
echo Please install Python from https://www.python.org/downloads/
echo During install, make sure to check "Add Python to PATH".
echo.
echo Then run this setup.bat again.

:end
echo.
pause
