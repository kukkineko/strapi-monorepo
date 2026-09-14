# Strapi Frontend — Produkt-Wissensdatenbank

*[English version see README.md](README.md)*

Ein Next.js-Frontend für **Fluidras interne Produkt-Wissensdatenbank /
Ersatzteil-Wiki**. Es zeigt einen durchsuchbaren, kategorisierten
Produktkatalog an, der von einem Strapi-5-Backend mit Postgres versorgt
wird (das Paket `backend/` neben diesem hier) — inklusive persönlicher
Favoriten, eigener Listen (per Kurzcode teilbar), Hell-/Dunkelmodus und
einem Admin-Bereich für Inhalts- und Benutzerverwaltung.

Dieses Dokument erklärt das System von vorne bis hinten: was es tut, wie es
aufgebaut ist, wie die einzelnen Teile miteinander kommunizieren und wie man
es lokal betreibt bzw. deployt. Für den genauen Datenbank-/API-Vertrag siehe
[docs/database.md](docs/database.md) (auf Englisch).

## 1. Was diese Anwendung ist

Intern wird das Projekt "das Wiki" genannt. Es ist **kein** eigenes CMS —
Strapi (`backend/`) übernimmt die CMS-/Datenbankschicht; dieses Paket ist
die kundenseitige Next.js-Anwendung darüber. Ihre Aufgabe:

- Den Produktkatalog darstellen (gruppiert nach Kategorie/"Rubrik",
  durchsuchbar nach Name, Artikelnummer, EAN oder ID, mit einem
  Kategoriefilter neben dem Suchfeld).
- Eine Detailseite pro Produkt zeigen: Beschreibung, Bilder (von
  vertrauenswürdigen Nutzern hochladbar und neu anordenbar), Dokumente,
  Tags sowie beidseitig verknüpfte Ersatz-/Kompatibilitätsteile (mit einer
  Daumen-hoch/-runter-Konfidenzbewertung).
- Angemeldeten Nutzern erlauben, Artikel zu favorisieren, eigene "Listen"
  zu erstellen (z. B. für ein Projekt/eine Bestellung) und eine Liste über
  einen kurzen Code mit einem anderen Nutzer zu teilen — ganz ohne eigene
  Backend-Speicherung.
- Redakteuren/Mitarbeitern/Administratoren erlauben, Katalog-Inhalte zu
  bearbeiten, mit rollenbasiert sichtbaren Feldern und vollständigem
  Audit-Trail.
- Administratoren einen Admin-Bereich geben: Benutzerverwaltung,
  vollständiger DB-Export/-Import, Katalogstatistiken, ein Editor für die
  Konfidenz von Querverweisen, ein Tool zum Zuordnen von Dokumenten per
  Ordner-Scan, eine Build-/Neustart-Steuerung sowie ein Feld für den
  Strapi-API-Token für den Produktivserver — alles direkt in der App, ohne
  für den Tagesbetrieb das Strapi-Admin-Panel öffnen zu müssen.
- Zwei UI-Sprachen unterstützen (Englisch/Deutsch), Hell-/Dunkelmodus sowie
  grundlegende DSGVO-Seiten (Cookie-Banner, Impressum, Datenschutz).
- Nutzern erlauben, Produkte in weiteren Tabs zu öffnen und bis zu einem
  2×2-Raster nebeneinander anzuordnen, um Artikel zu vergleichen.

## 2. Architektur im Überblick

```
 Browser
   │  HTTPS
   ▼
 Next.js-App (dieses Paket)        ← läuft als PM2-Cluster über server.js, Port 3000
   │  app/api/*-Routen halten die EINZIGEN Strapi-Zugangsdaten
   │  (STRAPI_TOKEN); der Browser spricht nie direkt mit Strapi
   ▼
 Strapi-5-Backend (../backend in diesem Monorepo)
   │  REST/Document-API — /api/entries*, /api/app-auth/*, /api/upload
   ▼
 Postgres (nur Strapi verbindet sich damit — siehe docs/database.md)
```

Zwei weitere Dinge laufen aktuell zusammen mit Strapi auf demselben
Backend-Host: hochgeladene Medien (`backend/public/uploads`, einfache
lokale Festplatte) und ein kleiner In-Process-Response-Cache (Plugin
`rest-cache`). Beides ist für dieses Frontend nicht direkt erreichbar —
alles läuft über die HTTP-API von Strapi.

Manches liegt bewusst **nicht** in Strapi, sondern als kleine JSON-Dateien
auf dem Frontend-Server (siehe den "Warum"-Kommentar in der jeweiligen
Datei): der Seitenaufruf-Zähler, der pro Nutzer nur einmal alle 24 Stunden
zählt ([app/lib/page-views.ts](app/lib/page-views.ts)), sowie der Code-Speicher
für geteilte Listen ([app/lib/shared-lists.ts](app/lib/shared-lists.ts)) —
beides sind übergreifende, hochfrequente oder nutzerübergreifende
Abfragen, die nicht sauber als Strapi-Collection an einen einzelnen
`appuser`-Datensatz gebunden werden können.

**Warum überhaupt eine serverseitige Proxy-Schicht?** Die
`app/api/*`-Routen in Next.js existieren genau deshalb, damit der
Strapi-API-Token und die JWT-Secrets nie den Browser erreichen. Der Browser
hält ausschließlich ein Same-Origin-Session-Cookie; jeder Strapi-Aufruf
erfolgt vom Next.js-Server aus mit rein serverseitigen Umgebungsvariablen
(siehe [app/lib/auth-server.ts](app/lib/auth-server.ts) und
[app/lib/entries.ts](app/lib/entries.ts)). **Hinweis:** Entgegen einer
älteren Version dieses Dokuments sind `STRAPI_URL`/`STRAPI_TOKEN` reine
serverseitige Umgebungsvariablen — niemals mit `NEXT_PUBLIC_` versehen,
da das sie in das Browser-Bundle einbetten würde.

## 3. Technologie-Stack

| Schicht | Technologie |
|---|---|
| Framework | Next.js 16 (App Router, Server Components + Route Handlers) |
| UI | React 19, Tailwind CSS 4, eigenes CSS in [app/globals.css](app/globals.css) |
| Theming | Hell-/Dunkelmodus über [theme-provider.tsx](app/components/theme-provider.tsx), in `localStorage` gespeichert und vor der Hydration per blockierendem Skript in `layout.tsx` angewendet, um ein Aufblitzen des falschen Themes zu vermeiden |
| Bilder | `next/image` + `sharp`, per Rewrite in [next.config.ts](next.config.ts) auf Strapis `/uploads` durchgereicht |
| Prozessmodell | Eigener [server.js](server.js) (`http.createServer` + Next-Request-Handler), betrieben unter PM2 im `cluster`-Modus ([pm2.config.js](pm2.config.js)) — `next start` lässt sich nicht clustern, siehe Kommentar in server.js |
| Backend | Strapi 5 (`../backend` in diesem Monorepo) |
| Datenbank | PostgreSQL, vollständig im Besitz von Strapi — siehe [docs/database.md](docs/database.md) |
| Auth | Eigenes JWT-basiertes Auth-System gegen eine einzelne Strapi-Collection `appuser` (nicht Strapis eigene Admin-User, nicht die User des Plugins users-permissions) |
| Sprache | Durchgängig TypeScript im Frontend |

## 4. Funktionen

### Katalog & Navigation
- Die Startseite gruppiert Einträge nach Kategorie ("Rubrik") mit
  Artikelanzahl je Bereich; eine globale Suche (mit Kategoriefilter)
  durchsucht Name/Artikelnummer/EAN/ID
  ([app/page.tsx](app/page.tsx), [app/components/home-page-client.tsx](app/components/home-page-client.tsx)).
- `/products/all` — flache, sortier- und filterbare Liste aller Einträge.
- `/products/[id]` — Produkt-Detailseite: Beschreibung, Bilderkarussell,
  Dokumente, Tags sowie beidseitige Querverweise auf kompatible/Ersatzteile
  mit einer Konfidenzbewertung pro Nutzer (👍/👎).
- `/products/[id]/edit`, `/products/new` — rollenbasiert sichtbare
  Inhaltsbearbeitung, inklusive Hochladen und Neuanordnen von Artikelbildern.
- **Tabs & Split-Pane-Ansicht**: Über die Kopfleiste lassen sich Produkte in
  weiteren Tabs öffnen und bis zu einem 2×2-Raster nebeneinander anordnen,
  um Artikel zu vergleichen
  ([app/components/tab-bar.tsx](app/components/tab-bar.tsx),
  [app/components/compare-context.tsx](app/components/compare-context.tsx)).

### Persönliche Funktionen (für angemeldete Nutzer)
- **Favoriten** — einen Eintrag markieren; wird direkt im eigenen
  `appuser`-Datensatz gespeichert.
- **Listen** (`/listen`) — eigene Projekte anlegen und Artikel mit
  Menge/Positionsnummer hinzufügen, und eine Liste über einen kurzen,
  handtippbaren Code (z. B. `7K4M-PQR2`) mit einem anderen Nutzer teilen,
  der ihn einlösen kann, um die Liste in seine eigenen zu kopieren — ein
  Schnappschuss, keine Live-Verknüpfung, sodass spätere Änderungen nie das
  Original berühren ([app/lib/lists.ts](app/lib/lists.ts),
  [app/lib/shared-lists.ts](app/lib/shared-lists.ts)).
- **Selbstverwaltung des Kontos** im Benutzer-Panel: Passwort ändern oder
  das eigene Konto endgültig löschen (beides erfordert die erneute Eingabe
  des aktuellen Passworts) — siehe
  [app/api/auth/password](app/api/auth/password) und
  [app/api/auth/delete-account](app/api/auth/delete-account).

### Admin-Bereich (im Benutzer-Panel, erfordert die Rolle Administrator)
Alles davon liegt in [app/components/admin-panel.tsx](app/components/admin-panel.tsx) /
[app/components/user-panel.tsx](app/components/user-panel.tsx) als Unterseiten mit Tabs:

| Bereich | Zweck |
|---|---|
| Users | Konten verwalten: Rollen, gesperrt/bestätigt, Profilfelder |
| Audit Log | Chronologisches Protokoll jeder Inhaltsänderung durch jeden Nutzer, mit Rückgängig-Funktion |
| DB Backup | Vollständiges Datenbank-Backup exportieren/importieren (Einträge + Nutzer, als JSON über die Strapi-API) |
| DB Statistics | Anzahl der Einträge, Aufschlüsselung nach Kategorie, Querverweis-Graph, Seitenaufruf-Statistik |
| Link Confidence | Konfidenzwerte/Metadaten von verknüpften Teilen manuell bearbeiten |
| Assign Documents | Ordner scannen (nativer Betriebssystem-Dialog) und PDFs automatisch anhand der Artikelnummer zuordnen |
| Server | Strapi-API-Token einfügen/rotieren und aus dem Browser heraus einen Build und Neustart des produktiven PM2-Prozesses auslösen |

> Ein früherer Admin-Bereich "Import Data" nutzte OpenAI/Anthropic, um
> Ersatzteillisten automatisch aus hochgeladenen Dokumenten zu extrahieren.
> Er wurde **entfernt**, sodass die App keinen KI-API-Schlüssel eines
> Drittanbieters mehr benötigt.

Für einen vollständigen Export/Import **auf Server-Ebene** (Postgres +
Medien, nicht nur die JSON-Ebene des DB-Backups oben) siehe
`scripts/db-backup.sh` im Wurzelverzeichnis des Monorepos — es fasst
`.env`-Dateien nie an. Fehlt einem frischen Host also ein funktionierender
`STRAPI_TOKEN`, das Token-Feld im Server-Tab oben verwenden statt
`.env.local` von Hand zu bearbeiten.

### Übergreifend
- **i18n**: Englisch/Deutsch, vom Nutzer umschaltbar, alle Texte zentral in
  [app/lib/i18n.ts](app/lib/i18n.ts) ([app/components/language-provider.tsx](app/components/language-provider.tsx)).
- **Theme**: Hell/Dunkel, vom Nutzer umschaltbar, siehe Tabelle "Technologie-Stack" oben.
- **Seitenaufruf-Statistik**: ein schlanker, einmal pro Nutzer und 24 Stunden
  zählender Aufrufzähler pro Produkt, gespeichert als JSON-Datei auf dem
  Frontend-Server (nicht in Strapi).
- **Rate Limiting**: ein minimaler, In-Memory Sliding-Window-Begrenzer für
  Login/Registrierung/Kontolöschung ([app/lib/rate-limit.ts](app/lib/rate-limit.ts)).
- **Cookie-Banner + DSGVO-Seiten**: [app/components/cookie-banner.tsx](app/components/cookie-banner.tsx),
  [app/impressum/page.tsx](app/impressum/page.tsx), [app/datenschutz/page.tsx](app/datenschutz/page.tsx).

## 5. Authentifizierung & Rollen

Die Authentifizierung ist **vollständig eigenständig implementiert** — diese
App nutzt weder Strapis eingebautes Admin-Login noch die eigenen
Benutzerkonten des Plugins `users-permissions`. Stattdessen gilt:

- Jeder Anwendungsnutzer ist eine Zeile in einem einzigen Strapi-Content-Type,
  `appuser` (Schema siehe [docs/database.md](docs/database.md)).
- `POST /api/auth/login` und `POST /api/auth/register` (in diesem Paket)
  rufen Strapis eigene Endpunkte `/api/app-auth/login` / `/register` auf,
  die das Passwort per bcrypt hashen/prüfen und ein JWT ausstellen,
  signiert mit einem serverseitigen `JWT_SECRET` bei Strapi.
- Dieses Frontend speichert das JWT in einem Same-Origin-, httpOnly-
  Session-Cookie ([app/lib/auth-server.ts](app/lib/auth-server.ts)) — der
  Browser sieht niemals den Strapi-API-Token, sondern nur sein eigenes
  Session-Cookie.
- Autorisierung erfolgt rollenbasiert über ein Feld `roles: string[]` im
  `appuser`-Datensatz: `editor`, `staff`, `administrator`
  ([app/lib/auth-types.ts](app/lib/auth-types.ts)). Boolesche Werte wie
  `trusted`/`employee`/`administrator` werden daraus abgeleitet, um
  bestehende Berechtigungsprüfungen in der UI kompatibel zu halten.
- `app/components/auth-gate.tsx` steuert clientseitig gerenderte Inhalte
  abhängig vom Anmelde-/Rollenstatus und zeigt die
  Warteseiten für noch nicht freigegebene bzw. gesperrte Konten.

## 6. Daten & Backend-API

Das Postgres-Schema, der Tabellenaufbau und jeder von diesem Frontend
genutzte Strapi-API-Endpunkt sind vollständig dokumentiert in
**[docs/database.md](docs/database.md)**. Kurzfassung:

- Zwei Content-Types sind relevant: `appuser` (Benutzer) und `entry`
  (Katalogeinträge) — beide nutzen stark JSON-Spalten anstelle eines
  vollständig normalisierten relationalen Schemas.
- Das Frontend öffnet nie eine eigene Datenbankverbindung; jede
  `app/api/*`-Route ruft die REST/Document-API von Strapi per HTTP auf,
  mit einem rein serverseitigen `STRAPI_TOKEN`.
- Strapi erstellt/migriert sein Schema beim Start automatisch aus den
  `schema.json`-Dateien — es gibt keine von Hand geschriebenen
  SQL-Migrationen.

## 7. Verzeichnisstruktur (Überblick)

```
app/
  page.tsx, layout.tsx           Startseite & Root-Layout (Theme-Init-Skript,
                                  ThemeProvider/LanguageProvider/CompareProvider)
  products/                      Katalog: Übersicht, Detail, Bearbeiten, Neu
  listen/                        Persönliche "Listen"-Funktion (erstellen/teilen/einlösen)
  impressum/, datenschutz/       Statische rechtliche Seiten
  api/                           Rein serverseitige Route-Handler (einziger
                                  Code, der mit Strapi spricht)
    auth/                        Login/Registrierung/Session/Passwort/Kontolöschung,
                                  Admin-Nutzerverwaltung, Listen + Listen-Teilen
    entries/                     Katalog-CRUD, Suche, Voting, Aufrufe, Bulk-Operationen
    media/                       Upload-Proxying
    audit-log/                   Audit-Log lesen/rückgängig machen
  components/                    Alle React-Komponenten (Client & Server)
    admin-panel.tsx              Alle Admin-Unterseiten (große Datei, mit Tabs)
    user-panel.tsx                Profil/Favoriten/Listen/Admin-Tab-Hülle
    top-bar.tsx, tab-bar.tsx     Navigation, Suche, Tabs & Split-Pane-Raster
    theme-provider.tsx, theme-toggle.tsx, fluidra-logo.tsx   Branding/Theme
    cookie-banner.tsx, footer.tsx                            DSGVO/rechtliche UI
  lib/                           Framework-unabhängige Server-/geteilte Logik
    entries.ts                   Strapi-Eintrag: Abruf/Normalisierung
    auth-server.ts, auth-types.ts  Session-/JWT-/Rollenlogik
    i18n.ts                      Alle UI-Texte, en + de
    page-views.ts                Dateibasierter Aufrufzähler
    shared-lists.ts              Dateibasierter Code-Speicher fürs Listen-Teilen
    rate-limit.ts                In-Memory-Rate-Limiter (Login/Registrierung/Löschung)
    lists.ts, list-types.ts      Datenmodell der persönlichen Listen
docs/
  database.md                    Vollständiges Postgres-Schema + Strapi-API-Referenz
server.js                        Eigener Produktivserver (Einstiegspunkt für PM2-Cluster)
pm2.config.js, pm2.dev.config.js PM2-Prozessdefinitionen (Produktiv/Dev)
```

## 8. Lokale Entwicklung

Dieses Paket liegt im `strapi-monorepo` neben `backend/` (Strapi). Die
lokale Entwicklung findet **innerhalb von WSL** (Ubuntu) statt — geklont/
bearbeitet wird unter `~/strapi-monorepo/frontend`, nicht ein
Windows-seitiger Checkout, sonst erkennt der Datei-Watcher von `next dev`
Änderungen nicht zuverlässig.

```bash
# im Wurzelverzeichnis des Monorepos — installiert beide Pakete
./setup.sh

# danach, in diesem Paket
cp .env.example .env.local   # STRAPI_URL + STRAPI_TOKEN eintragen
npm run dev                  # next dev
```

Benötigte Umgebungsvariablen kommen in `.env.local` (wird nie committet —
siehe `.gitignore`):

| Variable | Erforderlich | Zweck |
|---|---|---|
| `STRAPI_URL` | ja | Basis-URL des Strapi-Backends, z. B. `http://localhost:1337` |
| `STRAPI_TOKEN` | ja | Strapi-API-Token — voller Lese-/Schreibzugriff auf `/api/entries*`. **Nur serverseitig, niemals mit `NEXT_PUBLIC_` versehen.** Kann auch aus der laufenden App heraus gesetzt/rotiert werden: Admin → Server → "Strapi API Token". |
| `COOKIE_SECURE` | nein | Erzwingt `Secure` beim Session-Cookie außerhalb der automatischen `NODE_ENV=production`-Erkennung |
| `VIEW_DATA_DIR` | nein | Überschreibt den Speicherort von `page-views.json`/`shared-lists.json` (Standard: `<cwd>/data`) |
| `PORT` | nein | Port für `server.js` (Standard: 3000) |

Es wird kein API-Schlüssel eines KI-Drittanbieters mehr benötigt — die
OpenAI/Anthropic-gestützte "Import Data"-Funktion, die einen benötigte,
wurde entfernt.

## 9. Build & Betrieb in Produktion

`next start` lässt sich nicht im PM2-Cluster-Modus betreiben (der Launcher
startet pro Worker einen Kindprozess und beendet sich selbst, sodass PM2
nichts lauschen sieht und endlos neu startet). Im Produktivbetrieb läuft
daher direkt der programmatische [server.js](server.js):

```bash
npm run build
npm run start:cluster    # npx pm2 start pm2.config.js — ein Worker pro CPU-Kern (minus einem)
```

Nützliche PM2-Befehle: `pm2 status`, `pm2 logs`, `pm2 monit`,
`pm2 reload all` (Neustart ohne Ausfallzeit), `pm2 stop all`. Für einen
Einzel-Worker-Modus gibt es `pm2.dev.config.js` (`npm run start:dev`).
Die vollständige VPS-Einrichtung (nginx, systemd, PostgreSQL, PM2-Autostart)
steht in [DEPLOYMENT.md](../DEPLOYMENT.md) im Wurzelverzeichnis des Monorepos.

Wichtige Einschränkungen pro Worker-/Host-Prozess, bevor über einen
einzelnen Host hinaus skaliert wird: Der Rate-Limiter, der
Seitenaufruf-Zähler und der Code-Speicher fürs Listen-Teilen sind **pro
Prozess bzw. pro Host, nicht hostübergreifend geteilt** — siehe die
Kommentare in [app/lib/rate-limit.ts](app/lib/rate-limit.ts),
[app/lib/page-views.ts](app/lib/page-views.ts) und
[app/lib/shared-lists.ts](app/lib/shared-lists.ts). Für einen einzelnen
PM2-Cluster auf einer Maschine ist das unproblematisch; sobald die App über
mehrere Hosts läuft, wäre ein gemeinsamer Speicher (z. B. Redis) nötig.

## 10. Umzug nach AWS — aktueller Stand

Backend und Datenbank laufen aktuell zusammen auf einem Host (WSL für die
Entwicklung, ein VPS für den Produktivbetrieb). Es laufen Arbeiten, um
dieses Repository für ein AWS-Deployment vorzubereiten, wobei Postgres
möglicherweise separat gehostet wird (z. B. Amazon RDS). Relevant dafür:

- [docs/database.md](docs/database.md) dokumentiert genau, wovon aus die
  Datenbank erreichbar sein muss (nur vom Strapi-Prozess — niemals von
  diesem Frontend oder dem öffentlichen Internet) und was eine frische
  RDS-Instanz beim ersten Start benötigt.
- `scripts/db-backup.sh` (Wurzelverzeichnis des Monorepos) exportiert/
  importiert Postgres + Strapis Medien-Uploads als eine Zip-Datei, wobei
  `.env`-Dateien bewusst ausgeschlossen bleiben.
- Secrets liegen aktuell im Klartext in `.env.local`/`.env`; sie sollten vor
  dem Deployment in den AWS Secrets Manager / SSM Parameter Store wandern.
  Insbesondere `STRAPI_TOKEN` ist zur Rotation vorgemerkt (ein früherer Wert
  wurde an Browser ausgeliefert) — das Token-Feld im Server-Tab macht die
  Rotation danach zu einem Ein-Klick-Vorgang.
- Hochgeladene Medien (`backend/public/uploads`, mehrere GB und wachsend)
  liegen aktuell auf einfacher lokaler Festplatte ohne Redundanz — hierfür
  wird entweder persistenter Block-/Netzwerkspeicher oder ein Wechsel auf
  einen S3-Upload-Provider benötigt, bevor der Betrieb auf vergänglichem
  Compute läuft.
- Die KI-gestützte Admin-Funktion "Import Data" (und ihre Abhängigkeit von
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) wurde im Rahmen dieser
  Aufräumarbeiten bereits entfernt.
