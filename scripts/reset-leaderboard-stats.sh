#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

YES=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/reset-leaderboard-stats.sh [--dry-run] [--yes]

Resets leaderboard/stat history by clearing:
  - ClueResponse     global/friends leaderboard totals and accuracy
  - BuzzerSession    best Coryat and recent buzzer history
  - DailyAttempt     daily leaderboard and daily stats

Leaves users, friendships, clues, flashcards, review schedules, boards, rooms,
and settings intact.

Connection:
  - If DATABASE_URL is set and psql is installed, the script uses that.
  - Otherwise it runs psql inside the docker compose "db" service.

Options:
  --dry-run, -n   Show current row counts without deleting anything.
  --yes, -y       Skip the interactive confirmation prompt.
  --help, -h      Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=1
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

COUNTS_SQL='
SELECT '"'"'ClueResponse'"'"' AS table_name, COUNT(*)::bigint AS rows FROM "ClueResponse"
UNION ALL
SELECT '"'"'BuzzerSession'"'"' AS table_name, COUNT(*)::bigint AS rows FROM "BuzzerSession"
UNION ALL
SELECT '"'"'DailyAttempt'"'"' AS table_name, COUNT(*)::bigint AS rows FROM "DailyAttempt"
ORDER BY table_name;
'

RESET_SQL='
BEGIN;
TRUNCATE TABLE "DailyAttempt", "BuzzerSession", "ClueResponse";
COMMIT;
'

PSQL_MODE=""

if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
  PSQL_MODE="database-url"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  PSQL_MODE="docker-compose"
else
  cat >&2 <<'EOF'
Could not find a way to connect to Postgres.

Either:
  1. Install psql and set DATABASE_URL, or
  2. Start the compose database with: docker compose up -d db
EOF
  exit 1
fi

run_psql() {
  local sql="$1"
  if [[ "$PSQL_MODE" == "database-url" ]]; then
    printf '%s\n' "$sql" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off
  else
    printf '%s\n' "$sql" | docker compose exec -T db psql \
      -U "${POSTGRES_USER:-jeopardy}" \
      -d "${POSTGRES_DB:-jeopardy}" \
      -v ON_ERROR_STOP=1 \
      -P pager=off
  fi
}

echo "Using connection mode: $PSQL_MODE"
echo
echo "Current leaderboard/stat rows:"
run_psql "$COUNTS_SQL"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "Dry run only; no rows were deleted."
  exit 0
fi

if [[ "$YES" -ne 1 ]]; then
  echo
  echo "This will permanently delete leaderboard/stat history from the three tables above."
  read -r -p "Type RESET to continue: " CONFIRM
  if [[ "$CONFIRM" != "RESET" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo
echo "Resetting leaderboard/stat history..."
run_psql "$RESET_SQL"

echo
echo "Rows after reset:"
run_psql "$COUNTS_SQL"

echo
echo "Done."
