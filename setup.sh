#!/usr/bin/env bash
set -e

echo
echo "  =========================================="
echo "   Wav Fake Cleaner V2 - Installation"
echo "  =========================================="
echo

echo "[1/4] Verification de Python..."
if ! command -v python3 &>/dev/null; then
    echo "ERREUR: Python3 non trouve. Installe Python 3.11+ depuis python.org"
    exit 1
fi
echo "      OK - $(python3 --version)"
echo

echo "[2/4] Installation des dependances Python..."
pip install -r requirements.txt
echo "      OK - Dependances installees"
echo

echo "[3/4] Installation du navigateur Playwright..."
python3 -m playwright install chromium || {
    echo "ATTENTION: Playwright install a echoue, essaie manuellement:"
    echo "  python3 -m playwright install chromium"
}
echo "      OK - Chromium installe"
echo

echo "[4/4] Configuration..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "      OK - Fichier .env cree"
else
    echo "      OK - Fichier .env deja present"
fi
mkdir -p data
echo "      OK - Dossier data cree"
echo

echo "  =========================================="
echo "   Installation terminee !"
echo
echo "   Etape suivante: python3 login.py"
echo "   Puis:           ./start.sh"
echo "  =========================================="
echo
