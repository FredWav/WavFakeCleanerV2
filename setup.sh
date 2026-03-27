#!/usr/bin/env bash
set -e

echo
echo "  =========================================="
echo "   Wav Fake Cleaner V2 - Installation"
echo "  =========================================="
echo

# Detect OS
IS_MAC=false
IS_LINUX=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    IS_MAC=true
else
    IS_LINUX=true
fi

# --- Etape 1 : Python ---
echo "[1/5] Recherche de Python..."
if ! command -v python3 &>/dev/null; then
    echo "      Python3 non trouve, installation automatique..."
    echo
    if $IS_MAC; then
        # macOS: try brew first
        if command -v brew &>/dev/null; then
            echo "      Installation via Homebrew..."
            brew install python3
        else
            echo "      Homebrew non trouve, installation de Homebrew puis Python..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            # Add brew to PATH for this session
            if [ -f "/opt/homebrew/bin/brew" ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [ -f "/usr/local/bin/brew" ]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
            brew install python3
        fi
    else
        # Linux: detect package manager
        if command -v apt &>/dev/null; then
            echo "      Installation via apt..."
            sudo apt update -qq
            sudo apt install -y python3 python3-pip python3-venv
        elif command -v dnf &>/dev/null; then
            echo "      Installation via dnf..."
            sudo dnf install -y python3 python3-pip
        elif command -v pacman &>/dev/null; then
            echo "      Installation via pacman..."
            sudo pacman -Sy --noconfirm python python-pip
        else
            echo
            echo "  ERREUR : Impossible d'installer Python automatiquement."
            echo "  Installe Python3 manuellement puis relance ce script."
            echo "  https://www.python.org/downloads/"
            echo
            exit 1
        fi
    fi
    # Verify
    if ! command -v python3 &>/dev/null; then
        echo
        echo "  ERREUR : L'installation de Python a echoue."
        echo "  Installe Python3 manuellement puis relance ce script."
        echo
        exit 1
    fi
    echo "      Python installe avec succes !"
fi
echo "      OK - $(python3 --version)"
echo

# --- Etape 2 : Node.js ---
echo "[2/5] Recherche de Node.js..."
if ! command -v node &>/dev/null; then
    echo "      Node.js non trouve, installation automatique..."
    echo
    if $IS_MAC; then
        if command -v brew &>/dev/null; then
            echo "      Installation via Homebrew..."
            brew install node
        else
            echo
            echo "  ERREUR : Homebrew requis pour installer Node.js sur macOS."
            echo "  Installe Node.js manuellement : https://nodejs.org/"
            echo
            exit 1
        fi
    else
        # Linux: use NodeSource for up-to-date version
        if command -v apt &>/dev/null; then
            echo "      Installation via NodeSource (Node 22 LTS)..."
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt install -y nodejs
        elif command -v dnf &>/dev/null; then
            echo "      Installation via dnf..."
            sudo dnf install -y nodejs npm
        elif command -v pacman &>/dev/null; then
            echo "      Installation via pacman..."
            sudo pacman -Sy --noconfirm nodejs npm
        else
            echo
            echo "  ERREUR : Impossible d'installer Node.js automatiquement."
            echo "  Installe Node.js manuellement : https://nodejs.org/"
            echo
            exit 1
        fi
    fi
    # Verify
    if ! command -v node &>/dev/null; then
        echo
        echo "  ERREUR : L'installation de Node.js a echoue."
        echo "  Installe-le manuellement : https://nodejs.org/"
        echo
        exit 1
    fi
    echo "      Node.js installe avec succes !"
fi
echo "      OK - Node $(node --version)"
echo

# --- Etape 3 : Dependances Python ---
echo "[3/5] Installation des dependances Python..."
echo "      (ca peut prendre 1-2 minutes)"
pip3 install -r requirements.txt -q
echo "      OK"
echo

# --- Etape 4 : Navigateur Playwright ---
echo "[4/5] Installation du navigateur (Chromium)..."
echo "      (ca peut prendre 2-3 minutes la premiere fois)"
python3 -m playwright install chromium 2>/dev/null || true
echo "      OK"
echo

# --- Etape 5 : Frontend ---
echo "[5/5] Installation du frontend..."
if [ -f "frontend/package.json" ]; then
    cd frontend && npm install --silent && cd ..
fi
echo "      OK"
echo

# --- Config ---
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "      Fichier .env cree"
fi
mkdir -p data

echo
echo "  =================================================="
echo
echo "   INSTALLATION TERMINEE !"
echo
echo "   Prochaines etapes :"
echo
echo "   1. Lance :  python3 login.py"
echo "      (pour te connecter a Threads)"
echo
echo "   2. Puis :   ./start.sh"
echo "      (pour lancer l'application)"
echo
echo "  =================================================="
echo
