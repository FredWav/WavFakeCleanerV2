#!/usr/bin/env bash
set -e

echo
echo "  =========================================="
echo "   Wav Fake Cleaner V2 - Demarrage"
echo "  =========================================="
echo

# --- Verifier les dependances ---
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "  ERREUR : Les dependances ne sont pas installees."
    echo
    echo "  Lance d'abord :  ./setup.sh"
    echo
    exit 1
fi

# --- Verifier la session Threads ---
if [ ! -f "data/storage_state.json" ]; then
    echo "  =================================================="
    echo "   ATTENTION : Tu n'es pas encore connecte a Threads"
    echo
    echo "   On va ouvrir un navigateur pour que tu te connectes."
    echo "   Apres ta connexion, l'appli demarrera."
    echo "  =================================================="
    echo
    python3 login.py
    echo
fi

mkdir -p data

# --- Construire le frontend si pas deja fait ---
if [ ! -f "frontend/dist/index.html" ] && [ -f "frontend/package.json" ]; then
    echo "  Construction du frontend..."
    cd frontend && npm run build --silent && cd ..
    echo "  OK"
    echo
fi

echo "  Demarrage du serveur..."
echo
echo "  -------------------------------------------"
echo
echo "   Dashboard :  http://127.0.0.1:8000"
echo "   API Docs  :  http://127.0.0.1:8000/docs"
echo
echo "   Ctrl+C pour arreter"
echo
echo "  -------------------------------------------"
echo

# --- Ouvrir le navigateur APRES un delai (attendre que le serveur demarre) ---
(
    sleep 3
    if command -v xdg-open &>/dev/null; then
        xdg-open "http://127.0.0.1:8000/" 2>/dev/null
    elif command -v open &>/dev/null; then
        open "http://127.0.0.1:8000/"
    elif command -v sensible-browser &>/dev/null; then
        sensible-browser "http://127.0.0.1:8000/" 2>/dev/null
    elif command -v wslview &>/dev/null; then
        wslview "http://127.0.0.1:8000/"
    fi
) &

# --- Lancer le backend (qui sert aussi le frontend) ---
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
