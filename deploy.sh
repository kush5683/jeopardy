#!/usr/bin/env bash
# Routine deploy: rebuild the app image and restart the container.
# Migrations run automatically via the container's CMD (prisma migrate deploy).
#
# Usage:
#   ./deploy.sh             # build + restart app only
#   ./deploy.sh --no-cache  # force a fresh build, ignoring Docker layer cache
#   ./deploy.sh --logs      # follow logs after deploy (Ctrl-C to detach)

set -euo pipefail
cd "$(dirname "$0")"

BUILD_ARGS=()
FOLLOW_LOGS=false
for arg in "$@"; do
  case "$arg" in
    --no-cache) BUILD_ARGS+=(--no-cache) ;;
    --logs|-f) FOLLOW_LOGS=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found in PATH" >&2
  exit 1
fi

echo "→ Ensuring Ollama is running..."
if curl -fsS http://localhost:11434/api/ps >/dev/null 2>&1; then
  echo "✓ Ollama already running."
elif command -v brew >/dev/null 2>&1; then
  brew services start ollama >/dev/null 2>&1 || true
  sleep 1
  if curl -fsS http://localhost:11434/api/ps >/dev/null 2>&1; then
    echo "✓ Ollama started."
  else
    echo "⚠ Could not confirm Ollama is up at localhost:11434; deploy will continue." >&2
  fi
else
  echo "⚠ Homebrew not found; could not auto-start Ollama. Deploy will continue." >&2
fi

if [[ ${#BUILD_ARGS[@]} -gt 0 ]]; then
  echo "→ Building app image (${BUILD_ARGS[*]})..."
  docker compose build "${BUILD_ARGS[@]}" app
else
  echo "→ Building app image..."
  docker compose build app
fi

echo "→ Recreating app container..."
docker compose up -d app

echo "→ Waiting for boot..."
sleep 3

echo "→ Recent logs:"
docker compose logs --tail=25 app

echo
if docker compose ps app --format '{{.State}}' | grep -q running; then
  echo "✓ Deploy complete — app is running."
else
  echo "✗ Deploy finished but container is not running. Check logs above." >&2
  exit 1
fi

if $FOLLOW_LOGS; then
  echo
  echo "→ Following logs (Ctrl-C to detach)..."
  docker compose logs -f app
fi
