# Deployment guide — Linux VPS

End-to-end instructions to take this application online on a fresh Ubuntu/Debian VPS.

- **Frontend** (Next.js) runs on port **3000**
- **Backend** (Strapi) runs on port **1337**, bound to localhost only
- **PostgreSQL** holds the data; **nginx** is the public reverse proxy
- **PM2** keeps both Node processes alive across crashes and reboots

Adjust `example.com` and paths to your setup.

---

## 0. What you need on the server

Two things get transferred out-of-band (they are intentionally not in git):

1. **The code** — either `git clone` this private repo, or upload the code zip.
2. **The data export** — a zip containing:
   - `database.sql` — the PostgreSQL dump
   - `uploads/` — the Strapi media files

   Use `scripts/db-backup.sh export` on the source host to produce this zip
   (and `scripts/db-backup.sh import <file>.zip` on the destination host to
   restore it) instead of doing the pg_dump/copy steps by hand — see
   [scripts/db-backup.sh](scripts/db-backup.sh) for usage. It never reads or
   writes `.env` files; secrets always transfer separately (see step 4).

---

## 1. System packages

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL, nginx, build tools, zip/unzip (zip/unzip needed by scripts/db-backup.sh)
sudo apt install -y postgresql postgresql-contrib nginx build-essential git zip unzip

# PM2 process manager
sudo npm install -g pm2
```

Verify: `node -v` → v20.x, `psql --version`, `nginx -v`.

---

## 2. PostgreSQL database

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE strapi;
CREATE USER strapi WITH ENCRYPTED PASSWORD 'CHOOSE_A_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE strapi TO strapi;
ALTER DATABASE strapi OWNER TO strapi;
SQL
```

Restore the data (from the data export):

```bash
# If database.sql was made with pg_dump --no-owner (recommended):
psql -U strapi -d strapi -h 127.0.0.1 -f /path/to/data-export/database.sql

# If it is a custom-format .dump instead:
# pg_restore -U strapi -d strapi -h 127.0.0.1 --no-owner /path/to/database.dump
```

---

## 3. Get the code

```bash
sudo mkdir -p /var/www && cd /var/www

# Option A — clone the private repo
git clone git@github.com:<you>/<repo>.git app

# Option B — upload and unzip the code zip
# unzip app-code.zip -d app

sudo chown -R $USER:$USER /var/www/app
cd /var/www/app
```

---

## 4. Backend (Strapi)

```bash
cd /var/www/app/backend

# Environment
cp .env.example .env
# Edit .env: set the DATABASE_* values to match section 2, DATABASE_CLIENT=postgres,
# and generate fresh secrets for APP_KEYS / *_SALT / *_SECRET / ENCRYPTION_KEY:
#   node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"

# Restore media uploads (from the data export)
mkdir -p public/uploads
cp -a /path/to/data-export/uploads/. public/uploads/

# Install + build + start
npm ci
npm run build
pm2 start pm2.config.js
```

> **Important:** if this database was created on another machine, the Strapi
> `ENCRYPTION_KEY` and `*_SALT` values in `.env` must match the ones used when the
> data was written, or previously-encrypted fields and existing API tokens will
> fail to decrypt. Keep the original secret values with the data export.

Then, in the Strapi admin (`/admin`), create a fresh **API token** and put it in
the frontend `.env.local` as `STRAPI_TOKEN`.

---

## 5. Frontend (Next.js)

```bash
cd /var/www/app/frontend

cp .env.example .env.local
# Edit .env.local:
#   STRAPI_URL=http://127.0.0.1:1337
#   STRAPI_TOKEN=<the token from step 4>
#   OPENAI_API_KEY=<your key>

npm ci
npm run build
pm2 start pm2.config.js
```

---

## 6. Persist PM2 across reboots

```bash
pm2 save
pm2 startup    # run the command it prints, then `pm2 save` again
pm2 status     # both strapi-backend and strapifrontend should be "online"
```

---

## 7. nginx reverse proxy

```nginx
# /etc/nginx/sites-available/app
server {
    listen 80;
    server_name example.com;

    client_max_body_size 50M;   # allow large media uploads through the admin

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Strapi admin panel + media (proxied straight to Strapi)
    location /admin  { proxy_pass http://127.0.0.1:1337; }
    location /uploads { proxy_pass http://127.0.0.1:1337; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app
sudo nginx -t && sudo systemctl reload nginx
```

---

## 8. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

---

## 9. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Ports 3000 and 1337 stay internal — only 80/443 are exposed. Good.

---

## Updating a running deployment

```bash
cd /var/www/app && git pull

cd backend  && npm ci && npm run build && pm2 reload strapi-backend
cd ../frontend && npm ci && npm run build && pm2 reload strapifrontend
```

## Troubleshooting

- **Frontend can't reach Strapi** — confirm `STRAPI_URL` in `frontend/.env.local`
  points at `http://127.0.0.1:1337` and `pm2 status` shows the backend online.
- **Images 404** — make sure `backend/public/uploads` actually contains the media
  from the data export, and nginx proxies `/uploads` to Strapi.
- **Strapi won't start after restore** — usually mismatched `ENCRYPTION_KEY`/salts;
  see the note in step 4.
- **Logs** — `pm2 logs strapi-backend` / `pm2 logs strapifrontend`.
