#!/usr/bin/env bash
set -e

echo
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   Wav Fake Cleaner V2 - Installation     ║"
echo "  ╚══════════════════════════════════════════╝"
echo

# ─── Etape 1 : Python ──────────────────────────────────
echo "[1/5] Recherche de Python..."
if ! command -v python3 &>/dev/null; then
    echo
    echo "  ERREUR : Python3 n'est pas installe !"
    echo
    echo "  Sur Ubuntu/Debian :  sudo apt install python3 python3-pip"
    echo "  Sur macOS :          brew install python"
    echo "  Ou :                 https://www.python.org/downloads/"
    echo
    exit 1
fi
echo "      OK - $(python3 --version)"
echo

# ─── Etape 2 : Node.js ──────────────────────────────────
echo "[2/5] Recherche de Node.js..."
if ! command -v node &>/dev/null; then
    echo
    echo "  ERREUR : Node.js n'est pas installe !"
    echo
    echo "  Sur Ubuntu/Debian :  sudo apt install nodejs npm"
    echo "  Sur macOS :          brew install node"
    echo "  Ou :                 https://nodejs.org/"
    echo
    exit 1
fi
echo "      OK - Node $(node --version)"
echo

# ─── Etape 3 : Dependances Python ──────────────────────
echo "[3/5] Installation des dependances Python..."
echo "      (ca peut prendre 1-2 minutes)"
pip3 install -r requirements.txt -q
echo "      OK"
echo

# ─── Etape 4 : Navigateur Playwright ───────────────────
echo "[4/5] Installation du navigateur (Chromium)..."
echo "      (ca peut prendre 2-3 minutes la premiere fois)"
python3 -m playwright install chromium 2>/dev/null || true
echo "      OK"
echo

# ─── Etape 5 : Frontend ─────────────────────────────────
echo "[5/5] Installation du frontend..."
if [ -f "frontend/package.json" ]; then
    cd frontend && npm install --silent && cd ..
fi
echo "      OK"
echo

# ─── Config ─────────────────────────────────────────────
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "      Fichier .env cree"
fi
mkdir -p data

echo
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║                                                      ║"
echo "  ║   INSTALLATION TERMINEE !                            ║"
echo "  ║                                                      ║"
echo "  ║   Prochaines etapes :                                ║"
echo "  ║                                                      ║"
echo "  ║   1. Lance :  python3 login.py                       ║"
echo "  ║      (pour te connecter a Threads)                   ║"
echo "  ║                                                      ║"
echo "  ║   2. Puis :   ./start.sh                             ║"
echo "  ║      (pour lancer l'application)                     ║"
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo
