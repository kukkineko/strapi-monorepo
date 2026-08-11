# Pool Products Platform — Monorepo

A two-part application:

| Package     | Stack                              | Port | Purpose                                   |
|-------------|------------------------------------|------|-------------------------------------------|
| `frontend/` | Next.js 16, React 19, TypeScript   | 3000 | Public site + admin UI, talks to Strapi via server-side `/api/*` routes |
| `backend/`  | Strapi 5, PostgreSQL               | 1337 | Headless CMS: products (`entry`), users (`appuser`), media uploads |

The browser never talks to Strapi directly — every request is proxied through the
Next.js server routes, which hold the `STRAPI_TOKEN`.

## Repository layout

```
.
├── frontend/          # Next.js app
│   ├── .env.example   # copy to .env.local
│   └── ...
├── backend/           # Strapi app
│   ├── .env.example   # copy to .env
│   └── public/uploads # media lives here (NOT in git — restore from data export)
├── setup.sh           # install dependencies for both packages
├── DEPLOYMENT.md      # full Linux VPS deployment guide
└── README.md
```

## What is NOT in this repo

By design, no data or secrets are committed:

- **Secrets** — real `.env` / `.env.local` files. Copy the `.env.example` templates and fill them in.
- **Media uploads** — `backend/public/uploads/*` (several GB). Restore from the separate data export.
- **Database** — PostgreSQL contents. Restore from the `database.sql` dump in the data export.
- **Local import tooling** — the `strapiimport/` scratch folder (spreadsheets, backups, Python scripts) stays on the workstation.

## Quick start (local dev)

```bash
# 1. Install everything
./setup.sh

# 2. Configure environments
cp backend/.env.example backend/.env        # fill in secrets + DB creds
cp frontend/.env.example frontend/.env.local # fill in STRAPI_URL + tokens

# 3. Run the backend (Strapi) — terminal 1
cd backend && npm run develop

# 4. Run the frontend (Next.js) — terminal 2
cd frontend && npm run dev
```

Frontend: <http://localhost:3000> · Strapi admin: <http://localhost:1337/admin>

## Deploying to a server

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full step-by-step Linux VPS guide
(PostgreSQL, PM2, nginx, data restore).

## Day-to-day workflow (dev in WSL → GitHub → VPS)

Local development runs inside **Ubuntu WSL**, parallel to the production VPS. This
repo is the single source of truth — changes flow to production through GitHub.

1. **Edit** in `~/strapi-monorepo/frontend`. Run `npm run dev` (hot reload); it
   reads the local Strapi backend on `localhost:1337`.
2. **Publish** to GitHub:
   ```bash
   git add -A && git commit -m "describe the change" && git push
   ```
3. **Deploy** on the VPS (see [DEPLOYMENT.md](DEPLOYMENT.md) → *Updating a running
   deployment*):
   ```bash
   cd /var/www/app && git pull
   cd frontend && npm ci && npm run build && pm2 reload strapifrontend
   ```

`.env.local` (frontend) and `.env` (backend) hold secrets, are git-ignored, and
never travel through this loop — set them once per environment.

## Requirements

- Node.js 20.x (see `.nvmrc`)
- PostgreSQL 14+ (production database)
- PM2 (process manager) — `npm install -g pm2`
