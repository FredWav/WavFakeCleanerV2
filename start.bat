@echo off
chcp 65001 >nul 2>&1
title Wav Fake Cleaner V2

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Wav Fake Cleaner V2 - Demarrage        ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ─── Verifier les dependances ───────────────────────────
pip show fastapi >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERREUR : Les dependances ne sont pas installees.
    echo.
    echo  Lance d'abord :  setup.bat
    echo.
    pause
    exit /b 1
)

:: ─── Verifier la session Threads ────────────────────────
if not exist "data\storage_state.json" (
    echo  ╔══════════════════════════════════════════════════════╗
    echo  ║  ATTENTION : Tu n'es pas encore connecte a Threads ! ║
    echo  ║                                                      ║
    echo  ║  On va ouvrir un navigateur pour que tu te connectes.║
    echo  ║  Apres ta connexion, l'appli demarrera.              ║
    echo  ╚══════════════════════════════════════════════════════╝
    echo.
    python login.py
    if %errorlevel% neq 0 (
        echo  ERREUR : La connexion a echoue.
        pause
        exit /b 1
    )
    echo.
)

if not exist "data" mkdir data

echo  Demarrage du backend...
echo.
echo  ┌─────────────────────────────────────────────┐
echo  │                                              │
echo  │   Dashboard :  http://localhost:8000          │
echo  │   API Docs  :  http://localhost:8000/docs     │
echo  │                                              │
echo  │   Ctrl+C pour arreter                        │
echo  │                                              │
echo  └─────────────────────────────────────────────┘
echo.

:: ─── Construire le frontend si pas deja fait ────────────
if not exist "frontend\dist\index.html" (
    if exist "frontend\package.json" (
        echo  Construction du frontend...
        cd frontend
        call npm run build >nul 2>&1
        cd ..
        echo  OK
        echo.
    )
)

:: ─── Lancer le backend (qui sert aussi le frontend) ────
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

pause
