# Strapi Frontend — Product Knowledge Base

*[Deutsche Version siehe README.de.md](README.de.md)*

A Next.js frontend for **Fluidra's internal product knowledge base / parts wiki**.
It renders a searchable, categorized catalog of products backed by a
Strapi 5 + Postgres backend (the `backend/` package next to this one), with
per-user favorites, personal lists (shareable via short codes), light/dark
theming, and an admin back-office for content and user management.

This document explains the system end to end: what it does, how it's built,
how the pieces talk to each other, and how to run and deploy it. For the
database/API contract specifically, see [docs/database.md](docs/database.md).

## 1. What this application is

Internally this is referred to as "the wiki." It is **not** a CMS itself —
Strapi (`backend/`) is the CMS/database layer; this package is the
customer-facing Next.js application on top of it. Its job is to:

- Present the product catalog (grouped by category/"Rubrik", searchable by
  name, article number, EAN, or ID, with a category filter alongside the
  search box).
- Show a detail page per product with its description, images (uploadable
  and reorderable by trusted users), documents, tags, and cross-linked
  replacement/compatible parts (with a thumbs-up/down confidence vote).
- Let signed-in users favorite items, build personal "lists" (e.g. for a
  project/order), and share a list with another user via a short code —
  all without needing their own backend storage.
- Let editors/staff/administrators edit catalog content, with role-gated
  fields and a full audit trail.
- Give administrators a back-office: user management, a full DB
  export/import, catalog statistics, a cross-link confidence editor, a
  folder-scanning document-assignment tool, a build/restart control and a
  Strapi API token field for the production server — all inside the app
  itself, with no need to touch the Strapi admin panel for day-to-day
  operations.
- Support two UI languages (English/German), light/dark theming, and basic
  GDPR pages (cookie banner, Impressum, Datenschutz).
- Let users open products in additional tabs and arrange up to a 2×2 grid
  of panes side by side for comparing items.

## 2. Architecture at a glance

```
 Browser
   │  HTTPS
   ▼
 Next.js app (this package)      ← runs as a PM2 cluster via server.js, port 3000
   │  app/api/* route handlers hold the ONLY Strapi credentials
   │  (STRAPI_TOKEN); the browser never talks to Strapi directly
   ▼
 Strapi 5 backend (../backend in this monorepo)
   │  REST/Document API — /api/entries*, /api/app-auth/*, /api/upload
   ▼
 Postgres (only Strapi connects to it — see docs/database.md)
```

Two more things run alongside Strapi on the same backend host today:
uploaded media (`backend/public/uploads`, plain local disk) and a small
in-process response cache (the `rest-cache` plugin). Neither is reachable
directly by this frontend — everything goes through Strapi's HTTP API.

A few things are deliberately **not** in Strapi at all, and instead live as
small JSON files on the frontend server (see the "why" comment in each
file): the once-per-user-per-24h page-view counter
([app/lib/page-views.ts](app/lib/page-views.ts)) and the shared-list code
store ([app/lib/shared-lists.ts](app/lib/shared-lists.ts)) — both are
cross-cutting, high-frequency, or cross-user lookups that don't fit
cleanly as Strapi collections tied to one `appuser` record.

**Why a server-side proxy layer at all?** The Next.js `app/api/*` routes
exist specifically so the Strapi API token and JWT secrets never reach the
browser. The browser only ever holds a same-origin session cookie; every
Strapi call is made from the Next.js server using server-only env vars
(see [app/lib/auth-server.ts](app/lib/auth-server.ts) and
[app/lib/entries.ts](app/lib/entries.ts)). **Note:** despite what an older
version of this document said, `STRAPI_URL`/`STRAPI_TOKEN` are plain
server-only env vars — never prefix them with `NEXT_PUBLIC_`, which would
inline them into the browser bundle.

## 3. Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Components + Route Handlers) |
| UI | React 19, Tailwind CSS 4, custom CSS in [app/globals.css](app/globals.css) |
| Theming | Light/dark mode via [theme-provider.tsx](app/components/theme-provider.tsx), persisted to `localStorage` and applied pre-hydration via a blocking script in `layout.tsx` to avoid a flash of the wrong theme |
| Images | `next/image` + `sharp`, proxied to Strapi's `/uploads` via a rewrite in [next.config.ts](next.config.ts) |
| Runtime/process model | Custom [server.js](server.js) (`http.createServer` + Next's request handler) run under PM2 in `cluster` mode ([pm2.config.js](pm2.config.js)) — `next start` cannot be clustered, see the comment in server.js |
| Backend | Strapi 5 (`../backend` in this monorepo) |
| Database | PostgreSQL, owned entirely by Strapi — see [docs/database.md](docs/database.md) |
| Auth | Custom JWT-based auth against a single `appuser` Strapi collection (not Strapi's own admin users, not the users-permissions plugin's users) |
| Language | TypeScript throughout the frontend |

## 4. Features

### Catalog & browsing
- Home page groups entries by category ("Rubrik") with per-section item
  counts; a global search box (with a category filter dropdown) searches
  name/ArtNr/EAN/ID ([app/page.tsx](app/page.tsx),
  [app/components/home-page-client.tsx](app/components/home-page-client.tsx)).
- `/products/all` — flat, sortable, filterable list of every entry.
- `/products/[id]` — product detail page: description, image carousel,
  documents, tags, and bidirectional cross-links to compatible/replacement
  parts with a per-user confidence vote (👍/👎).
- `/products/[id]/edit`, `/products/new` — role-gated content editing,
  including uploading and reordering item images.
- **Tabs & split-pane view**: the top bar can open products in additional
  tabs and arrange up to a 2×2 grid of panes side by side for comparing
  items ([app/components/tab-bar.tsx](app/components/tab-bar.tsx),
  [app/components/compare-context.tsx](app/components/compare-context.tsx)).

### Personal features (per signed-in user)
- **Favorites** — star an entry; stored on the user's own `appuser` record.
- **Lists** (`/listen` — named for the German word *Listen*, "lists") — create
  named projects and add articles with quantities/position numbers, and
  **share a list** with another user via a short, hand-typeable code (e.g.
  `7K4M-PQR2`) that they can redeem to copy it into their own lists —
  a snapshot, not a live link, so editing afterwards never touches the
  original ([app/lib/lists.ts](app/lib/lists.ts),
  [app/lib/shared-lists.ts](app/lib/shared-lists.ts)).
- **Self-service account management** in the user panel: change password,
  or permanently delete your own account (both require re-entering your
  current password) — see
  [app/api/auth/password](app/api/auth/password) and
  [app/api/auth/delete-account](app/api/auth/delete-account).

### Admin back-office (inside the user panel, administrator role required)
All of this lives in [app/components/admin-panel.tsx](app/components/admin-panel.tsx) /
[app/components/user-panel.tsx](app/components/user-panel.tsx) as tabbed sub-pages:

| Section | Purpose |
|---|---|
| Users | Manage accounts: roles, blocked/confirmed status, profile fields |
| Audit Log | Chronological log of every content change by every user, with revert |
| DB Backup | Export/import a full database backup (entries + users, as JSON via the Strapi API) |
| DB Statistics | Entry counts, category breakdown, cross-link graph, page-view analytics |
| Link Confidence | Manually edit confidence scores/metadata on cross-referenced parts |
| Assign Documents | Scan a folder (native OS folder picker) and auto-assign PDFs to articles by article number |
| Server | Paste/rotate the Strapi API token, and trigger a build + restart of the production PM2 process from the browser |

> An earlier "Import Data" admin section used OpenAI/Anthropic to
> auto-extract replacement-part lists from uploaded documents. It has been
> **removed** so the app no longer needs any third-party AI API key.

For a full **server-level** data export/import (Postgres + media, not just
the JSON-level DB Backup above), see `scripts/db-backup.sh` at the
monorepo root — it never touches `.env` files, so if a fresh host ends up
without a working `STRAPI_TOKEN`, use the Server tab's token field above
instead of hand-editing `.env.local`.

### Cross-cutting
- **i18n**: English/German, user-toggleable, all strings centralized in
  [app/lib/i18n.ts](app/lib/i18n.ts) ([app/components/language-provider.tsx](app/components/language-provider.tsx)).
- **Theme**: light/dark, user-toggleable, see the Tech stack table above.
- **Page-view analytics**: a lightweight, once-per-user-per-24h view counter
  per product, stored as a JSON file on the frontend server (not in Strapi).
- **Rate limiting**: a minimal in-memory sliding-window limiter on
  login/register/account-deletion ([app/lib/rate-limit.ts](app/lib/rate-limit.ts)).
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
  auth/role state, and shows the pending-approval / blocked landing pages
  for accounts awaiting an administrator.

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
  page.tsx, layout.tsx           Home page & root layout (theme init script,
                                  ThemeProvider/LanguageProvider/CompareProvider)
  products/                      Catalog browsing, detail, edit, create
  listen/                        Personal "Lists" feature (create/share/redeem)
  impressum/, datenschutz/       Static legal pages
  api/                           Server-only route handlers (the only code
                                  that ever talks to Strapi)
    auth/                        Login/register/session/password/delete-account,
                                  admin user mgmt, lists + list-sharing
    entries/                     Catalog CRUD, search, voting, views, bulk ops
    media/                       Upload proxying
    audit-log/                   Audit log read/revert
  components/                    All client/server React components
    admin-panel.tsx              Every admin sub-page (large file, tabbed)
    user-panel.tsx                Profile/Favourites/Lists/Admin tab shell
    top-bar.tsx, tab-bar.tsx     Navigation, search, tabs & split-pane grid
    theme-provider.tsx, theme-toggle.tsx, fluidra-logo.tsx   Branding/theme
    cookie-banner.tsx, footer.tsx                            GDPR/legal UI
  lib/                           Framework-agnostic server/shared logic
    entries.ts                   Strapi entry fetch/normalize helpers
    auth-server.ts, auth-types.ts  Session/JWT/role logic
    i18n.ts                      All UI strings, en + de
    page-views.ts                File-backed view counter
    shared-lists.ts              File-backed list-sharing code store
    rate-limit.ts                In-memory rate limiter (login/register/delete)
    lists.ts, list-types.ts      Personal lists data model
docs/
  database.md                    Full Postgres schema + Strapi API reference
server.js                        Custom production server (PM2 cluster entry)
pm2.config.js, pm2.dev.config.js PM2 process definitions (prod / dev)
```

## 8. Local development

This package lives inside the `strapi-monorepo` alongside `backend/`
(Strapi). Local development happens **inside WSL** (Ubuntu) — clone/edit
at `~/strapi-monorepo/frontend`, not a Windows-side checkout, or `next
dev`'s file watcher won't reliably pick up changes.

```bash
# from the monorepo root — installs both packages
./setup.sh

# then, in this package
cp .env.example .env.local   # fill in STRAPI_URL + STRAPI_TOKEN
npm run dev                  # next dev
```

Required env vars go in `.env.local` (never committed — see `.gitignore`):

| Variable | Required | Purpose |
|---|---|---|
| `STRAPI_URL` | yes | Base URL of the Strapi backend, e.g. `http://localhost:1337` |
| `STRAPI_TOKEN` | yes | Strapi API token — full read/write access to `/api/entries*`. **Server-only, never prefix with `NEXT_PUBLIC_`.** Can also be set/rotated from the running app via Admin → Server → "Strapi API Token". |
| `COOKIE_SECURE` | no | Force `Secure` on the session cookie outside of `NODE_ENV=production` auto-detection |
| `VIEW_DATA_DIR` | no | Override where `page-views.json`/`shared-lists.json` are written (defaults to `<cwd>/data`) |
| `PORT` | no | Port for `server.js` (defaults to 3000) |

No third-party AI API key is required — the OpenAI/Anthropic-powered
"Import Data" feature that once needed one has been removed.

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
prod cluster" mode (`npm run start:dev`). See the monorepo root's
[DEPLOYMENT.md](../DEPLOYMENT.md) for the full VPS setup (nginx, systemd,
PostgreSQL, PM2 startup).

Per-worker caveats to know about before scaling beyond one host/process
group: the rate limiter, the page-view counter, and the shared-list code
store are **per-process or per-host, not shared across hosts** — see the
comments in [app/lib/rate-limit.ts](app/lib/rate-limit.ts),
[app/lib/page-views.ts](app/lib/page-views.ts), and
[app/lib/shared-lists.ts](app/lib/shared-lists.ts). They're fine for a
single PM2 cluster on one machine; they'd need a shared store (e.g. Redis)
if the app is ever run across multiple hosts.

## 10. Moving to AWS — current status

The backend and database currently run together on one host (WSL for
development, a VPS for production). Work is in progress to prepare this
codebase for an AWS deployment, potentially with Postgres hosted separately
(e.g. Amazon RDS). Relevant to that effort:

- [docs/database.md](docs/database.md) documents exactly what the database
  needs to be reachable from (only the Strapi process — never this frontend
  or the public internet) and what a fresh RDS instance needs on first boot.
- `scripts/db-backup.sh` (monorepo root) exports/imports Postgres + Strapi's
  media uploads as one zip, deliberately excluding `.env` files.
- Secrets currently live in `.env.local`/`.env` in plaintext; they should
  move to AWS Secrets Manager / SSM Parameter Store before deployment, and
  `STRAPI_TOKEN` in particular is flagged for rotation (a previous value
  was shipped to browsers) — the Server tab's token field makes rotation a
  one-click operation once that's done.
- Uploaded media (`backend/public/uploads`, several GB and growing) is
  plain local disk today with no redundancy — needs either persistent
  block/network storage or a switch to an S3 upload provider before running
  on ephemeral compute.
- The AI-powered "Import Data" admin feature (and its `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` requirement) has already been removed as part of this
  cleanup.
