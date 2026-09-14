# From-scratch WSL setup guide

A step-by-step walkthrough for setting up this project on a **brand-new
WSL Ubuntu install** — written so it can be followed live, screen-shared
with a coworker, on a machine that has nothing installed yet. It ends with
both `backend` (Strapi) and `frontend` (Next.js) running locally, either
with fresh empty data or restored from a `scripts/db-backup.sh` export.

Companion docs: [README.md](README.md) (what the project is),
[DEPLOYMENT.md](DEPLOYMENT.md) (putting it on a public VPS instead of a
laptop — nginx, HTTPS, systemd), `frontend/docs/database.md` (schema/API
reference).

## 0. Before you wipe anything

If you're resetting an **existing** WSL install rather than setting up a
brand-new machine, back up first — a reset cannot be undone:

```powershell
# From Windows PowerShell (not inside WSL)
wsl.exe -d Ubuntu -- ~/strapi-monorepo/scripts/db-backup.sh export ~/strapi-backup.zip
# then copy it out to Windows, e.g.:
wsl.exe -d Ubuntu -- cp ~/strapi-backup.zip /mnt/c/Users/<you>/Documents/
```

Also copy out `backend/.env` and `frontend/.env.local` separately if you
want the restored environment to be an **exact** clone (same Strapi admin
logins, same encryption secrets, same API tokens) rather than a fresh
setup with new secrets — `db-backup.sh`'s zip deliberately never includes
`.env` files. See §6 for what each path actually costs you.

## 1. Wipe and reinstall the WSL distro

```powershell
# From Windows PowerShell — this deletes the distro's entire filesystem
wsl.exe --unregister Ubuntu
wsl.exe --install -d Ubuntu
```

`wsl --install` will open a window and ask you to create a Unix username
and password for the new distro — this step is interactive by design (WSL
doesn't accept it non-interactively), so type it in live. Anything after
this point can be scripted or copy-pasted.

Once it drops you at a shell prompt inside the new distro, you're in
`~` as your new Unix user (this guide assumes that user is called `mg` to
match the paths used elsewhere in this repo — substitute your own).

## 2. System packages

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS (this repo pins 20 — see .nvmrc)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL, git, build tools, zip/unzip (for scripts/db-backup.sh)
sudo apt install -y postgresql postgresql-contrib build-essential git zip unzip

# PM2 process manager
sudo npm install -g pm2
```

Verify: `node -v` → v20.x · `psql --version` → PostgreSQL 16.x · `git --version`.

## 3. PostgreSQL database

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE test_strapi;
CREATE USER test_user WITH ENCRYPTED PASSWORD 'CHOOSE_A_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE test_strapi TO test_user;
ALTER DATABASE test_strapi OWNER TO test_user;
SQL
```

(Database/user names above match this project's existing dev convention —
free to rename, just keep `backend/.env`'s `DATABASE_*` values in sync.)

## 4. Get the code

The repo is **private** — cloning needs either a GitHub Personal Access
Token (used as the password when git prompts over HTTPS) or an SSH deploy
key added to the GitHub repo/account beforehand.

```bash
git clone https://github.com/kukkineko/strapi-monorepo.git
cd strapi-monorepo
./setup.sh          # npm ci for both backend/ and frontend/
```

## 5. Configure environment files

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

Edit `backend/.env`:
- `DATABASE_CLIENT=postgres`, `DATABASE_HOST=localhost`, `DATABASE_PORT=5432`,
  `DATABASE_NAME=test_strapi`, `DATABASE_USERNAME=test_user`,
  `DATABASE_PASSWORD=<what you chose in §3>`
- Generate fresh secrets for `APP_KEYS` / `API_TOKEN_SALT` /
  `ADMIN_JWT_SECRET` / `TRANSFER_TOKEN_SALT` / `ENCRYPTION_KEY` / `JWT_SECRET`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
  ```
  Run it once per secret (`APP_KEYS` takes a comma-separated list of 2-4 of
  these).

Edit `frontend/.env.local`:
- `STRAPI_URL=http://localhost:1337`
- Leave `STRAPI_TOKEN` blank for now — Strapi doesn't have a token to give
  yet (see §7). It can be added later without restarting from the admin
  panel's Server tab → "Strapi API Token", or by hand here.

## 6. Data: fresh, or restored from a backup?

**Fresh (recommended for a genuinely new/coworker machine)** — skip to §7.
Strapi will boot with empty tables and you register the first user through
the app.

**Restored from a `scripts/db-backup.sh` export** — e.g. the one made in
§0, or fetched from wherever it's stored. Two sub-cases:

- *Fresh secrets (default, more correct)*: restore data only. Existing
  Strapi admin-panel logins and any previously-issued API tokens will
  **not** work — those are encrypted with the old `ENCRYPTION_KEY`/salts.
  You'll create a new Strapi admin user on first boot and mint a new API
  token for `STRAPI_TOKEN`. `appuser` accounts (the wiki's own logins,
  bcrypt-hashed, not Strapi-encrypted) **do** keep working.
  ```bash
  scripts/db-backup.sh import /path/to/strapi-backup.zip --yes
  ```
- *Exact clone (same admin logins, same API token continue to work)*: also
  copy the **secrets backup** (the `.env`/`.env.local` you saved
  separately in §0 — never part of the zip) into place before starting
  Strapi, instead of generating new secrets in §5:
  ```bash
  cp /path/to/strapi-backend.env.SECRET backend/.env
  cp /path/to/frontend.env.local.SECRET frontend/.env.local
  scripts/db-backup.sh import /path/to/strapi-backup.zip --yes
  ```

Either way, `scripts/db-backup.sh import` restores Postgres + media only —
it never touches `.env` files, by design (see the script's own header).

## 7. First boot

```bash
# Terminal 1 — Strapi
cd backend
npm run build
npm run develop      # first run: create the admin user at the printed URL
```

Once Strapi is up, log into `http://localhost:1337/admin`, go to
**Settings → API Tokens → Create new API Token** (Full access), and paste
that value into `frontend/.env.local` as `STRAPI_TOKEN` — or start the
frontend first and paste it into Admin → Server → "Strapi API Token" from
the browser once you've registered/promoted a wiki user to administrator.

```bash
# Terminal 2 — Frontend
cd frontend
npm run dev
```

Open `http://localhost:3000`. If this is a fresh (non-restored) database,
register the first account, then promote it to administrator directly in
Postgres so you can reach the admin panel:

```bash
sudo -u postgres psql -d test_strapi -c \
  "UPDATE appusers SET confirmed=true, roles='[\"administrator\"]' WHERE email='you@example.com';"
```

## 8. Optional: run it the way production does

For the demo, `npm run dev` on both is simplest and gives hot reload. To
show the actual production process model instead (PM2 cluster, no hot
reload, matches [DEPLOYMENT.md](DEPLOYMENT.md)):

```bash
cd backend  && npm run build && pm2 start pm2.config.js
cd ../frontend && npm run build && pm2 start pm2.config.js
pm2 status   # both should show "online"
```

## Troubleshooting

- **`wsl --install` seems stuck / no prompt appears** — open the "Ubuntu"
  app from the Start menu manually; the first-run prompt sometimes doesn't
  focus the PowerShell window that triggered the install.
- **`git clone` asks for a password and rejects it** — HTTPS clones of
  private GitHub repos need a Personal Access Token as the password, not
  your GitHub account password (GitHub removed password auth for git in 2021).
- **Strapi won't start after a restore** — almost always mismatched
  `ENCRYPTION_KEY`/salts between the exported data and the new `.env`; see
  §6's "exact clone" path, or accept new secrets and re-mint the API token.
- **Frontend can't reach Strapi** — confirm `STRAPI_URL` in
  `frontend/.env.local` and that `npm run develop`/`pm2 status` shows
  Strapi actually listening on 1337.
