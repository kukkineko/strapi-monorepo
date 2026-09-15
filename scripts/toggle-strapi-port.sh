#!/usr/bin/env bash
#
# toggle-strapi-port.sh — temporarily open/close direct external access to
# Strapi's port (1337) on this VPS's firewall (ufw).
#
# WHY THIS EXISTS: normal production access to the Strapi admin panel goes
# through nginx (https://example.com/admin — see DEPLOYMENT.md section 7),
# which is the only path that should ever be open long-term. But there are
# moments before/without nginx being configured yet — first-time admin user
# creation right after `pm2 start`, or troubleshooting Strapi directly —
# where you need to reach it as http://<server-ip>:1337/admin instead. This
# script makes that a one-line, reversible toggle instead of a forgotten
# manual `ufw allow` that stays open indefinitely.
#
# Usage:
#   sudo scripts/toggle-strapi-port.sh on       # open 1337 to the internet
#   sudo scripts/toggle-strapi-port.sh off      # close it again
#   sudo scripts/toggle-strapi-port.sh status   # show current state
#
# SECURITY: while "on", Strapi is reachable directly over plain HTTP, with
# none of nginx's TLS termination, and none of any rate limiting you may
# have configured for /admin. Turn it "off" again as soon as you're done —
# this script does not do that for you automatically.

set -euo pipefail

PORT=1337
COMMENT="TEMP: direct Strapi admin access"

usage() {
  echo "Usage: $0 on|off|status" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "This needs root (it edits the firewall). Re-run as: sudo $0 $*" >&2
    exit 1
  fi
}

require_ufw() {
  command -v ufw >/dev/null 2>&1 || {
    echo "ufw not found. This script only supports the ufw firewall used in DEPLOYMENT.md." >&2
    exit 1
  }
}

is_open() {
  ufw status | grep -qE "^${PORT}/tcp[[:space:]]+ALLOW"
}

public_ip() {
  curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null \
    || curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null \
    || echo "<server-ip>"
}

cmd="${1:-}"
case "$cmd" in
  on)
    require_root "$@"
    require_ufw
    if is_open; then
      echo "Already open."
    else
      ufw allow "${PORT}/tcp" comment "$COMMENT"
      echo "Opened port ${PORT}."
    fi
    echo
    echo "  -> http://$(public_ip):${PORT}/admin"
    echo
    echo "Remember to run '$0 off' when you're done — this does not expire on its own."
    ;;
  off)
    require_root "$@"
    require_ufw
    if is_open; then
      # Deleting by the exact rule spec (not by number) so this stays
      # idempotent and safe to run even if the rule was added by hand.
      ufw delete allow "${PORT}/tcp" >/dev/null
      echo "Closed port ${PORT}."
    else
      echo "Already closed."
    fi
    ;;
  status)
    require_ufw
    if is_open; then
      echo "Port ${PORT} is OPEN to the internet."
    else
      echo "Port ${PORT} is closed (normal state)."
    fi
    ;;
  *)
    usage
    ;;
esac
