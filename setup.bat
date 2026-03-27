@echo off
title Wav Fake Cleaner V2 - Installation
setlocal enabledelayedexpansion

echo.
echo  ==========================================
echo   Wav Fake Cleaner V2 - Installation
echo  ==========================================
echo.

:: --- Etape 1 : Python ---
echo  [1/5] Recherche de Python...
py --version >nul 2>&1
if %errorlevel% neq 0 (
    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo       Python non trouve, installation automatique...
        echo.
        echo       Telechargement de Python 3.12...
        curl -L -o "%TEMP%\python_installer.exe" "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe"
        if not exist "%TEMP%\python_installer.exe" (
            echo.
            echo  ==================================================
            echo   ERREUR : Le telechargement a echoue !
            echo.
            echo   Installe Python manuellement :
            echo   1. Va sur https://www.python.org/downloads/
            echo   2. Telecharge Python 3.12 ou plus recent
            echo   3. COCHE "Add Python to PATH" pendant l'install
            echo   4. Relance ce script
            echo  ==================================================
            echo.
            pause
            exit /b 1
        )
        echo       Installation de Python (cela peut prendre 1-2 minutes)...
        "%TEMP%\python_installer.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
        del "%TEMP%\python_installer.exe" >nul 2>&1
        :: Refresh PATH
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python312\;%LOCALAPPDATA%\Programs\Python\Python312\Scripts\;%PATH%"
        py --version >nul 2>&1
        if %errorlevel% neq 0 (
            python --version >nul 2>&1
            if %errorlevel% neq 0 (
                echo.
                echo  ERREUR : L'installation de Python a echoue.
                echo  Installe-le manuellement depuis https://www.python.org/downloads/
                echo  COCHE "Add Python to PATH" !
                echo.
                pause
                exit /b 1
            )
        )
        echo       Python installe avec succes !
    )
)
echo       OK - Python trouve
echo.

:: --- Etape 2 : Node.js ---
echo  [2/5] Recherche de Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo       Node.js non trouve, installation automatique...
    echo.
    echo       Telechargement de Node.js 22 LTS...
    curl -L -o "%TEMP%\node_installer.msi" "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi"
    if not exist "%TEMP%\node_installer.msi" (
        echo.
        echo  ==================================================
        echo   ERREUR : Le telechargement a echoue !
        echo.
        echo   Installe Node.js manuellement :
        echo   1. Va sur https://nodejs.org/
        echo   2. Telecharge la version LTS (bouton vert)
        echo   3. Installe-le (laisse tout par defaut)
        echo   4. Relance ce script
        echo  ==================================================
        echo.
        pause
        exit /b 1
    )
    echo       Installation de Node.js (cela peut prendre 1-2 minutes)...
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    del "%TEMP%\node_installer.msi" >nul 2>&1
    :: Refresh PATH
    set "PATH=C:\Program Files\nodejs\;%PATH%"
    node --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo  ERREUR : L'installation de Node.js a echoue.
        echo  Installe-le manuellement depuis https://nodejs.org/
        echo.
        pause
        exit /b 1
    )
    echo       Node.js installe avec succes !
)
echo       OK - Node.js trouve
echo.

:: --- Etape 3 : Dependances Python ---
echo  [3/5] Installation des dependances Python...
echo       (ca peut prendre 1-2 minutes)
pip install -r requirements.txt >nul 2>&1
if %errorlevel% neq 0 (
    echo  ATTENTION: pip install a echoue, on essaie autrement...
    py -m pip install -r requirements.txt >nul 2>&1
)
echo       OK
echo.

:: --- Etape 4 : Navigateur Playwright ---
echo  [4/5] Installation du navigateur (Chromium)...
echo       (ca peut prendre 2-3 minutes la premiere fois)
python -m playwright install chromium >nul 2>&1
if %errorlevel% neq 0 (
    py -m playwright install chromium >nul 2>&1
)
echo       OK
echo.

:: --- Etape 5 : Frontend ---
echo  [5/5] Installation du frontend...
if exist "frontend\package.json" (
    cd frontend
    npm install >nul 2>&1
    cd ..
)
echo       OK
echo.

:: --- Config ---
if not exist ".env" (
    copy .env.example .env >nul 2>&1
    echo       Fichier .env cree
)
if not exist "data" mkdir data
echo.

echo  ==================================================
echo.
echo   INSTALLATION TERMINEE !
echo.
echo   Prochaines etapes :
echo.
echo   1. Lance :  python login.py
echo      (pour te connecter a Threads)
echo.
echo   2. Puis :   start.bat
echo      (pour lancer l'application)
echo.
echo  ==================================================
echo.
pause
