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
where py >nul 2>&1 && (set "PY=py" & goto :python_ok)
where python >nul 2>&1 && (set "PY=python" & goto :python_ok)

echo       Python non trouve. Installation automatique...
echo.

:: Methode 1 : winget (Windows 10/11 natif)
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo       Installation via winget...
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    if %errorlevel% equ 0 (
        echo       Python installe ! Redemarrage du PATH...
        :: Refresh PATH
        for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"
        goto :python_check2
    )
)

:: Methode 2 : PowerShell download
echo       Telechargement via PowerShell...
powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile '%TEMP%\python_installer.exe' }" 2>nul
if exist "%TEMP%\python_installer.exe" (
    echo       Installation de Python 3.12...
    echo       (une fenetre d'installation va s'ouvrir)
    "%TEMP%\python_installer.exe" InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
    del "%TEMP%\python_installer.exe" >nul 2>&1
    goto :python_check2
)

:: Methode 3 : Guide manuel
echo.
echo  ==================================================
echo   Python n'a pas pu etre installe automatiquement.
echo.
echo   Installe-le manuellement :
echo   1. Va sur https://www.python.org/downloads/
echo   2. Telecharge Python 3.12 ou plus recent
echo   3. COCHE "Add Python to PATH" pendant l'install
echo   4. Relance ce script
echo  ==================================================
echo.
pause
exit /b 1

:python_check2
:: Re-check after install
where py >nul 2>&1 && (set "PY=py" & goto :python_ok)
where python >nul 2>&1 && (set "PY=python" & goto :python_ok)
echo.
echo  Python a ete installe mais le PATH n'est pas mis a jour.
echo  FERME cette fenetre et RELANCE setup.bat
echo.
pause
exit /b 1

:python_ok
echo       OK - Python trouve
echo.

:: --- Etape 2 : Node.js ---
echo  [2/5] Recherche de Node.js...
where node >nul 2>&1
if %errorlevel% equ 0 goto :node_ok

echo       Node.js non trouve. Installation automatique...
echo.

:: Methode 1 : winget
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo       Installation via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% equ 0 (
        echo       Node.js installe ! Redemarrage du PATH...
        for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"
        set "PATH=C:\Program Files\nodejs\;%PATH%"
        goto :node_check2
    )
)

:: Methode 2 : PowerShell download
echo       Telechargement via PowerShell...
powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi' -OutFile '%TEMP%\node_installer.msi' }" 2>nul
if exist "%TEMP%\node_installer.msi" (
    echo       Installation de Node.js 22 LTS...
    echo       (une fenetre d'installation va s'ouvrir)
    msiexec /i "%TEMP%\node_installer.msi"
    del "%TEMP%\node_installer.msi" >nul 2>&1
    set "PATH=C:\Program Files\nodejs\;%PATH%"
    goto :node_check2
)

:: Methode 3 : Guide manuel
echo.
echo  ==================================================
echo   Node.js n'a pas pu etre installe automatiquement.
echo.
echo   Installe-le manuellement :
echo   1. Va sur https://nodejs.org/
echo   2. Telecharge la version LTS (bouton vert)
echo   3. Installe-le (laisse tout par defaut)
echo   4. Relance ce script
echo  ==================================================
echo.
pause
exit /b 1

:node_check2
where node >nul 2>&1
if %errorlevel% equ 0 goto :node_ok
echo.
echo  Node.js a ete installe mais le PATH n'est pas mis a jour.
echo  FERME cette fenetre et RELANCE setup.bat
echo.
pause
exit /b 1

:node_ok
echo       OK - Node.js trouve
echo.

:: --- Etape 3 : Dependances Python ---
echo  [3/5] Installation des dependances Python...
echo       (ca peut prendre 1-2 minutes)
%PY% -m pip install -r requirements.txt -q 2>nul
if %errorlevel% neq 0 (
    pip install -r requirements.txt -q 2>nul
)
echo       OK
echo.

:: --- Etape 4 : Navigateur Playwright ---
echo  [4/5] Installation du navigateur (Chromium)...
echo       (ca peut prendre 2-3 minutes la premiere fois)
%PY% -m playwright install chromium >nul 2>&1
echo       OK
echo.

:: --- Etape 5 : Frontend ---
echo  [5/5] Installation du frontend...
if exist "frontend\package.json" (
    cd frontend
    call npm install >nul 2>&1
    cd ..
)
echo       OK
echo.

:: --- Config ---
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul 2>&1
        echo       Fichier .env cree
    )
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
