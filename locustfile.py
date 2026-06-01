"""
locustfile.py  –  stress test for the strapifrontend Next.js wiki app.

HOW TO RUN
──────────
Interactive web UI (open http://localhost:8089 after starting):
    locust -f locustfile.py --host http://localhost:3000

Headless 50-user run, 5 users/sec spawn rate, 3 minutes:
    locust -f locustfile.py --host http://localhost:3000 ^
           --users 50 --spawn-rate 5 --headless --run-time 3m

Quick smoke test (10 users, 1 minute):
    locust -f locustfile.py --host http://localhost:3000 ^
           --users 10 --spawn-rate 2 --headless --run-time 1m

WHAT IT SIMULATES
─────────────────
Three realistic user personas, each with their own browsing patterns and
think times.  Together they exercise every hot path in the app:

  HomeBrowserUser      – lands on home, clicks a rubrik tile, digs into items
  CatalogBrowserUser   – lives in /products/all, filters by section, clicks items
  SearchExplorerUser   – types search terms, browses results, follows related items

Every page load   also fires GET /api/auth/me, mirroring the TopBar auth check
that the real browser makes on every navigation.

All requests of the same type are given a fixed `name` so Locust groups them
into one row in the stats table (e.g. all product detail pages count together
as "PRODUCT /products/[id]" instead of one row per document ID).
"""

from __future__ import annotations

import random
import re
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from locust import HttpUser, between, task

# ── URL patterns ──────────────────────────────────────────────────────────────

HREF_RE        = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
DETAIL_PATH_RE = re.compile(r"^/products/[^/?#]+$")

# ── All section identifiers matching the app's ?section= param ───────────────

SECTIONS_ALL = [
    "all",
    *[f"rubrik-r{i:02d}" for i in range(1, 16)],
    "replacements",
    "extra",
]
SECTIONS_RUBRIK = [f"rubrik-r{i:02d}" for i in range(1, 16)]

# ── Sort/direction combinations ───────────────────────────────────────────────

SORT_OPTIONS = [
    ("artnr", "asc"),
    ("artnr", "desc"),
    ("name",  "asc"),
    ("name",  "desc"),
    ("ean",   "asc"),
    ("ean",   "desc"),
    ("tags",  "asc"),
    ("tags",  "desc"),
]

# ── Realistic search terms drawn from the catalogue categories ────────────────
# Full words and common German abbreviations / partials to simulate real typing.

SEARCH_TERMS = [
    # Full terms
    "Pumpe", "Filter", "Chlor", "Steuerung", "Ventil",
    "Heizung", "Abdeckung", "Leiter", "Brause", "Sauna",
    "Dampfbad", "Whirlpool", "Edelstahl", "Kunststoff", "Rotguss",
    "Dosiertechnik", "Wärmepumpe", "Solaranlage", "Rückspülung",
    "Skimmer", "Düse", "Schlauch", "Dichtung", "Sensor", "Regler",
    "Kugelhahn", "Fitting", "Rinnenstein", "Auskleidefolie",
    "Pflegemittel", "Gegenschwimmanlage", "Massageanlage",
    # Partials / mid-word (simulate live-search typing)
    "pump", "filt", "solar", "steuer", "heiz",
    "chlor", "ventil", "rohr", "schlauch", "mess",
    # Short single-letter/digit stubs (stress test the debounce path)
    "a", "p", "f", "r", "v",
    # Article-number stubs
    "100", "200", "3", "42", "99",
]

# ── Shared product-ID pool ────────────────────────────────────────────────────
# Populated by the first users to load any page; used by all users thereafter
# to open random product detail pages without re-scraping.

_discovered_ids: list[str] = []
_MAX_IDS = 500


# ── Helpers ───────────────────────────────────────────────────────────────────

def _register_ids(ids: list[str]) -> None:
    """Add newly found document IDs to the shared pool."""
    for doc_id in ids:
        if doc_id not in _discovered_ids:
            _discovered_ids.append(doc_id)
    # Trim oldest entries once we hit the cap
    if len(_discovered_ids) > _MAX_IDS:
        del _discovered_ids[: len(_discovered_ids) - _MAX_IDS]


def _catalog_url(
    section: str | None = None,
    q: str | None = None,
    sort: str | None = None,
    direction: str | None = None,
) -> str:
    sort_key, sort_dir = random.choice(SORT_OPTIONS)
    params: dict[str, str] = {
        "section":  section   or random.choice(SECTIONS_ALL),
        "sort":     sort      or sort_key,
        "dir":      direction or sort_dir,
    }
    if q:
        params["q"] = q
    return "/products/all?" + urlencode(params)


# ── Mixin with shared browser-like behaviour ──────────────────────────────────

class _BrowserMixin:
    """
    Common page-fetching helpers shared across all user classes.

    Naming convention used in self.client.get(name=…):
        HOME     /
        ALL      /products/all
        CATEGORY /products/all?section=*
        SEARCH   /products/all?q=*
        PRODUCT  /products/[id]
        API      /api/auth/me
    """

    # -- low-level helpers ----------------------------------------------------

    def _extract_detail_paths(self, html: str) -> list[str]:
        """Return /products/<id> paths found in rendered HTML."""
        paths = []
        for href in HREF_RE.findall(html):
            path = urlsplit(href.strip()).path
            if DETAIL_PATH_RE.fullmatch(path) and "/edit" not in path and not path.endswith("/new"):
                paths.append(path)
                # Harvest the doc ID while we're here
                doc_id = path.split("/products/", 1)[-1]
                if doc_id and doc_id not in _discovered_ids:
                    _discovered_ids.append(doc_id)
        return list(dict.fromkeys(paths))  # deduplicated, order preserved

    # -- page fetches ---------------------------------------------------------

    def _visit_home(self) -> str:
        resp = self.client.get("/", name="HOME /")
        html = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        return html

    def _visit_all(self) -> str:
        resp = self.client.get(_catalog_url(), name="ALL  /products/all")
        html = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        return html

    def _visit_category(self, section: str | None = None) -> str:
        sec  = section or random.choice(SECTIONS_RUBRIK)
        url  = _catalog_url(section=sec)
        resp = self.client.get(url, name="CATEGORY /products/all?section=*")
        html = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        return html

    def _visit_search(self, term: str | None = None) -> str:
        q    = term or random.choice(SEARCH_TERMS)
        url  = _catalog_url(q=q)
        resp = self.client.get(url, name="SEARCH /products/all?q=*")
        html = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        return html

    def _visit_product(self, doc_id: str) -> str:
        resp = self.client.get(f"/products/{doc_id}", name="PRODUCT /products/[id]")
        html = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        return html

    def _visit_random_product(self) -> str | None:
        """Open a random product from the discovered pool; return HTML or None."""
        if not _discovered_ids:
            self._visit_all()   # populate the pool first
            if not _discovered_ids:
                return None
        return self._visit_product(random.choice(_discovered_ids))

    def _visit_product_from(self, html: str) -> str | None:
        """Pick a random product link from `html` and open it."""
        paths = self._extract_detail_paths(html)
        if not paths:
            return self._visit_random_product()
        return self._visit_product(random.choice(paths).split("/products/", 1)[-1])


# ── User personas ─────────────────────────────────────────────────────────────

class HomeBrowserUser(_BrowserMixin, HttpUser):
    """
    Lands on the home page, clicks a rubrik tile into the catalogue,
    and occasionally digs into individual product pages.

    Think time: 2 – 6 s  (casual, deliberate browsing)
    """

    wait_time = between(2.0, 6.0)

    def on_start(self) -> None:
        self._visit_home()

    @task(5)
    def home_then_category(self) -> None:
        """Home → click a rubrik tile → browse the category listing."""
        self._visit_home()
        self._visit_category()

    @task(4)
    def home_then_category_then_item(self) -> None:
        """Home → rubrik category → open one product."""
        self._visit_home()
        html = self._visit_category()
        self._visit_product_from(html)

    @task(2)
    def home_then_all_products(self) -> None:
        """Home → full product listing."""
        self._visit_home()
        self._visit_all()

    @task(1)
    def home_then_random_item(self) -> None:
        """Home → jump straight to a known product."""
        self._visit_home()
        self._visit_random_product()


class CatalogBrowserUser(_BrowserMixin, HttpUser):
    """
    Spends most of their time in /products/all, filtering by rubrik sections,
    sorting, and clicking into product detail pages.

    Think time: 0.8 – 3 s  (focused product research)
    """

    wait_time = between(0.8, 3.0)

    def on_start(self) -> None:
        self._visit_all()

    @task(6)
    def browse_section_click_item(self) -> None:
        """Filter by a rubrik section, then open a product."""
        html = self._visit_category()
        self._visit_product_from(html)

    @task(5)
    def browse_all_click_item(self) -> None:
        """Full listing, random sort, then click a product."""
        html = self._visit_all()
        self._visit_product_from(html)

    @task(4)
    def browse_two_sections(self) -> None:
        """Browse one rubrik category, then switch to another."""
        self._visit_category()
        self._visit_category()

    @task(3)
    def browse_section_back_to_all(self) -> None:
        """Filter by section, then clear filter back to all."""
        self._visit_category()
        self._visit_all()

    @task(2)
    def product_deep_dive(self) -> None:
        """Open a product, then open a second product from the detail page."""
        html = self._visit_random_product() or ""
        if html:
            self._visit_product_from(html)

    @task(1)
    def jump_straight_to_item(self) -> None:
        """Open a random known product without going via the listing first."""
        self._visit_random_product()


class SearchExplorerUser(_BrowserMixin, HttpUser):
    """
    Types search terms (or partial terms), browses results, and follows links
    to product detail pages.  Exercises the query-string caching path heavily.

    Think time: 0.5 – 2.5 s  (fast, intent-driven)
    """

    wait_time = between(0.5, 2.5)

    def on_start(self) -> None:
        # First warm-up: fetch a search page so we have some IDs immediately
        self._visit_search()

    @task(6)
    def search_and_open_result(self) -> None:
        """Search by keyword → open a matching product."""
        html = self._visit_search()
        self._visit_product_from(html)

    @task(5)
    def search_within_section(self) -> None:
        """Search with both a keyword and a rubrik filter."""
        section = random.choice(SECTIONS_RUBRIK)
        term    = random.choice(SEARCH_TERMS)
        url     = _catalog_url(section=section, q=term)
        resp    = self.client.get(url, name="SEARCH /products/all?q=*")
        html    = resp.text or ""
        self._extract_detail_paths(html)
        self._auth_check()
        self._visit_product_from(html)

    @task(4)
    def search_then_refine(self) -> None:
        """First search → then a second narrower search → open a result."""
        broad_term   = random.choice(SEARCH_TERMS)
        refined_term = broad_term + random.choice(SEARCH_TERMS[-5:])   # longer query
        self._visit_search(broad_term)
        html = self._visit_search(refined_term)
        self._visit_product_from(html)

    @task(3)
    def partial_term_search(self) -> None:
        """
        Simulate the TopBar live-search typing:
        fire a 2–3 char prefix, then the full word.
        """
        term   = random.choice([t for t in SEARCH_TERMS if len(t) >= 4])
        prefix = term[:random.randint(2, 3)]
        self._visit_search(prefix)          # partial → debounce fires
        html = self._visit_search(term)     # full term
        self._visit_product_from(html)

    @task(2)
    def search_and_browse_multiple_results(self) -> None:
        """Search → open two different results back-to-back."""
        html = self._visit_search()
        paths = self._extract_detail_paths(html)
        if len(paths) >= 2:
            random.shuffle(paths)
            self._visit_product(paths[0].split("/products/", 1)[-1])
            self._visit_product(paths[1].split("/products/", 1)[-1])
        elif paths:
            self._visit_product(paths[0].split("/products/", 1)[-1])

    @task(1)
    def search_no_results_path(self) -> None:
        """
        Search for a nonsense term that is unlikely to match anything.
        Exercises the empty-results render path on the server.
        """
        gibberish = "zzzxxx" + str(random.randint(1000, 9999))
        self._visit_search(gibberish)
