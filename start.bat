@echo off
title Wav Fake Cleaner V2
setlocal enabledelayedexpansion

echo.
echo  ==========================================
echo   Wav Fake Cleaner V2 - Demarrage
echo  ==========================================
echo.

:: --- Trouver Python ---
where py >nul 2>&1 && (set "PY=py" & goto :py_ok)
where python >nul 2>&1 && (set "PY=python" & goto :py_ok)
echo  ERREUR : Python non trouve. Lance d'abord setup.bat
pause
exit /b 1
:py_ok

:: --- Verifier les dependances ---
%PY% -c "import fastapi" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERREUR : Les dependances ne sont pas installees.
    echo.
    echo  Lance d'abord :  setup.bat
    echo.
    pause
    exit /b 1
)

:: --- Verifier la session Threads ---
if not exist "data\storage_state.json" (
    echo  ==================================================
    echo   ATTENTION : Tu n'es pas encore connecte a Threads
    echo.
    echo   On va ouvrir un navigateur pour que tu te connectes.
    echo   Apres ta connexion, l'appli demarrera.
    echo  ==================================================
    echo.
    %PY% login.py
    if %errorlevel% neq 0 (
        echo  ERREUR : La connexion a echoue.
        pause
        exit /b 1
    )
    echo.
)

if not exist "data" mkdir data

:: --- Construire le frontend si pas deja fait ---
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

echo  Demarrage du serveur...
echo.
echo  -------------------------------------------
echo.
echo   Dashboard :  http://127.0.0.1:8000
echo   API Docs  :  http://127.0.0.1:8000/docs
echo.
echo   Ctrl+C pour arreter
echo.
echo  -------------------------------------------
echo.

:: --- Ouvrir le navigateur APRES un delai (attendre le serveur) ---
start /b cmd /c "ping -n 4 127.0.0.1 >nul && start http://127.0.0.1:8000/"

:: --- Lancer le backend (qui sert aussi le frontend) ---
%PY% -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

pause
