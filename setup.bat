@echo off
chcp 65001 >nul 2>&1
title Wav Fake Cleaner V2 - Installation

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Wav Fake Cleaner V2 - Installation     ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ─── Etape 1 : Python ──────────────────────────────────
echo  [1/5] Recherche de Python...
py --version >nul 2>&1
if %errorlevel% neq 0 (
    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo  ╔══════════════════════════════════════════════════════╗
        echo  ║  ERREUR : Python n'est pas installe !               ║
        echo  ║                                                      ║
        echo  ║  1. Va sur https://www.python.org/downloads/         ║
        echo  ║  2. Telecharge Python 3.11 ou plus recent            ║
        echo  ║  3. COCHE "Add Python to PATH" pendant l'install     ║
        echo  ║  4. Relance ce script apres l'installation           ║
        echo  ╚══════════════════════════════════════════════════════╝
        echo.
        pause
        exit /b 1
    )
)
echo       OK - Python trouve
echo.

:: ─── Etape 2 : Node.js ─────────────────────────────────
echo  [2/5] Recherche de Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ╔══════════════════════════════════════════════════════╗
    echo  ║  ERREUR : Node.js n'est pas installe !              ║
    echo  ║                                                      ║
    echo  ║  1. Va sur https://nodejs.org/                       ║
    echo  ║  2. Telecharge la version LTS (bouton vert)          ║
    echo  ║  3. Installe-le (laisse tout par defaut)             ║
    echo  ║  4. Relance ce script apres l'installation           ║
    echo  ╚══════════════════════════════════════════════════════╝
    echo.
    pause
    exit /b 1
)
echo       OK - Node.js trouve
echo.

:: ─── Etape 3 : Dependances Python ──────────────────────
echo  [3/5] Installation des dependances Python...
echo       (ca peut prendre 1-2 minutes)
pip install -r requirements.txt >nul 2>&1
if %errorlevel% neq 0 (
    echo  ATTENTION: pip install a echoue, on essaie autrement...
    py -m pip install -r requirements.txt >nul 2>&1
)
echo       OK
echo.

:: ─── Etape 4 : Navigateur Playwright ───────────────────
echo  [4/5] Installation du navigateur (Chromium)...
echo       (ca peut prendre 2-3 minutes la premiere fois)
python -m playwright install chromium >nul 2>&1
if %errorlevel% neq 0 (
    py -m playwright install chromium >nul 2>&1
)
echo       OK
echo.

:: ─── Etape 5 : Frontend ────────────────────────────────
echo  [5/5] Installation du frontend...
if exist "frontend\package.json" (
    cd frontend
    npm install >nul 2>&1
    cd ..
)
echo       OK
echo.

:: ─── Config ────────────────────────────────────────────
if not exist ".env" (
    copy .env.example .env >nul 2>&1
    echo       Fichier .env cree
)
if not exist "data" mkdir data
echo.

echo  ╔══════════════════════════════════════════════════════╗
echo  ║                                                      ║
echo  ║   INSTALLATION TERMINEE !                            ║
echo  ║                                                      ║
echo  ║   Prochaines etapes :                                ║
echo  ║                                                      ║
echo  ║   1. Lance :  python login.py                        ║
echo  ║      (pour te connecter a Threads)                   ║
echo  ║                                                      ║
echo  ║   2. Puis :   start.bat                              ║
echo  ║      (pour lancer l'application)                     ║
echo  ║                                                      ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
pause
