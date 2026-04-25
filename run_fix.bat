@echo off
setlocal enabledelayedexpansion
cd /d "c:\Users\kevin\Documents\Projects\pirate-game-4"
python.exe fix_wss.py
exit /b %ERRORLEVEL%
