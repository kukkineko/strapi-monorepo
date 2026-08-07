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

## Requirements

- Node.js 20.x (see `.nvmrc`)
- PostgreSQL 14+ (production database)
- PM2 (process manager) — `npm install -g pm2`
