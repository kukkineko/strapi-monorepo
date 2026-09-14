# SQL database & API reference

This describes the Postgres database and the Strapi 5 backend that owns it.
**None of this lives in this repo** — the backend is a separate codebase
(`~/strapi-monorepo` backend package in WSL, deployed from the private
`kukkineko/strapi-monorepo` repo). This frontend never talks to Postgres
directly; it only ever calls Strapi's HTTP API over `STRAPI_URL` with a
bearer `STRAPI_TOKEN` (see [next.config.ts](../next.config.ts) and
[app/lib/entries.ts](../app/lib/entries.ts)). This doc exists here because
it's the piece that matters most for the AWS move: it tells you exactly what
the database needs to be reachable *from* (only the Strapi process, never
the Next.js server or the browser) and what shape the schema takes when you
provision a fresh RDS instance.

## How the schema is built

Strapi doesn't use hand-written SQL migrations. Each content type is defined
declaratively in a `schema.json` file under `src/api/<name>/content-types/`,
and Strapi's ORM (Bookshelf/Knex under the hood) diffs that against the live
database **on every boot** and auto-creates/alters tables and columns to
match. `database/migrations/` in the backend repo is empty (just `.gitkeep`)
— there is no manual migration history to replay.

Practical consequences for an AWS move:
- Pointing a fresh Strapi instance at a brand-new empty RDS database is
  enough to create the full schema — no schema dump/restore needed, just
  `npm run build && npm start` once against the new `DATABASE_*` env vars.
- Moving **data** (rows) is a separate step — use `pg_dump`/`pg_restore`
  (or Strapi's own `strapi export`/`transfer` tooling) against the existing
  Postgres instance, not a manual schema copy.
- Two Strapi instances auto-migrating against the same DB concurrently (e.g.
  during a rolling deploy) is the one thing to avoid — schema changes should
  land via a single instance restarting, not N instances racing.

## Content types (the tables that matter)

Everything else in Postgres is Strapi's own bookkeeping (see below). These
two are the actual application data:

### `appuser` → table `appusers`

The entire user model — see [[auth-architecture]]. One row per user, no
relations out to Strapi's built-in auth system.

| field | type | notes |
|---|---|---|
| `username` | string | required, unique, min 2 |
| `email` | email | required, unique |
| `password` | password | `private: true` — bcrypt hash, never returned by the API; hashed in `lifecycles.js` on create/update (skips re-hashing if the value already looks like a bcrypt hash, so imports can carry hashes verbatim) |
| `firstName`, `lastName`, `company` | string | profile fields |
| `roles` | json | array of strings, validated against `['editor','staff','administrator']` in the controller — **not** a Strapi relation to any role table |
| `favorites` | json | array of entry ids |
| `lists` | json | user-defined saved lists |
| `auditLog` | json | append-only log of the user's admin actions |
| `confirmed`, `blocked` | boolean | account status flags |

`roles`/`favorites`/`lists`/`auditLog` are raw JSON columns, not normalized
tables — this is a deliberate "one row = one user's whole world" model
rather than relational users/roles/permissions tables.

### `entry` → table `entries`

The product/parts catalog — the thing `/api/entries` serves to the frontend.

| field | type | notes |
|---|---|---|
| `title` | string | |
| `desc` | text | |
| `artNr` | **uid**, required | Strapi enforces this as a unique, URL-safe identifier at the app layer (backed by a unique index) — see [[strapi-entries-quirks]] |
| `EAN` | string | *not* unique — was explicitly de-duplicated-then-loosened locally because real-world catalogs have legitimate EAN collisions |
| `pictures`, `miscFile` | media (multiple) | polymorphic relation into Strapi's upload `files` table (see below) |
| `tags`, `links`, `issues`, `tickets`, `rubrik`, `docs`, `IGS` | json | free-form structured blobs (e.g. `links` is the cross-reference list `save-links` and the admin "Link Confidence" tab edit — array of `{id, confidence, source, link?, desc?}`) |

Like `appuser`, most of the interesting structure (tags, cross-links,
compatibility info) lives in JSON columns rather than join tables. Postgres
is used here more as a document store with a few indexed/unique scalar
columns (`artNr`) than as a fully normalized relational schema.

`draftAndPublish: true` is enabled on `entry` (unlike `appuser`), so Strapi
also tracks a `published_at` column and draft/published versions per row.

### Tables Strapi manages for you (not app-specific)

| table(s) | purpose |
|---|---|
| `admin_users`, `admin_roles`, `admin_permissions` | Strapi's own back-office login (the `/admin` CMS UI) — **completely separate from `appuser`**. An admin-panel login has nothing to do with a wiki-frontend login. |
| `up_users`, `up_roles`, `up_permissions` | Installed via `@strapi/plugin-users-permissions`, but the app doesn't use this plugin's own users — only its role/permission model, which gates which routes a given API token or the `Public`/`Authenticated` role may call |
| `files`, `folders`, `files_related_morphs`, etc. | Upload plugin — backs `pictures`/`miscFile`. Currently the **local disk provider**: files land on `/strapi/public/uploads` (~1 GB today) and are served statically by Strapi, not from S3. This is the other big AWS decision alongside the DB — either mount persistent storage (EBS/EFS) at that path or switch the upload provider to S3. |
| `strapi_core_store_settings`, `strapi_database_schema`, `strapi_migrations*` | Internal Strapi bookkeeping (plugin config, schema-sync history) |

## What API the frontend actually needs

The Next.js app never opens a DB connection — it only needs network access
to one Strapi HTTP endpoint. Two distinct API surfaces live on that one
Strapi instance:

**1. Custom auth API — `/api/app-auth/*`** (in [auth-server.ts](../app/lib/auth-server.ts))
Hand-written routes/controller, `auth: false` at the Strapi router level
(they do their own bearer-JWT verification inside the handler, signed with
`JWT_SECRET` — a *different* secret from Strapi's own `ADMIN_JWT_SECRET`):

| method & path | auth | purpose |
|---|---|---|
| `POST /app-auth/register` | public | create an `appuser` |
| `POST /app-auth/login` | public | verify bcrypt password, issue JWT |
| `GET /app-auth/me` | bearer | current user profile |
| `PUT /app-auth/me` | bearer | update own profile/favorites/lists/auditLog |
| `PUT /app-auth/password` | bearer | self-service password change (requires current password) |
| `POST /app-auth/delete-me` | bearer | self-service account deletion (POST because Strapi only body-parses POST/PUT/PATCH) |
| `GET /app-auth/users` | bearer + administrator | list all users |
| `PUT /app-auth/users` | bearer + administrator | set roles/blocked/confirmed/profile on any user |
| `GET /app-auth/export` | bearer + administrator | full dump incl. bcrypt hashes, for backups |
| `POST /app-auth/import` | bearer + administrator | upsert users by email, for restores |

**2. Standard Strapi Document/REST API — `/api/entries*`**
`entry` uses Strapi's default `createCoreRouter`/`createCoreController` —
no custom logic — so it gets the full generic CRUD surface for free:
`GET/POST /api/entries`, `GET/PUT/DELETE /api/entries/:id`, plus Strapi's
standard query params (`filters`, `sort`, `populate`, `pagination`).
Access is gated by the `STRAPI_TOKEN` bearer API token configured in Strapi
admin, not by a per-user role — the frontend's server routes are the only
thing holding that token. **Note:** `.env.local` currently has a comment
flagging this token as previously shipped to the browser and due for
rotation — worth doing as part of the AWS move regardless of AI-key cleanup.

Two behavioral quirks worth carrying into any AWS-side load testing:
- Pagination requires an explicit `sort=id:asc` to page reliably (see
  [[strapi-entries-quirks]]) — `config/api.js` sets `defaultLimit: 25,
  maxLimit: 100`.
- The `rest-cache` plugin caches `api::entry.entry` GET responses in an
  **in-process** memory LRU (1 hour TTL, invalidated on writes). This is the
  Strapi-side twin of the frontend's per-worker rate limiter and page-view
  store: fine for a single Strapi instance, but would go stale/inconsistent
  the moment Strapi itself is ever run as more than one instance — that
  would need a shared cache (e.g. Redis) or the plugin disabled.

**3. Upload API — `/api/upload`**
Used when saving `pictures`/`miscFile` on an entry. Local-disk provider
today; see the storage note in the table above.

## Net takeaway for the AWS move

Postgres itself doesn't need to expose anything to the frontend or the
public internet — only the Strapi process needs a connection to it (so an
RDS security group scoped to just the Strapi EC2/ECS instance is sufficient,
matching the [RDS recommendation](#) already discussed). The frontend's only
network dependency is HTTP(S) to Strapi's `/api/*` surface described above.
The two things that need real decisions when Strapi moves are (a) where
Postgres lives — see the earlier hosting-options comparison — and (b) where
`public/uploads` lives, since it's currently plain local disk with no
redundancy.
