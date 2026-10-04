@echo off
rem Double-click to start everything. See start.ps1.
title Playwright AI Studio - Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
echo.
pause
