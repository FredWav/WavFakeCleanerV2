@echo off
title Wav Fake Cleaner V2 - Running

echo.
echo  ==========================================
echo   Wav Fake Cleaner V2 - Demarrage
echo  ==========================================
echo.

pip show fastapi >nul 2>&1
if %errorlevel% neq 0 (
    echo ERREUR: Dependances non installees.
    echo Lance d'abord: setup.bat
    pause
    exit /b 1
)

if not exist "data" mkdir data

echo  Backend:   http://localhost:8000
echo  API Docs:  http://localhost:8000/docs
echo  WebSocket: ws://localhost:8000/ws/logs
echo.
echo  Ctrl+C pour arreter
echo  ------------------------------------------
echo.

python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

pause
