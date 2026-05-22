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
DEPLOY_TIMESTAMP=""
README_HOSTED_LINE="Hosted at: https://jeopardy.kushshah.net"
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

# Function: update_readme_deploy_time
# Parameters:
#   None.
# Output:
#   No return value; updates README.md in place and writes the UTC timestamp into
#   the global DEPLOY_TIMESTAMP string for later git commit/push handling.
# Data transformations:
#   Converts the current UTC time into a stable "YYYY-MM-DD HH:MM:SS UTC"
#   string, then either replaces the existing "Last deploy:" line with awk or
#   appends a new line when the marker is absent. Ensures the public hosted URL
#   stays in README.md without exposing internal deployment details.
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

  if ! grep -qxF "$README_HOSTED_LINE" "$readme"; then
    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/jeopardy-readme.XXXXXX")"
    awk -v hosted_line="$README_HOSTED_LINE" '
      /^Last deploy: / && !inserted { print; print hosted_line; inserted=1; next }
      { print }
      END { if (!inserted) print hosted_line }
    ' "$readme" > "$tmp"
    mv "$tmp" "$readme"
  fi

  DEPLOY_TIMESTAMP="$timestamp"
  echo "✓ Recorded deploy time in README.md: $timestamp"
}

# Function: commit_and_push_deploy_time
# Parameters:
#   $1 (string): UTC timestamp produced by update_readme_deploy_time; empty
#   values skip the git commit/push path.
# Output:
#   No return value; may create and push a git commit containing README.md when
#   that file has deploy-time changes.
# Data transformations:
#   Treats the timestamp as commit-message text, validates git/worktree
#   availability, checks whether README.md changed, then stages the file through
#   git commit's pathspec and pushes the resulting commit.
commit_and_push_deploy_time() {
  local readme="README.md"
  local timestamp="$1"

  if [[ -z "$timestamp" ]]; then
    echo "⚠ Deploy time was not recorded; skipping commit and push." >&2
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "⚠ git not found in PATH; deploy time was not committed." >&2
    return
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "⚠ Not inside a git work tree; deploy time was not committed." >&2
    return
  fi

  if git diff --quiet -- "$readme" && git diff --cached --quiet -- "$readme"; then
    echo "✓ Deploy time is already committed."
    return
  fi

  echo "→ Committing deploy time..."
  git commit -m "Record deploy time $timestamp" -- "$readme"

  echo "→ Pushing deploy time commit..."
  git push

  echo "✓ Deploy time commit pushed."
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
  commit_and_push_deploy_time "$DEPLOY_TIMESTAMP"
else
  echo "✗ Deploy finished but container is not running. Check logs above." >&2
  exit 1
fi

if $FOLLOW_LOGS; then
  echo
  echo "→ Following logs (Ctrl-C to detach)..."
  docker compose logs -f app
fi
