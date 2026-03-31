#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "── PRE Startup ─────────────────────────"

# 1. Check Redis
if ! redis-cli ping > /dev/null 2>&1; then
  echo "Starting Redis..."
  redis-server --daemonize yes --logfile "$PROJECT_ROOT/.pre-redis.log"
  sleep 1
else
  echo "✓ Redis already running"
fi

# 2. Check Ollama
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "Starting Ollama..."
  ollama serve > "$PROJECT_ROOT/.pre-ollama.log" 2>&1 &
  sleep 2
else
  echo "✓ Ollama already running"
fi

# 3. Check model is pulled
if ! ollama list | grep -q "llama3.1:8b"; then
  echo "Pulling llama3.1:8b (this takes a few minutes the first time)..."
  ollama pull llama3.1:8b
else
  echo "✓ llama3.1:8b available"
fi

# 4. Check sidecar venv
if [ ! -f "$PROJECT_ROOT/sidecar/.venv/bin/python3" ]; then
  echo "Setting up Python venv..."
  cd "$PROJECT_ROOT/sidecar"
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  deactivate
  cd "$PROJECT_ROOT"
else
  echo "✓ Python venv ready"
fi

# 5. Run database migration
echo "Running database migrations..."
cd "$PROJECT_ROOT"
pnpm --filter @pre/memory db:migrate
echo "✓ Database ready"

# 6. Start gateway (foreground — user sees logs)
echo ""
echo "Starting PRE gateway..."
echo "Press Ctrl+C to stop."
echo "────────────────────────────────────────"
cd "$PROJECT_ROOT/apps/gateway"
pnpm dev
