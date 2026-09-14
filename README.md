# Strapi Frontend — Product Knowledge Base

*[Deutsche Version siehe README.de.md](README.de.md)*

A Next.js frontend for an internal **product knowledge base / parts wiki**.
It renders a searchable, categorized catalog of products backed by a
Strapi 5 + Postgres backend, with per-user favorites, personal lists,
cross-linked replacement parts, and an admin back-office for content and
user management.

This document explains the system end to end: what it does, how it's built,
how the pieces talk to each other, and how to run and deploy it. For the
database/API contract specifically, see [docs/database.md](docs/database.md).

## 1. What this application is

Internally this is referred to as "the wiki." It is **not** a CMS itself —
Strapi is the CMS/database layer; this repo is the customer-facing Next.js
application on top of it. Its job is to:

- Present the product catalog (grouped by category/"Rubrik", searchable by
  name, article number, EAN, or ID).
- Show a detail page per product with its description, images, documents,
  tags, and cross-linked replacement/compatible parts.
- Let signed-in users favorite items and build personal "lists" (e.g. for a
  project/order) without needing their own backend storage.
- Let editors/staff/administrators edit catalog content, with role-gated
  fields and a full audit trail.
- Give administrators a back-office: user management, a full DB
  export/import, catalog statistics, a cross-link confidence editor, a
  folder-scanning document-assignment tool, and a build/restart control for
  the production server — all inside the app itself, with no need to touch
  the Strapi admin panel for day-to-day operations.
- Support two UI languages (English/German) and basic GDPR pages (cookie
  banner, Impressum, Datenschutz).

## 2. Architecture at a glance

```
 Browser
   │  HTTPS
   ▼
 Next.js app (this repo)         ← runs as a PM2 cluster via server.js, port 3000
   │  app/api/* route handlers hold the ONLY Strapi credentials
   │  (STRAPI_TOKEN); the browser never talks to Strapi directly
   ▼
 Strapi 5 backend (separate repo/host — see kukkineko/strapi-monorepo)
   │  REST/Document API — /api/entries*, /api/app-auth/*, /api/upload
   ▼
 Postgres (only Strapi connects to it — see docs/database.md)
```

Two more things run alongside Strapi on the same backend host today:
uploaded media (`public/uploads`, plain local disk) and a small
in-process response cache (`rest-cache` plugin). Neither is reachable
directly by this frontend — everything goes through Strapi's HTTP API.

**Why a server-side proxy layer at all?** The Next.js `app/api/*` routes
exist specifically so the Strapi API token and JWT secrets never reach the
browser. The browser only ever holds a same-origin session cookie; every
Strapi call is made from the Next.js server using server-only env vars
(see [app/lib/auth-server.ts](app/lib/auth-server.ts) and
[app/lib/entries.ts](app/lib/entries.ts)).

## 3. Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Components + Route Handlers) |
| UI | React 19, Tailwind CSS 4, custom CSS in [app/globals.css](app/globals.css) |
| Images | `next/image` + `sharp`, proxied to Strapi's `/uploads` via a rewrite in [next.config.ts](next.config.ts) |
| Runtime/process model | Custom [server.js](server.js) (`http.createServer` + Next's request handler) run under PM2 in `cluster` mode ([pm2.config.js](pm2.config.js)) — `next start` cannot be clustered, see the comment in server.js |
| Backend | Strapi 5.42.1 (separate repo, `~/strapi-monorepo` in WSL / VPS) |
| Database | PostgreSQL, owned entirely by Strapi — see [docs/database.md](docs/database.md) |
| Auth | Custom JWT-based auth against a single `appuser` Strapi collection (not Strapi's own admin users, not the users-permissions plugin's users) |
| Language | TypeScript throughout the frontend |

## 4. Features

### Catalog & browsing
- Home page groups entries by category ("Rubrik") with per-section item
  counts; a global search box searches name/ArtNr/EAN/ID
  ([app/page.tsx](app/page.tsx), [app/components/home-page-client.tsx](app/components/home-page-client.tsx)).
- `/products/all` — flat, sortable list of every entry.
- `/products/[id]` — product detail page: description, images, documents,
  tags, and bidirectional cross-links to compatible/replacement parts.
- `/products/[id]/edit`, `/products/new` — role-gated content editing.
- **Tabs & split-pane view**: the top bar can open products in additional
  tabs and arrange up to a 2×2 grid of panes side by side for comparing
  items ([app/components/tab-bar.tsx](app/components/tab-bar.tsx),
  [app/components/compare-context.tsx](app/components/compare-context.tsx)).
  This replaced an earlier dedicated `/compare` page.

### Personal features (per signed-in user)
- **Favorites** — star an entry; stored on the user's own `appuser` record.
- **Lists** (`/listen` — named for the German word *Listen*, "lists") — create
  named projects and add articles with quantities/position numbers, entirely
  client-managed and persisted back to the user record
  ([app/lib/lists.ts](app/lib/lists.ts), [app/lib/list-types.ts](app/lib/list-types.ts)).
- **Add-to-list button** available anywhere a product is shown
  ([app/components/add-to-list-button.tsx](app/components/add-to-list-button.tsx)).

### Admin back-office (inside the user panel, administrator role required)
All of this lives in [app/components/admin-panel.tsx](app/components/admin-panel.tsx) /
[app/components/user-panel.tsx](app/components/user-panel.tsx) as tabbed sub-pages:

| Section | Purpose |
|---|---|
| Users | Manage accounts: roles, blocked/confirmed status, profile fields |
| Audit Log | Chronological log of every content change by every user, with revert |
| DB Backup | Export/import a full database backup |
| DB Statistics | Entry counts, category breakdown, cross-link graph, page-view analytics |
| Link Confidence | Manually edit confidence scores/metadata on cross-referenced parts |
| Assign Documents | Scan a folder (native OS folder picker) and auto-assign PDFs to articles by article number |
| Server | Trigger a build and restart of the production PM2 process from the browser |

> An earlier "Import Data" admin section used OpenAI/Anthropic to
> auto-extract replacement-part lists from uploaded documents. It has been
> **removed** so the app no longer needs any third-party AI API key —
> see the git history around the `import-data` routes if that capability
> needs to be revisited.

### Cross-cutting
- **i18n**: English/German, user-toggleable, all strings centralized in
  [app/lib/i18n.ts](app/lib/i18n.ts) ([app/components/language-provider.tsx](app/components/language-provider.tsx)).
- **Page-view analytics**: a lightweight, once-per-user-per-24h view counter
  per product, stored as a JSON file on the frontend server (not in Strapi —
  see the "why a file" note in [app/lib/page-views.ts](app/lib/page-views.ts)).
- **Rate limiting**: a minimal in-memory sliding-window limiter on
  login/register ([app/lib/rate-limit.ts](app/lib/rate-limit.ts)).
- **Cookie banner + GDPR pages**: [app/components/cookie-banner.tsx](app/components/cookie-banner.tsx),
  [app/impressum/page.tsx](app/impressum/page.tsx), [app/datenschutz/page.tsx](app/datenschutz/page.tsx).

## 5. Authentication & roles

Authentication is **entirely custom** — this app does not use Strapi's
built-in admin login or the `users-permissions` plugin's own user accounts.
Instead:

- Every application user is one row in a single Strapi collection type,
  `appuser` (see [docs/database.md](docs/database.md) for the schema).
- `POST /api/auth/login` and `POST /api/auth/register` (this repo) call
  Strapi's custom `/api/app-auth/login` / `/register` endpoints, which
  bcrypt-hash/verify the password and issue a JWT signed with a
  Strapi-side `JWT_SECRET`.
- This frontend stores that JWT in a same-origin, httpOnly session cookie
  ([app/lib/auth-server.ts](app/lib/auth-server.ts)) — the browser never
  sees the Strapi API token, only its own session cookie.
- Authorization is role-based via a `roles: string[]` field on the
  `appuser` record: `editor`, `staff`, `administrator`
  ([app/lib/auth-types.ts](app/lib/auth-types.ts)). Booleans like
  `trusted`/`employee`/`administrator` are derived from `roles` for
  backward-compatible permission checks throughout the UI.
- `app/components/auth-gate.tsx` gates client-rendered content on
  auth/role state.

## 6. Data & backend API

The Postgres schema, table layout, and every Strapi API endpoint this
frontend depends on are documented in full in
**[docs/database.md](docs/database.md)**. In short:

- Two content types matter: `appuser` (users) and `entry` (catalog items) —
  both use JSON columns heavily rather than a fully normalized relational
  schema.
- The frontend never opens a database connection; every `app/api/*` route
  handler calls Strapi's REST/Document API over HTTP using a server-only
  `STRAPI_TOKEN`.
- Strapi auto-creates/migrates its own schema from `schema.json` files on
  boot — there are no hand-written SQL migrations to run.

## 7. Directory structure (high level)

```
app/
  page.tsx, layout.tsx           Home page & root layout
  products/                      Catalog browsing, detail, edit, create
  listen/                        Personal "Lists" feature
  impressum/, datenschutz/       Static legal pages
  api/                           Server-only route handlers (the only code
                                  that ever talks to Strapi)
    auth/                        Login/register/session/admin user mgmt
    entries/                     Catalog CRUD, search, voting, views, bulk ops
    media/                       Upload proxying
    audit-log/                   Audit log read/revert
  components/                    All client/server React components
    admin-panel.tsx              Every admin sub-page (large file, tabbed)
    user-panel.tsx                Profile/Favourites/Lists/Admin tab shell
    top-bar.tsx, tab-bar.tsx     Navigation, search, tabs & split-pane grid
  lib/                           Framework-agnostic server/shared logic
    entries.ts                   Strapi entry fetch/normalize helpers
    auth-server.ts, auth-types.ts  Session/JWT/role logic
    i18n.ts                      All UI strings, en + de
    page-views.ts                File-backed view counter
    rate-limit.ts                In-memory login rate limiter
    lists.ts, list-types.ts      Personal lists data model
docs/
  database.md                    Full Postgres schema + Strapi API reference
server.js                        Custom production server (PM2 cluster entry)
pm2.config.js, pm2.dev.config.js PM2 process definitions (prod / dev)
```

## 8. Local development

Local development for this project happens **inside WSL** (Ubuntu), not
directly on Windows — clone/edit at `~/strapi-monorepo/frontend` in WSL, not
the Windows-side checkout, or `next dev`'s file watcher won't pick up
changes (this is especially true for CSS edited over a UNC path from
Windows). The matching Strapi backend runs from `~/strapi-monorepo` (the
`/strapi` path referenced throughout this doc) in the same WSL environment,
both managed under PM2 as a regular (non-root) user.

```bash
# inside WSL, in the frontend package
npm install
npm run dev            # next dev
```

Required env vars go in `.env.local` (never committed — see `.gitignore`):

| Variable | Required | Purpose |
|---|---|---|
| `STRAPI_URL` | yes | Base URL of the Strapi backend, e.g. `http://localhost:1337` |
| `STRAPI_TOKEN` | yes | Strapi API token — full read/write access to `/api/entries*`. **Server-only, never prefix with `NEXT_PUBLIC_`.** |
| `COOKIE_SECURE` | no | Force `Secure` on the session cookie outside of `NODE_ENV=production` auto-detection |
| `VIEW_DATA_DIR` | no | Override where `page-views.json` is written (defaults to `<cwd>/data`) |
| `PORT` | no | Port for `server.js` (defaults to 3000) |

> As of this writing, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are **no longer
> needed** — the AI-powered import feature that used them was removed.

## 9. Building & running in production

`next start` cannot run under PM2 cluster mode (its launcher spawns and
exits a child process per worker, so PM2 sees nothing listening and
restarts forever). Production therefore runs the programmatic
[server.js](server.js) directly:

```bash
npm run build
npm run start:cluster    # npx pm2 start pm2.config.js — one worker per CPU core (minus one)
```

Useful PM2 commands: `pm2 status`, `pm2 logs`, `pm2 monit`,
`pm2 reload all` (zero-downtime restart), `pm2 stop all`. A `pm2.dev.config.js`
variant exists for a single-worker "production build, but not the real
prod cluster" mode (`npm run start:dev`).

Per-worker caveats to know about before scaling beyond one host/process
group: the login/register rate limiter and the page-view counter are
**per-process, not shared** — see the comments in
[app/lib/rate-limit.ts](app/lib/rate-limit.ts) and
[app/lib/page-views.ts](app/lib/page-views.ts). They're fine for a single
PM2 cluster on one machine; they'd need a shared store (e.g. Redis) if the
app is ever run across multiple hosts.

## 10. Moving to AWS — current status

The backend and database currently run together on one host (WSL for
development, a VPS for production). Work is in progress to prepare this
codebase for an AWS deployment, potentially with Postgres hosted separately
(e.g. Amazon RDS). Relevant to that effort:

- [docs/database.md](docs/database.md) documents exactly what the database
  needs to be reachable from (only the Strapi process — never this frontend
  or the public internet) and what a fresh RDS instance needs on first boot.
- Secrets currently live in `.env.local` in plaintext; they should move to
  AWS Secrets Manager / SSM Parameter Store before deployment, and
  `STRAPI_TOKEN` in particular is flagged for rotation (a previous value was
  shipped to browsers).
- Uploaded media (`public/uploads` on the Strapi host, ~1 GB and growing)
  is plain local disk today with no redundancy — needs either persistent
  block/network storage or a switch to an S3 upload provider before running
  on ephemeral compute.
- The AI-powered "Import Data" admin feature (and its `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` requirement) has already been removed as part of this
  cleanup.
