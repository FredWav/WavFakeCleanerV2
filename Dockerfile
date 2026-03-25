# ── Stage 1: Frontend build ─────────────────────────
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python backend ────────────────────────
FROM python:3.11-slim
WORKDIR /app

# System deps for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    libcairo2 libxshmfence1 libx11-xcb1 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .
RUN playwright install chromium

COPY backend/ ./backend/
COPY alembic/ ./alembic/
COPY alembic.ini ./
COPY .env.example ./.env

# Copy built frontend
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Serve frontend static from FastAPI (prod addition)
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
