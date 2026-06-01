import { type NextRequest, NextResponse } from "next/server";
import { cacheLife, cacheTag } from "next/cache";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

type StrapiListResponse<T> = {
  data?: T[];
  meta?: {
    pagination?: {
      page?: number;
      pageSize?: number;
      pageCount?: number;
      total?: number;
    };
  };
};

type GraphNode = {
  id: string;
  label: string;
  type: "all" | "category" | "product";
  category?: string;
};

type GraphEdge = {
  source: string;
  target: string;
  type: "all-category" | "category-product" | "product-product";
};

type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Record<string, { x: number; y: number }>;
  totalProducts: number;
};

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";
const PAGE_SIZE = 100;

/* Simulation space floor. The aspect ratio mirrors the 700×520 canvas in
 * `admin-panel.tsx` (~1.346) so the laid-out bounding box matches the
 * display area — without this, a square sim box laid into a wide canvas
 * leaves wide vertical strips of empty space on either side and the
 * category ring touches the bbox edge on top/bottom, making everything
 * look "pushed to the edges of a small box".
 *
 * These are the *minimum* sim dimensions; `buildGraphLayout` grows them
 * dynamically when the largest category's product fan would otherwise
 * overrun the box and clamp dozens of dots onto the edge (which shows
 * up visually as a line of nodes on the boundary). */
const MIN_SIM_W = 2200;
const MIN_SIM_H = 1640;
const SIM_ASPECT = MIN_SIM_W / MIN_SIM_H; // ≈1.341

const PRODUCT_RELAXATION_STEPS = 12;
const PRODUCT_ATTRACTION = 0.28;
const PRODUCT_BASE_SPREAD = 54;
const ISOLATED_SPREAD = 220;
const PRODUCT_MIN_DISTANCE = 84;
const PRODUCT_COLLISION_STEPS = 4;
/* Per-ring radial step used by the isolated-product seed positioning
 * (`r = ISOLATED_SPREAD + ring * ISOLATED_RING_STEP`). Hoisted out of
 * the layout loop so the planner can use the same value when
 * estimating the worst-case reach of the outermost product.
 * Bigger than the inter-product min distance so successive rings don't
 * sit on top of each other once collision resolution kicks in. */
const ISOLATED_RING_STEP = 32;
/* Padding floor (px in sim coords) reserved between the category ring
 * and the boundary so the outermost product fan-out always has room to
 * stay inside [8, SIM-8] without `clamp()` having to chop nodes onto
 * the edge. Real padding is computed per-request from the largest
 * category's expected reach. */
const BASE_RING_PADDING = ISOLATED_SPREAD + 60;
/* When growing the sim box, keep the category ring at least this wide
 * so categories stay visually distinct from the central "ALL" hub
 * instead of being shoved into the middle. */
const TARGET_RING_RX = 900;
/* Hard floor on the angular sector a category gets, even if it has 0
 * products. Without this, an empty cat would get 0 radians and stack
 * on top of its neighbour. ~3° gives the marker visible breathing room. */
const MIN_CAT_ANGULAR_SLOT = 0.055; // ≈ 3.15°

/**
 * Per-category layout metrics: how much angular pie-slice each category
 * gets around the central "ALL" hub, and how far its products fan out.
 *
 * Angular weight uses √(N+1) (rather than N): a category with 1000
 * products gets ~32× the slot of a 1-product category, not 1000×. This
 * keeps "unassigned" (typically the huge majority) from swallowing the
 * entire ring while still giving it the lion's share — exactly enough
 * that its fan-out doesn't collide with the small categories on either
 * side.
 */
type CatLayoutMetrics = {
  id: string;
  count: number;
  weight: number;
  angularSize: number; // radians
  centerAngle: number; // radians, measured CCW from +x
  reach: number;       // distance from cat centre to outermost product
};

function planCatLayouts(catNodes: GraphNode[], byCat: Map<string, GraphNode[]>): CatLayoutMetrics[] {
  const layouts: CatLayoutMetrics[] = catNodes.map((n) => {
    const count = byCat.get(n.id)?.length ?? 0;
    return {
      id: n.id,
      count,
      weight: Math.sqrt(count + 1) + 0.3,
      angularSize: 0,
      centerAngle: 0,
      reach: 0,
    };
  });

  // Allocate angular pie-slices proportional to weight, with a floor so
  // small/empty cats don't disappear behind their neighbours.
  const rawTotalWeight = layouts.reduce((s, c) => s + c.weight, 0);
  if (rawTotalWeight <= 0 || layouts.length === 0) return layouts;

  // First pass: provisional sizes using raw weights.
  const provisional = layouts.map((c) => (2 * Math.PI * c.weight) / rawTotalWeight);
  // Re-distribute: anything under the floor gets bumped to MIN_CAT_ANGULAR_SLOT;
  // the deficit comes proportionally out of categories above the floor.
  let deficit = 0;
  let surplus = 0;
  for (const a of provisional) {
    if (a < MIN_CAT_ANGULAR_SLOT) deficit += MIN_CAT_ANGULAR_SLOT - a;
    else surplus += a - MIN_CAT_ANGULAR_SLOT;
  }
  const sized = provisional.map((a) => {
    if (a < MIN_CAT_ANGULAR_SLOT) return MIN_CAT_ANGULAR_SLOT;
    if (surplus <= 0) return a;
    return a - ((a - MIN_CAT_ANGULAR_SLOT) / surplus) * deficit;
  });

  // Cumulative placement, starting at the top (−π/2) and sweeping CW.
  let cumulative = -Math.PI / 2;
  for (let i = 0; i < layouts.length; i++) {
    const size = sized[i]!;
    layouts[i]!.angularSize = size;
    layouts[i]!.centerAngle = cumulative + size / 2;
    cumulative += size;
  }

  // Reach mirrors the seed loop's `r = ISOLATED_SPREAD + ring·STEP`.
  for (const c of layouts) {
    if (c.count <= 0) { c.reach = ISOLATED_SPREAD; continue; }
    const ringCount = Math.ceil(Math.sqrt(c.count));
    c.reach = ISOLATED_SPREAD + ringCount * ISOLATED_RING_STEP + PRODUCT_MIN_DISTANCE;
  }

  return layouts;
}

/**
 * Pick the SIM box (and ring padding) so that every category's
 * angular pie-slice at radius RING_RX is wide enough to swallow its
 * product fan-out without spilling into neighbouring categories.
 *
 * Geometric constraint: the chord across the slot at radius RX is
 *   chord = 2 · RX · sin(angularSize / 2)
 * The category's fan-out has diameter 2 · reach, so:
 *   2 · RX · sin(angularSize/2) ≥ 2 · reach
 *   → RX ≥ reach / sin(angularSize/2)
 *
 * We pick RX = max over all categories of that bound, then derive
 * SIM_W from RX + padding. Without this, dense categories used to
 * spill their products on top of the neighbouring categories' fans.
 */
function planSimDimensions(catLayouts: CatLayoutMetrics[]): {
  simW: number;
  simH: number;
  ringPadding: number;
} {
  let requiredRX = TARGET_RING_RX;
  let maxReach = 0;
  for (const c of catLayouts) {
    if (c.reach > maxReach) maxReach = c.reach;
    const sinHalf = Math.sin(c.angularSize / 2);
    if (sinHalf < 0.001) continue;
    const need = c.reach / sinHalf;
    if (need > requiredRX) requiredRX = need;
  }
  const ringPadding = Math.max(BASE_RING_PADDING, maxReach + 80);
  const simW = Math.max(MIN_SIM_W, 2 * (requiredRX + ringPadding));
  const simH = Math.max(MIN_SIM_H, Math.round(simW / SIM_ASPECT));
  return { simW, simH, ringPadding };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function targetRadiusForDegree(degree: number): number {
  if (degree <= 0) return ISOLATED_SPREAD;
  if (degree === 1) return 114;
  if (degree === 2) return 92;
  if (degree === 3) return 76;
  return PRODUCT_BASE_SPREAD + Math.max(0, 4 - Math.min(degree, 8)) * 4;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function buildCategoryList(): string[] {
  const rubriks = Array.from({ length: 15 }, (_, i) => `r${String(i + 1).padStart(2, "0")}`);
  return ["all", ...rubriks, "replacements", "extra", "unassigned"];
}

function parseText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function extractRubrikString(value: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = extractRubrikString(item, depth + 1);
      if (s) return s;
    }
    return "";
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["value", "code", "label", "name", "rubrik", "text"]) {
    const s = extractRubrikString(obj[key], depth + 1);
    if (s) return s;
  }
  for (const v of Object.values(obj)) {
    const s = extractRubrikString(v, depth + 1);
    if (s) return s;
  }
  return "";
}

function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const attributes = raw.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    return { ...raw, ...(attributes as Record<string, unknown>) };
  }
  return raw;
}

function parseRubrikCategory(value: unknown): string {
  const key = extractRubrikString(value).toLowerCase();
  if (key === "replacement" || key === "replacements") return "replacements";
  if (key === "extra" || key === "extras") return "extra";
  const match = key.match(/^(?:rubrik[-_\s]*)?(?:r)?0*(\d{1,2})$/i);
  if (match) {
    const numeric = Number.parseInt(match[1]!, 10);
    if (numeric >= 1 && numeric <= 15) return `r${String(numeric).padStart(2, "0")}`;
  }
  return "unassigned";
}

/**
 * Coerce whatever Strapi gave us for the `links` field into an array of
 * documentId strings.
 *
 * Strapi has surfaced this field in three different shapes across the
 * codebase's history:
 *
 *   1. A native JSON array — when the field is declared as `json` Strapi
 *      parses the column server-side and returns `["docId1","docId2"]`.
 *   2. A double-stringified JSON string — what `save-links/route.ts`
 *      writes (`data: { links: JSON.stringify(array) }`). Strapi treats
 *      this as opaque text and echoes the same string back.
 *   3. A newline-delimited blob — pre-import legacy format.
 *
 * The previous implementation ran `parseText(rawLinks)` first which
 * collapsed any non-string value (including the JSON array case) to `""`,
 * silently returning zero links. That made the stats page report 0
 * cross-links for databases that actually have links. This rewrite
 * handles all three shapes plus the occasional object-wrapped target
 * (`{ documentId: "…" }`) that some Strapi populate payloads emit.
 */
function parseLinkIds(rawLinks: unknown): string[] {
  if (rawLinks == null) return [];

  const fromArray = (arr: unknown[]): string[] =>
    arr
      .flatMap((v): string[] => {
        if (typeof v === "string" || typeof v === "number") {
          return [String(v).trim()];
        }
        if (v && typeof v === "object") {
          const obj = v as Record<string, unknown>;
          const id = obj.documentId ?? obj.id ?? obj.value;
          if (typeof id === "string" || typeof id === "number") {
            return [String(id).trim()];
          }
        }
        return [];
      })
      .filter(Boolean);

  /* Case 1 — Strapi returned a parsed JSON array. */
  if (Array.isArray(rawLinks)) return fromArray(rawLinks);

  /* Case 2 + 3 — Strapi returned a string (either JSON.stringify'd array
     or newline-delimited legacy text). */
  if (typeof rawLinks === "string") {
    const text = rawLinks.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return fromArray(parsed);
    } catch {
      /* not JSON — fall through to newline-delimited handling */
    }
    return text.split(/\n+/).map((v) => v.trim()).filter(Boolean);
  }

  /* Defensive — a single object reference (e.g. populate=links emitted a
     relation rather than the json column). */
  if (typeof rawLinks === "object") {
    return fromArray([rawLinks]);
  }

  return [];
}

async function fetchCollectionPage<T>(
  path: string,
  page: number,
  pageSize = PAGE_SIZE,
): Promise<{ data: T[]; total: number; pageSize: number }> {
  const join = path.includes("?") ? "&" : "?";
  const url =
    `${STRAPI_BASE_URL}${path}${join}` +
    `sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${pageSize}&pagination[withCount]=true`;

  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });

  if (!response.ok) throw new Error(`Failed to fetch ${path} (status ${response.status}).`);

  const payload = (await response.json()) as StrapiListResponse<T>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  const effectivePageSize = payload.meta?.pagination?.pageSize ?? pageSize;
  const total = payload.meta?.pagination?.total ?? data.length;

  return { data, total, pageSize: effectivePageSize };
}

async function fetchAllCollection<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  const first = await fetchCollectionPage<T>(path, 1);
  all.push(...first.data);

  const pageCount = Math.ceil(first.total / first.pageSize);
  if (pageCount > 1) {
    const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    const chunkSize = 6;
    for (let i = 0; i < remaining.length; i += chunkSize) {
      const chunk = remaining.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map((page) => fetchCollectionPage<T>(path, page, first.pageSize)),
      );
      for (const r of results) all.push(...r.data);
    }
  }

  return all;
}

/**
 * Deterministic graph layout. Every product (article) the database contains
 * is laid out — there is no truncation, sampling or per-category cap.
 *
 * Pipeline:
 *   1. Categories on a ring around an "ALL" hub.
 *   2. Products fanned out in concentric rings around each category anchor.
 *   3. Relaxation pass: cross-linked products pull together, isolated nodes
 *      push outward so they stay legible.
 *   4. Spatial-hash collision pass (O(n × local-density)) so even databases
 *      with thousands of articles finish layout in milliseconds.
 *
 * The result is deterministic so it can safely be cached by the surrounding
 * `"use cache"` wrapper.
 */
function buildGraphLayout(allNodes: GraphNode[], allEdges: GraphEdge[]): GraphLayout {
  const catNodes     = allNodes.filter((n) => n.type === "category");
  const allProdNodes = allNodes.filter((n) => n.type === "product");
  const totalProducts = allProdNodes.length;

  // Nodes returned to client: "all" hub + categories + every product.
  const allHub = allNodes.find((n) => n.id === "all") ?? { id: "all", label: "All", type: "all" as const };
  const nodes: GraphNode[] = [allHub, ...catNodes, ...allProdNodes];

  // Edges: only product-product links between products.
  const edges: GraphEdge[] = allEdges.filter((e) => e.type === "product-product");

  // Group products by category up front — needed both to size the SIM box
  // (the largest cluster drives the required radius) and for the seed loop
  // below.
  const byCat = new Map<string, GraphNode[]>();
  for (const n of allProdNodes) {
    const cat = n.category ?? "unassigned";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(n);
  }
  let maxCatSize = 0;
  for (const list of byCat.values()) if (list.length > maxCatSize) maxCatSize = list.length;

  // Pick a SIM box big enough that no `clamp()` snaps the outermost
  // product onto the edge — the static 2200×1640 box used to collapse
  // dense categories into a "line of dots on the boundary" because the
  // ring fan-out (∝ √N) exceeded the padding for any category with
  // more than ~150 products.
  const { simW: SIM_W, simH: SIM_H, ringPadding: RING_PADDING } =
    computeSimDimensions(maxCatSize);

  // Positions ─────────────────────────────────────────────────────────────
  const layoutPositions: Record<string, { x: number; y: number }> = {};
  const cx = SIM_W / 2, cy = SIM_H / 2;
  /* Place categories on an *ellipse* sized to fill the SIM box minus the
   * product-fan padding. Using an ellipse (rather than a circle inscribed
   * in the shorter axis) means the layout's bounding box has the same
   * aspect ratio as the canvas, so fitView() can scale it up to fill
   * almost the entire display area instead of leaving big horizontal
   * strips of empty space. */
  const RING_RX = SIM_W / 2 - RING_PADDING;
  const RING_RY = SIM_H / 2 - RING_PADDING;

  // "ALL" hub at centre
  layoutPositions["all"] = { x: cx, y: cy };

  // Categories on an ellipse.
  const catPositions = new Map<string, { x: number; y: number }>();
  catNodes.forEach((n, i) => {
    const angle = (i / catNodes.length) * Math.PI * 2 - Math.PI / 2;
    const pos = {
      x: cx + Math.cos(angle) * RING_RX,
      y: cy + Math.sin(angle) * RING_RY,
    };
    catPositions.set(n.id, pos);
    layoutPositions[n.id] = pos;
  });

  const neighbors = new Map<string, string[]>();
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const listA = neighbors.get(edge.source) ?? [];
    listA.push(edge.target);
    neighbors.set(edge.source, listA);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  /* Concentric-ring seed positions for every product around its category.
   *
   * The previous implementation forced `ring = 0` whenever the product had
   * no cross-links, which collapsed `ringSize` to 1 and made
   *   angle = (i / 1) × 2π = 0
   * for every isolated product in the same category — so all of them spawned
   * stacked on top of each other at the 3 o'clock position. Collision
   * resolution then pushed them out in a single line and the visible cluster
   * ended up looking like every dot was glued to the edge of a tiny box.
   *
   * Now isolated products share the same sqrt-based ring scheme as connected
   * ones; only the *radius* differs (isolated nodes sit on a bigger orbit so
   * they're easy to scan visually). */
  for (const [cat, prods] of byCat) {
    const cp = catPositions.get(cat) ?? { x: cx, y: cy };
    prods.forEach((n, i) => {
      const d = degree.get(n.id) ?? 0;
      const ring = Math.floor(Math.sqrt(i + 1));
      const ringStart = ring * ring;
      const ringEnd = (ring + 1) * (ring + 1);
      const ringSize = Math.max(1, ringEnd - ringStart);
      const posInRing = i - ringStart;
      const angle = (posInRing / ringSize) * Math.PI * 2 + ring * 0.5;
      const r = targetRadiusForDegree(d) + ring * (d <= 0 ? ISOLATED_RING_STEP : 6);
      layoutPositions[n.id] = {
        x: clamp(cp.x + Math.cos(angle) * r, 8, SIM_W - 8),
        y: clamp(cp.y + Math.sin(angle) * r, 8, SIM_H - 8),
      };
    });
  }

  // Deterministic relaxation: linked products pull together, while isolated
  // nodes are pushed farther away from their category anchor so they stay legible.
  for (let step = 0; step < PRODUCT_RELAXATION_STEPS; step++) {
    const next = new Map<string, { x: number; y: number }>();

    for (const n of allProdNodes) {
      const current = layoutPositions[n.id] ?? { x: cx, y: cy };
      const cp = catPositions.get(n.category ?? "unassigned") ?? { x: cx, y: cy };
      const d = degree.get(n.id) ?? 0;
      const targetR = targetRadiusForDegree(d);

      const dx = current.x - cp.x;
      const dy = current.y - cp.y;
      const dist = Math.hypot(dx, dy) || 1;
      const radialTarget = {
        x: cp.x + (dx / dist) * targetR,
        y: cp.y + (dy / dist) * targetR,
      };

      let target = radialTarget;
      const linked = neighbors.get(n.id) ?? [];
      if (linked.length > 0) {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (const linkedId of linked) {
          const p = layoutPositions[linkedId];
          if (!p) continue;
          sumX += p.x;
          sumY += p.y;
          count++;
        }
        if (count > 0) {
          const neighborTarget = { x: sumX / count, y: sumY / count };
          const attraction = Math.min(0.42, PRODUCT_ATTRACTION + Math.min(d, 6) * 0.03);
          target = {
            x: radialTarget.x + (neighborTarget.x - radialTarget.x) * attraction,
            y: radialTarget.y + (neighborTarget.y - radialTarget.y) * attraction,
          };
        }
      }

      const settle = d <= 0 ? 0.18 : 0.12;
      next.set(n.id, {
        x: clamp(current.x + (target.x - current.x) * settle, 8, SIM_W - 8),
        y: clamp(current.y + (target.y - current.y) * settle, 8, SIM_H - 8),
      });
    }

    for (const [id, pos] of next) layoutPositions[id] = pos;
  }

  /* Final collision resolution keeps nodes legible even after linked products
   * are pulled closer together by the attraction pass above.
   *
   * Uses a spatial-hash grid (cell size = PRODUCT_MIN_DISTANCE) so each node
   * only checks the ≤9 cells in its 3×3 neighbourhood instead of every other
   * node. This drops the pass from O(n²) to O(n × local-density) — for a
   * 5 000-entry database that's ~25 M comparisons per step → a few thousand,
   * cutting first-load compute time by orders of magnitude.
   *
   * Without this, the synchronous build step inside `"use cache"` blocks the
   * route handler for many seconds on every cache miss, so the admin "DB
   * Statistics" page felt frozen on first open and after `revalidateTag`. */
  const CELL = PRODUCT_MIN_DISTANCE;
  const cellKey = (gx: number, gy: number) => gx * 100003 + gy; // pair → int hash

  for (let step = 0; step < PRODUCT_COLLISION_STEPS; step++) {
    /* Rebuild the grid each step because positions move between iterations. */
    const grid = new Map<number, number[]>();
    for (let i = 0; i < allProdNodes.length; i++) {
      const pos = layoutPositions[allProdNodes[i]!.id];
      if (!pos) continue;
      const k = cellKey(Math.floor(pos.x / CELL), Math.floor(pos.y / CELL));
      const bucket = grid.get(k);
      if (bucket) bucket.push(i);
      else grid.set(k, [i]);
    }

    const adjustments = new Map<string, { x: number; y: number }>();

    for (let i = 0; i < allProdNodes.length; i++) {
      const a = allProdNodes[i]!;
      const posA = layoutPositions[a.id];
      if (!posA) continue;

      const gx = Math.floor(posA.x / CELL);
      const gy = Math.floor(posA.y / CELL);

      /* 3×3 neighbourhood — anything outside is guaranteed > CELL away */
      for (let dgy = -1; dgy <= 1; dgy++) {
        for (let dgx = -1; dgx <= 1; dgx++) {
          const bucket = grid.get(cellKey(gx + dgx, gy + dgy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // process each pair once
            const b = allProdNodes[j]!;
            const posB = layoutPositions[b.id];
            if (!posB) continue;

            let dx = posB.x - posA.x;
            let dy = posB.y - posA.y;
            let dist = Math.hypot(dx, dy);
            if (dist >= PRODUCT_MIN_DISTANCE) continue;

            if (dist < 0.001) {
              const angle = ((i + 1) * 31 + (j + 1) * 17 + step * 13) % 360;
              dx = Math.cos((angle * Math.PI) / 180);
              dy = Math.sin((angle * Math.PI) / 180);
              dist = 1;
            }

            const overlap = (PRODUCT_MIN_DISTANCE - dist) / dist;
            const pushX = dx * overlap * 0.5;
            const pushY = dy * overlap * 0.5;

            const adjA = adjustments.get(a.id) ?? { x: 0, y: 0 };
            const adjB = adjustments.get(b.id) ?? { x: 0, y: 0 };
            adjA.x -= pushX;
            adjA.y -= pushY;
            adjB.x += pushX;
            adjB.y += pushY;
            adjustments.set(a.id, adjA);
            adjustments.set(b.id, adjB);
          }
        }
      }
    }

    let moved = false;
    for (const [id, delta] of adjustments) {
      const pos = layoutPositions[id];
      if (!pos) continue;
      const nextPos = {
        x: clamp(pos.x + delta.x, 8, SIM_W - 8),
        y: clamp(pos.y + delta.y, 8, SIM_H - 8),
      };
      if (nextPos.x !== pos.x || nextPos.y !== pos.y) moved = true;
      layoutPositions[id] = nextPos;
    }

    if (!moved) break;
  }

  return { nodes, edges, positions: layoutPositions, totalProducts };
}

/**
 * Raw, un-cached compute. Performs the full Strapi fetch + graph layout.
 *
 * Pulled out of the cached wrapper so the GET handler can bypass the
 * `"use cache"` memoization when the admin clicks "Refresh" with the
 * force-refresh option (`?nocache=1`). Otherwise a recent write (links
 * added in admin-panel) wouldn't reflect for up to 5 minutes — the
 * window in which the `cacheLife` revalidation hasn't fired yet.
 */
async function computeDbStatsRaw() {
  const [entriesRaw, usersRaw] = await Promise.all([
    fetchAllCollection<Record<string, unknown>>(
      "/api/entries?fields[0]=title&fields[1]=rubrik&fields[2]=links&fields[3]=documentId",
    ),
    fetchAllCollection<Record<string, unknown>>(
      "/api/customusers?fields[0]=email&fields[1]=confirmed&fields[2]=trusted&fields[3]=blocked&fields[4]=employee&fields[5]=administrator",
    ),
  ]);

  const entries = entriesRaw.map(normalizeRecord);
  const users   = usersRaw.map(normalizeRecord);

  const categories     = buildCategoryList();
  const categoryCounts: Record<string, number> = {};
  for (const cat of categories) categoryCounts[cat] = 0;

  // Build full node list (needed for accurate category counts and cross-links)
  const allNodes: GraphNode[] = [{ id: "all", label: "All", type: "all" }];
  const allEdges: GraphEdge[] = [];

  for (const cat of categories.filter((c) => c !== "all")) {
    allNodes.push({ id: cat, label: cat.toUpperCase(), type: "category" });
    allEdges.push({ source: "all", target: cat, type: "all-category" });
  }

  const idToDoc        = new Map<string, string>();
  const productNodeById = new Map<string, GraphNode>();

  for (const entry of entries) {
    const id         = Number(entry.id);
    const documentId = parseText(entry.documentId) || String(id);
    const title      = parseText(entry.title) || documentId;
    const category   = parseRubrikCategory(entry.rubrik);

    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    idToDoc.set(String(id), documentId);

    const nodeId = `product:${documentId}`;
    const node: GraphNode = { id: nodeId, label: title, type: "product", category };
    productNodeById.set(documentId, node);
    allNodes.push(node);
    allEdges.push({ source: category, target: nodeId, type: "category-product" });
  }

  /* ─── Product–product cross-link accounting ─────────────────────────────
   *
   * Each entry stores a `links` JSON field — an array of documentIds (or,
   * for legacy rows, numeric Strapi IDs) pointing to other entries. We
   * count this in several ways because the single "totalLinks" number we
   * used to return was deeply misleading:
   *
   *   - "Cross-links (pairs)" — the canonical headline: count of UNIQUE
   *     undirected pairs (A↔B counts once whether or not B.links also
   *     mentions A). This is what an admin usually means by "how many
   *     cross-links does the catalogue have?".
   *
   *   - "Link references" — raw count of every documentId entry across
   *     every entry's `links` field. This is the gross stored data and
   *     should be ≈ 2× the pair count when bidirectional consistency is
   *     intact. Divergence is itself a data-quality signal.
   *
   *   - "Entries with links" — denominator for "avg links / entry".
   *
   *   - "Dangling references" — references pointing at a documentId that
   *     no longer exists in `entries`. Old code silently dropped these,
   *     so corrupt data was invisible in the stats UI.
   *
   *   - "Self-references" — entries that link to themselves. Should be 0.
   *
   *   - "One-sided pairs" — pairs where only one side carries the
   *     reference (A.links has B but B.links does not have A). Bidirectional
   *     writes are how save-links works, so a non-zero count here means
   *     historical data was written before the bidirectional invariant
   *     was enforced. */

  const edgeKey       = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);
  const directedKey   = (a: string, b: string) => `${a}->${b}`;
  const undirectedSet = new Set<string>();
  const directedSet   = new Set<string>();

  let totalLinkReferences = 0;
  let entriesWithLinks    = 0;
  let danglingReferences  = 0;
  let selfReferences      = 0;

  for (const entry of entries) {
    const sourceDocId = parseText(entry.documentId);
    if (!sourceDocId) continue;

    const linkIds = parseLinkIds(entry.links);
    if (linkIds.length > 0) entriesWithLinks++;

    for (const linkedId of linkIds) {
      totalLinkReferences++;

      /* Resolve the target. Modern rows store documentIds; legacy rows
         stored numeric ids — fall back to the id-to-documentId map for
         those. If neither resolves, the reference is dangling. */
      const targetDoc = productNodeById.has(linkedId)
        ? linkedId
        : idToDoc.get(linkedId);

      if (!targetDoc || !productNodeById.has(targetDoc)) {
        danglingReferences++;
        continue;
      }
      if (targetDoc === sourceDocId) {
        selfReferences++;
        continue;
      }

      directedSet.add(directedKey(sourceDocId, targetDoc));
      undirectedSet.add(edgeKey(sourceDocId, targetDoc));
    }
  }

  /* Pairs that are present in only one direction. Bidirectional pairs
     have both A→B and B→A in `directedSet`; one-sided pairs are missing
     one half. */
  let oneSidedPairs = 0;
  for (const key of undirectedSet) {
    const [a, b] = key.split("::") as [string, string];
    const fwd = directedSet.has(directedKey(a, b));
    const rev = directedSet.has(directedKey(b, a));
    if (!(fwd && rev)) oneSidedPairs++;
  }

  /* Emit graph edges from the de-duplicated pair set so the visual matches
     the pair count exactly. */
  for (const key of undirectedSet) {
    const [a, b] = key.split("::") as [string, string];
    allEdges.push({
      source: `product:${a}`,
      target: `product:${b}`,
      type:   "product-product",
    });
  }

  const graph = buildGraphLayout(allNodes, allEdges);

  return {
    stats: {
      totalEntries:        entries.length,
      totalUsers:          users.length,
      totalLinkPairs:      undirectedSet.size,
      totalLinkReferences,
      entriesWithLinks,
      danglingReferences,
      selfReferences,
      oneSidedPairs,
      categories:          categoryCounts,
      generatedAt:         new Date().toISOString(),
    },
    graph,
  };
}

/**
 * Stale-while-revalidate wrapper around `computeDbStatsRaw`.
 *
 * Tuning:
 *   - `stale`      30 min — client router can keep showing the cached payload
 *                  for that long after the panel is reopened, so re-opening
 *                  the stats page from anywhere on the site is instant.
 *   - `revalidate` 10 min — background re-compute window. Live edits won't
 *                  appear until then unless save-links calls
 *                  `revalidateTag("entries")` (which it does).
 *   - `expire`     1 day  — hard upper bound; after this the next request
 *                  blocks on a fresh compute.
 *
 * Tagged with "entries" so any future call to `revalidateTag("entries")`
 * blows the cache away — handy for write paths that want their effects to
 * be visible on the next stats refresh.
 */
async function computeDbStatsCached() {
  "use cache";
  cacheLife({ stale: 1800, revalidate: 600, expire: 86400 });
  cacheTag("entries");
  return computeDbStatsRaw();
}

export async function GET(req: NextRequest) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  if (!STRAPI_API_TOKEN) return NextResponse.json({ error: "Missing STRAPI API token." }, { status: 500 });

  /* `?nocache=1` forces a fresh compute. The admin "Refresh" button in
     DBStatsContent passes this when the user explicitly wants up-to-date
     numbers after a recent write (e.g. just saved cross-links). Without it
     the answer can be up to 5 minutes stale. */
  const noCache = new URL(req.url).searchParams.get("nocache") === "1";

  try {
    const result = noCache
      ? await computeDbStatsRaw()
      : await computeDbStatsCached();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compute DB stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
