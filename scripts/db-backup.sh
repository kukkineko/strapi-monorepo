#!/usr/bin/env bash
#
# db-backup.sh — export or import the Strapi backend's Postgres database
# and media uploads as a single portable zip file.
#
# The zip NEVER contains backend/.env or any other secrets — only:
#   database.sql    a plain-text pg_dump (--no-owner --no-acl --clean --if-exists)
#   uploads/        a copy of backend/public/uploads
#   manifest.json   a small provenance record (timestamp, db name, hostname)
#
# DB connection details are read from backend/.env (DATABASE_*) so you never
# have to retype them; they are used only to run pg_dump/psql and are never
# printed or written into the archive.
#
# Usage:
#   scripts/db-backup.sh export [output.zip]
#   scripts/db-backup.sh import <input.zip> [--yes]
#
# Run from anywhere — paths resolve relative to this script's own location
# (repo-root/scripts/.. == repo root, backend/ next to it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"
UPLOADS_DIR="$BACKEND_DIR/public/uploads"

usage() {
  cat <<'USAGE'
Usage:
  db-backup.sh export [output.zip]
  db-backup.sh import <input.zip> [--yes]

Exports/imports the Strapi Postgres database + backend/public/uploads as one
zip file. backend/.env is never read into, or written from, the archive —
secrets stay on the host. On a fresh machine, restore the code + this
archive, then create backend/.env (from .env.example) and the frontend's
STRAPI_TOKEN by hand (or via the admin panel's "Strapi API Token" field).

Options:
  --yes   (import only) skip the overwrite confirmation prompt
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1 (try: sudo apt install $1)" >&2
    exit 1
  }
}

# Reads only the DATABASE_* keys out of backend/.env. Every other line in
# that file (JWT_SECRET, APP_KEYS, API tokens, ...) is never parsed or
# touched by this script.
load_db_env() {
  [ -f "$ENV_FILE" ] || { echo "Backend .env not found at $ENV_FILE" >&2; exit 1; }

  DB_CLIENT=$(grep -E '^DATABASE_CLIENT='   "$ENV_FILE" | tail -1 | cut -d= -f2-)
  DB_HOST=$(grep -E   '^DATABASE_HOST='     "$ENV_FILE" | tail -1 | cut -d= -f2-)
  DB_PORT=$(grep -E   '^DATABASE_PORT='     "$ENV_FILE" | tail -1 | cut -d= -f2-)
  DB_NAME=$(grep -E   '^DATABASE_NAME='     "$ENV_FILE" | tail -1 | cut -d= -f2-)
  DB_USER=$(grep -E   '^DATABASE_USERNAME=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
  DB_PASS=$(grep -E   '^DATABASE_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2-)

  if [ "${DB_CLIENT:-postgres}" != "postgres" ]; then
    echo "This script only supports DATABASE_CLIENT=postgres (found: '${DB_CLIENT:-}')." >&2
    exit 1
  fi
  : "${DB_HOST:=localhost}"
  : "${DB_PORT:=5432}"
  : "${DB_NAME:?DATABASE_NAME missing from $ENV_FILE}"
  : "${DB_USER:?DATABASE_USERNAME missing from $ENV_FILE}"
}

cmd_export() {
  local out="${1:-strapi-backup-$(date +%Y%m%d-%H%M%S).zip}"
  case "$out" in /*) : ;; *) out="$(pwd)/$out" ;; esac

  require_cmd pg_dump
  require_cmd zip
  load_db_env

  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  echo "==> Dumping database '$DB_NAME' from $DB_HOST:$DB_PORT..."
  PGPASSWORD="$DB_PASS" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-acl --clean --if-exists --format=plain \
    -f "$work/database.sql"

  echo "==> Copying uploads from $UPLOADS_DIR..."
  mkdir -p "$work/uploads"
  if [ -d "$UPLOADS_DIR" ]; then
    cp -a "$UPLOADS_DIR/." "$work/uploads/"
  else
    echo "    (not found — archive will have an empty uploads/)"
  fi

  cat > "$work/manifest.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$DB_NAME",
  "host": "$(hostname)"
}
JSON

  echo "==> Writing $out (excluding .env — secrets never leave this host)..."
  rm -f "$out"
  ( cd "$work" && zip -rq "$out" database.sql uploads manifest.json )

  echo "==> Done: $out ($(du -h "$out" | cut -f1))"
}

cmd_import() {
  local zip_path="${1:?Usage: db-backup.sh import <input.zip> [--yes]}"
  local assume_yes="${2:-}"

  require_cmd psql
  require_cmd unzip
  load_db_env

  [ -f "$zip_path" ] || { echo "File not found: $zip_path" >&2; exit 1; }

  if [ "$assume_yes" != "--yes" ]; then
    read -r -p "This will OVERWRITE database '$DB_NAME' on $DB_HOST and copy files into $UPLOADS_DIR. Continue? [y/N] " reply
    case "$reply" in
      y|Y|yes|YES) ;;
      *) echo "Aborted."; exit 1 ;;
    esac
  fi

  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  echo "==> Extracting $zip_path..."
  unzip -q "$zip_path" -d "$work"
  [ -f "$work/database.sql" ] || {
    echo "database.sql not found in archive — is this a valid backup?" >&2
    exit 1
  }

  echo "==> Restoring database '$DB_NAME'..."
  PGPASSWORD="$DB_PASS" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -f "$work/database.sql" >/dev/null

  if [ -d "$work/uploads" ]; then
    echo "==> Restoring uploads to $UPLOADS_DIR..."
    mkdir -p "$UPLOADS_DIR"
    cp -a "$work/uploads/." "$UPLOADS_DIR/"
  else
    echo "    (archive has no uploads/ — skipping media restore)"
  fi

  echo "==> Done."
  echo "    .env was NOT touched. On a fresh host, still need to:"
  echo "      - backend/.env   — copy from backend/.env.example and fill in secrets"
  echo "      - frontend STRAPI_TOKEN — set via .env.local, or the admin panel's"
  echo "        'Strapi API Token' field under Server (once the app is running)"
}

case "${1:-}" in
  export) shift; cmd_export "${1:-}" ;;
  import) shift; cmd_import "${1:-}" "${2:-}" ;;
  -h|--help|"") usage; exit 1 ;;
  *) echo "Unknown command: $1" >&2; usage; exit 1 ;;
esac
