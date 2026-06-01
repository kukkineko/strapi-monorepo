# strapifrontend

This frontend is a Next.js App Router project for browsing and editing product/item pages backed by Strapi.

## What This Project Does

- Shows grouped product categories on the home page.
- Lets users search and browse all products.
- Renders a detailed item page with:
  - metadata (`title`, `artNr`, `EAN`, `tags`, `desc`)
  - sections (`issues`, `docs`, `links`, `tickets`) stored as JSON in Strapi
  - images (`pictures`) and attachments (`miscFile`) from Strapi media
  - IGS data (`igs`) stored as JSON in Strapi
- Provides create and edit pages for item content.

## Features

### English

- Home page with grouped product categories (`rubrik 1-15`, replacements, extra).
- Full product listing page with filtering, sorting, and search query support.
- Top bar navigation with icon actions and search input.
- Search suggestion history in the top bar.
- Back-item behavior using session history.
- Product detail page with metadata display (`title`, `artNr`, `EAN`, `tags`, `desc`).
- Product detail cards for `issues`, `docs`, `links`, and `tickets`.
- Section preview modals and section card UI on detail pages.
- Image carousel / gallery rendering from Strapi `pictures` media.
- Attachment rendering from Strapi `miscFile` media.
- IGS panel rendering from Strapi `igs` JSON data.
- Pretty-printing of valid IGS JSON with raw fallback when invalid JSON is stored.
- Product create page for adding new entries.
- Product edit page for updating existing entries.
- Section CRUD workflows (add/edit/delete) in the edit flow.
- Item image management (upload, attach, remove).
- Section attachment resolution by media ID, including missing media lookup.
- Centralized Strapi data layer for list/get/create/update entry operations.
- Centralized Strapi media operations for upload and fetch by media ID.
- Response normalization from Strapi format into frontend `Entry` objects.
- JSON-like field normalization (`tags`, `docs`, `links`, `issues`, `tickets`, `igs`).
- Numeric ID to `documentId` resolution for Strapi entry fetch/update flows.
- Language context provider with localStorage persistence.
- Language toggle UI and i18n dictionary helpers.
- Configurable Strapi URL and token via environment variables.
- Global responsive styling for cards, grids, modals, forms, and top bar.

### Deutsch

- Startseite mit gruppierten Produktkategorien (`rubrik 1-15`, replacements, extra).
- Vollstaendige Produktliste mit Filtern, Sortierung und Suchabfrage.
- Top-Bar-Navigation mit Icon-Aktionen und Suchfeld.
- Suchvorschlags-Verlauf in der Top-Bar.
- Zurueck-Navigation fuer Eintraege ueber Session-Historie.
- Produktdetailseite mit Metadatenanzeige (`title`, `artNr`, `EAN`, `tags`, `desc`).
- Detailkarten fuer `issues`, `docs`, `links` und `tickets`.
- Vorschau-Modals und Karten-UX fuer Sektionen auf der Detailseite.
- Bildkarussell / Bildergalerie aus Strapi-`pictures`-Medien.
- Anzeige von Anhaengen aus Strapi-`miscFile`-Medien.
- IGS-Panel aus Strapi-`igs`-JSON-Daten.
- Schoene Darstellung gueltiger IGS-JSON-Daten mit Rohdaten-Fallback bei ungueltigem JSON.
- Erstellseite fuer neue Produkteintraege.
- Bearbeitungsseite fuer bestehende Produkteintraege.
- Sektionen-CRUD (hinzufuegen/bearbeiten/loeschen) im Bearbeitungsfluss.
- Bildverwaltung pro Eintrag (hochladen, verknuepfen, entfernen).
- Aufloesung von Abschnitts-Anhaengen ueber Medien-IDs, inklusive Nachladen fehlender Medien.
- Zentralisierte Strapi-Datenschicht fuer Listen-/Lesen-/Erstellen-/Aktualisieren-Operationen.
- Zentralisierte Strapi-Medienoperationen fuer Upload und Abruf per Medien-ID.
- Normalisierung von Strapi-Antworten in frontendseitige `Entry`-Objekte.
- Normalisierung JSON-aehnlicher Felder (`tags`, `docs`, `links`, `issues`, `tickets`, `igs`).
- Aufloesung von numerischer ID zu `documentId` fuer Strapi-Lese- und Update-Flows.
- Sprachkontext-Provider mit localStorage-Persistenz.
- Sprachumschalter-UI und i18n-Dictionary-Helfer.
- Konfigurierbare Strapi-URL und Token ueber Umgebungsvariablen.
- Globale responsive Styles fuer Karten, Grids, Modals, Formulare und Top-Bar.

## Important Files

### App shell and global behavior

- `app/layout.tsx`
  - Root layout.
  - Injects global CSS and wraps app in `LanguageProvider`.
- `app/globals.css`
  - Main styling for top bar, cards, grids, modals, forms, and responsive behavior.

### Shared UI components

- `app/components/top-bar.tsx`
  - Top navigation, icon buttons, search input, search submit icon, and search suggestion history.
  - Handles back-item behavior using session history.
- `app/components/language-provider.tsx`
  - Language context/state with localStorage persistence.
- `app/components/language-toggle.tsx`
  - UI control for switching language.

### Data/API layer

- `app/lib/entries.ts`
  - Core Strapi client for entries and media.
  - Normalizes Strapi responses into frontend `Entry` objects.
  - Converts JSON-like fields to strings (`tags`, `docs`, `links`, `issues`, `tickets`, `igs`).
  - Handles create/update/list/get entry calls.
  - Handles media upload and media lookup.
- `app/lib/item-images.ts`
  - Helper wrapper around media upload/attach/remove for item image workflows.
- `app/lib/topbar-icons.ts`
  - Centralized icon paths and per-icon sizing constants.
- `app/lib/i18n.ts`
  - Translation dictionaries and language helpers.

### Main routes/pages

- `app/page.tsx`
  - Home page with grouped sections (rubrik 1-15, replacements, extra).
- `app/products/all/page.tsx`
  - Full product listing with filtering, sorting, and query search.
- `app/products/[id]/page.tsx`
  - Item detail page (primary read view).
  - Includes preview modals and section card UX.
  - Renders IGS panel from Strapi `igs` JSON field.
- `app/products/[id]/edit/page.tsx`
  - Item edit page with section CRUD and image management.
- `app/products/new/page.tsx`
  - New item creation form.

## Environment Variables

Set these in your environment (for example in `.env.local`):

- `NEXT_PUBLIC_STRAPI_URL`
  - Strapi base URL, defaults to `http://localhost:1337` if not set.
- `NEXT_PUBLIC_STRAPI_TOKEN`
  - Bearer token used for Strapi authenticated API requests.

## How Strapi API Calls Are Made

All entry/media calls are centralized in `app/lib/entries.ts`.

### 1) Headers and base URL

- `STRAPI_URL` is read from `NEXT_PUBLIC_STRAPI_URL`.
- `getHeaders()` adds `Authorization: Bearer <token>` when token exists.
- JSON requests use `Content-Type: application/json`.

### 2) Response parsing and errors

- `parseResponse()` reads Strapi `{ data, error }` responses.
- Non-OK responses throw with Strapi message/details.

### 3) Entry fetch/list

- `listEntries()` calls:
  - `GET /api/entries?populate[0]=pictures&populate[1]=miscFile`
- `getEntryById(id)`:
  - resolves numeric IDs to `documentId` using a filter query
  - then fetches `GET /api/entries/{documentId}` with populate

### 4) Entry create/update

- `createEntry(payload)` -> `POST /api/entries`
- `updateEntry(id, payload)` -> `PUT /api/entries/{documentId}`
- `toStrapiPayload()` controls exactly which fields are sent:
  - `title`, `artNr`, `EAN`, `desc`, `tags`, `docs`, `links`, `issues`, `tickets`, `igs`, `pictures`, `miscFile`, `rubrik`

### 5) Media flow

- `uploadMedia(files)` -> `POST /api/upload`, returns media IDs.
- `attachMediaToEntry(entryId, mediaIds)` updates entry `pictures` relation.
- `getMediaById(id)` fetches single media file metadata.

## How An Item Page Is Constructed (Data-wise)

The main detail page is `app/products/[id]/page.tsx`.

### Step A: Fetch and normalize

1. Route ID is read from URL params.
2. `getEntryById()` loads entry data from Strapi.
3. `normalizeEntry()` in `entries.ts` maps raw Strapi data to `Entry`.

### Step B: Field normalization

- JSON-capable fields are normalized to string form:
  - `tags`, `docs`, `links`, `issues`, `tickets`, `igs`
- Media relations are normalized:
  - `pictures` -> `pictureUrls[]`
  - `miscFile` -> `miscFiles[]` (`id`, `name`, absolute `url`)

### Step C: Page-level parsing for UI

The page parses persisted JSON strings into UI-friendly structures:

- `issues/docs/tickets`: parsed into arrays of objects (`title`, `description`, optional `link`, optional `attachments`).
- `links`: parsed into linked entry IDs.
- `igs`: pretty-printed if valid JSON, otherwise shown raw.

### Step D: Attachment/media resolution

- Section attachments may reference media IDs.
- Missing media objects are resolved with `getMediaById()` and merged into a lookup map.

### Step E: Render

- Upper area: core item metadata and image carousel.
- Lower cards: issues/docs/links/tickets.
- IGS panel: rendered from Strapi `igs` field.

### Step F: Persisting section edits

When a section is edited/deleted:

1. UI updates section arrays.
2. Arrays are serialized back to JSON strings.
3. `updateEntry()` sends a full payload built from existing entry + updates.
4. IGS is preserved in payload (`igs: entry.igs`) so section saves do not overwrite IGS.

## Run Locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Notes

- Existing boilerplate README was renamed to `readmenextjs` per request.
- If Strapi model field names differ (`igs` vs `IGS`), normalization currently supports both on read (`source.igs ?? source.IGS`).
