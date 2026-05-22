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

update_readme_deploy_time() {
  local readme="README.md"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  if [[ ! -f "$readme" ]]; then
    echo "⚠ README.md not found; could not record deploy time." >&2
    return
  fi

  if grep -q '^Last deploy: ' "$readme"; then
    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/jeopardy-readme.XXXXXX")"
    awk -v timestamp="$timestamp" '
      /^Last deploy: / && !updated { print "Last deploy: " timestamp; updated=1; next }
      { print }
    ' "$readme" > "$tmp"
    mv "$tmp" "$readme"
  else
    printf '\nLast deploy: %s\n' "$timestamp" >> "$readme"
  fi

  echo "✓ Recorded deploy time in README.md: $timestamp"
}

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
  update_readme_deploy_time
else
  echo "✗ Deploy finished but container is not running. Check logs above." >&2
  exit 1
fi

if $FOLLOW_LOGS; then
  echo
  echo "→ Following logs (Ctrl-C to detach)..."
  docker compose logs -f app
fi
