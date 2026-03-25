#!/usr/bin/env bash
set -e

echo
echo "  =========================================="
echo "   Wav Fake Cleaner V2 - Demarrage"
echo "  =========================================="
echo

if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "ERREUR: Dependances non installees."
    echo "Lance d'abord: ./setup.sh"
    exit 1
fi

mkdir -p data

echo "  Backend:   http://localhost:8000"
echo "  API Docs:  http://localhost:8000/docs"
echo "  WebSocket: ws://localhost:8000/ws/logs"
echo
echo "  Ctrl+C pour arreter"
echo "  ------------------------------------------"
echo

python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
