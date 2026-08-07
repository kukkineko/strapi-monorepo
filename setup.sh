#!/usr/bin/env bash
# Install dependencies for both packages. Run from the repo root.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Node version:"
node -v || { echo "Node.js is not installed. See DEPLOYMENT.md section 1."; exit 1; }

echo "==> Installing backend (Strapi) dependencies..."
( cd backend && npm ci )

echo "==> Installing frontend (Next.js) dependencies..."
( cd frontend && npm ci )

echo ""
echo "Done. Next steps:"
echo "  1. cp backend/.env.example backend/.env         (fill in secrets + DB)"
echo "  2. cp frontend/.env.example frontend/.env.local (fill in tokens)"
echo "  3. See DEPLOYMENT.md to build, restore data, and start with PM2."
