@echo off
title Wav Fake Cleaner V2 - Installation

echo.
echo  ==========================================
echo   Wav Fake Cleaner V2 - Installation
echo  ==========================================
echo.

echo [1/4] Verification de Python...
py --version >nul 2>&1
if %errorlevel% neq 0 (
    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo ERREUR: Python non trouve. Installe Python 3.11+ depuis python.org
        pause
        exit /b 1
    )
)
echo       OK - Python trouve
echo.

echo [2/4] Installation des dependances Python...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo ERREUR: pip install a echoue
    pause
    exit /b 1
)
echo       OK - Dependances installees
echo.

echo [3/4] Installation du navigateur Playwright...
python -m playwright install chromium
if %errorlevel% neq 0 (
    echo ATTENTION: Playwright install a echoue, essaie manuellement:
    echo   python -m playwright install chromium
)
echo       OK - Chromium installe
echo.

echo [4/4] Configuration...
if not exist ".env" (
    copy .env.example .env >nul 2>&1
    echo       OK - Fichier .env cree
) else (
    echo       OK - Fichier .env deja present
)
if not exist "data" mkdir data
echo       OK - Dossier data cree
echo.

echo  ==========================================
echo   Installation terminee !
echo.
echo   Etape suivante: python login.py
echo   Puis:           start.bat
echo  ==========================================
echo.
pause
