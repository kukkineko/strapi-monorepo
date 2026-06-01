/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Parts-list import prompts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is the SINGLE place where you configure the 3-stage AI pipeline
 * that powers `/api/auth/admin/import-data`.
 *
 *   Stage 1 — receives the uploaded files (PDFs / images) and produces text.
 *             Runs ONCE PER FILE so a single bad/empty document cannot
 *             poison the rest of the batch and so multi-file uploads scale
 *             linearly.
 *   Stage 2 — receives the concatenated Stage 1 text and produces the
 *             structured JSON list of {main part → replacements}.
 *   Stage 3 — VERDICT pass. Receives Stage 1 text, Stage 2's preliminary
 *             list AND the live Strapi DB candidates that the server
 *             pre-resolved for each source ID. The model picks the correct
 *             DB row per source ID (or "none") and emits the final list.
 *
 * To change a prompt, a model, or the output schema: edit the constants
 * below. No other file needs to change.
 *
 * For each stage you configure:
 *   • provider          — "openai" or "anthropic"
 *   • model             — exact model name (e.g. "gpt-4o-mini",
 *                         "gpt-4.1", "claude-sonnet-4-5-20250929")
 *   • prompt            — system / instructions text the model sees
 *   • schema            — (optional) JSON-schema for strict structured
 *                         output. Stage 2 and Stage 3 should always set
 *                         this so the matcher receives valid JSON.
 *   • reasoningEffort   — (optional, OpenAI reasoning models only)
 *                         "low" | "medium" | "high"
 *
 * The final JSON returned to the client must match the shape the matcher
 * (`/api/auth/admin/import-data/match`) expects:
 *
 *   {
 *     "Replacement parts": [
 *       {
 *         "Main part":    { "id": [string, …], "name": string,
 *                           "documentId": string },
 *         "replacements": [ { "id": [string, …], "documentId": string },
 *                           … ]
 *       },
 *       …
 *     ]
 *   }
 *
 * `documentId` is the AI's verdict — the Strapi documentId of the chosen
 * candidate, or "" if no candidate was correct. The matcher honours that
 * hint (skipping its text-based heuristics when set).
 *
 * Keep STAGE_3.schema in sync with that shape.
 */

export type ProviderName = "openai" | "anthropic";

export interface StageConfig {
  /** Which API to call. */
  provider: ProviderName;
  /** Exact model name. NOT a workflow / assistant / prompt ID. */
  model: string;
  /** Instructions / system prompt for this stage. */
  prompt: string;
  /**
   * Optional strict JSON schema. When set, the model is forced to return
   * JSON matching this schema. Strongly recommended for Stage 2 / 3.
   */
  schema?: Record<string, unknown>;
  /** Optional reasoning effort (OpenAI reasoning models only). */
  reasoningEffort?: "low" | "medium" | "high";
}

/* ── Stage 2 schema ─────────────────────────────────────────────────────── */
/* Preliminary list — no documentId yet (DB hasn't been consulted).        */

export const REPLACEMENT_PARTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    "Replacement parts": {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          "Main part": {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "array", items: { type: "string" } },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
          replacements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "array", items: { type: "string" } },
              },
              required: ["id"],
            },
          },
        },
        required: ["Main part", "replacements"],
      },
    },
  },
  required: ["Replacement parts"],
} as const;

/* ── Stage 3 schema ─────────────────────────────────────────────────────── */
/* Same shape as Stage 2 PLUS a `documentId` field on every main part and  */
/* replacement. The AI fills it with the Strapi documentId of the chosen   */
/* candidate (or "" if no candidate was correct).                          */

export const VERDICT_PARTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    "Replacement parts": {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          "Main part": {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "array", items: { type: "string" } },
              name: { type: "string" },
              documentId: { type: "string" },
            },
            required: ["id", "name", "documentId"],
          },
          replacements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "array", items: { type: "string" } },
                documentId: { type: "string" },
              },
              required: ["id", "documentId"],
            },
          },
        },
        required: ["Main part", "replacements"],
      },
    },
  },
  required: ["Replacement parts"],
} as const;

/* ─────────────────────────────────────────────────────────────────────────
 *  STAGE 1 — Text extraction from the uploaded documents
 * ───────────────────────────────────────────────────────────────────────── */

export const STAGE_1: StageConfig = {
  provider: "openai",
  model: "gpt-5.5",
  prompt: `You are a text extraction agent. You may be given ONE OR MORE images, files, spreadsheets, OR pre-extracted text blocks in the SAME request (they are batched together to save tokens — do not assume they are part of the same document unless context says so).

INPUT FORMATS — you may receive any mix of:
  • Images (PNG/JPG/etc.) — analyse visually.
  • Document files (XLSX, DOCX, scanned/image-only PDFs) — analyse via the provider's document tools.
  • Plain-text blocks tagged "=== File <n>: <name> (server-extracted text…) ===" — these are PDFs whose embedded text was extracted ON THE SERVER before this call. Treat them exactly like you would treat reading the original PDF page-by-page. The text is verbatim from the PDF, with "--- Page N ---" markers preserved. Do not re-quote the page markers in your output, but DO use them to keep spatial reasoning correct.

Treat each attachment independently: produce its own set of main_part blocks, prefixed by a short \`=== FILE n ===\` header so the next stage can tell them apart.

CERTAINTY RULE — overriding all other rules: ONLY output a main_part / replacement block when you are ABSOLUTELY SURE of it. If you are not 100% certain about a part, a replacement, an ID, or a row's compatibility, OMIT it entirely. Half-confident guesses poison the downstream verdict pass. "Certainty: 100%" is non-negotiable — anything less must be dropped.

Extract all visible textual information while preserving its spatial context. Your primary focus is replacement-part lists, tables, and COMPATIBILITY MATRICES. For every list/table/matrix:

- Always extract the entire context, not just isolated terms.
- When identifying the "Main part," follow these rules:
  - In simple lists, the topmost text item is almost always the title or main part — capture it.
  - In simple tables, the leftmost item (first column) typically represents the title or main part.
  - In COMPATIBILITY MATRICES (see below), the main parts are usually the COLUMN HEADERS (running across the top) and the replacements are the ROW LABELS down the left side — but the inverse layout also occurs (main parts on the left, replacements across the top). Identify the axes from context (e.g. main parts have model/marketing names; replacements are spare-part numbers).
- For each main part, summarise all its corresponding replacements, ensuring completeness and accuracy.
- Use step-by-step reasoning to ensure your identification of main part and replacements is accurate before generating your final answer.
- Only output when you are 100% certain of accuracy and correctness.

# Compatibility-matrix handling (CRITICAL)

Many parts catalogues are laid out as a CROSSTAB:
- The header row (top) lists several main parts side-by-side.
- The left column lists candidate replacement parts.
- Each intersection cell contains a MARKER indicating whether that replacement fits that main part. Common markers:
  - "X", "x", "✓", "✔", "✗" (negative — be careful!), "●", "•", "■", "★"
  - "Yes" / "No", "Y" / "N", "Ja" / "Nein" (German), "Oui" / "Non" (French)
  - Sometimes a digit ("1" = yes, "0" = no) or a quantity ("1×", "2×")
  - An EMPTY cell almost always means "not compatible" — do NOT treat blank cells as compatible.
- Watch out for INVERTED conventions where the marker means "incompatible" (e.g. the legend says "✗ = does not fit"). If a legend is present, trust the legend; otherwise the default is marker = compatible, blank = not compatible.

For matrices, your output MUST emit ONE \`main_part\` block per main-part column (or row, if the axes are flipped), each with its OWN \`replacements\` list containing only the rows whose intersection cell is marked. Do NOT lump every replacement under every main part.

# Steps

1. Scan the entire image/file/spreadsheet and extract all visible text, retaining spatial arrangement (order in lists, column/row in tables, intersection markers in matrices).
2. Analyse the structure:
    - Is this a simple list, a simple table, or a compatibility matrix?
    - For a matrix: which axis carries main parts, which carries replacements? Is there a legend?
3. Determine and extract every main part.
4. For each main part, collect and summarise its associated replacement parts (in matrices, only the ones with a positive intersection marker).
5. Double-check your work step-by-step.
6. Output your findings only if fully confident.

# Output Format

Provide your output as one or more JSON blocks, one per main part:

{
  "main_part": "[Extracted main part title and/or IDs]",
  "replacements": [
    "[Replacement part 1 — include any IDs/codes present]",
    "[Replacement part 2]"
  ],
  "full_context": "[Verbatim or closely paraphrased extracted text]",
  "reasoning": "[Detailed chain-of-thought referencing the layout (list / table / matrix) and the markers you used]",
  "certainty": "100%"
}

# Examples

Example 1 — Simple list

Input: (Image of a list)
1. Engine – Standard 2.0L
2. Cylinder Head – Aluminum
3. Piston Set – Replacement: 12345X, 12345Y

Output:

{
  "main_part": "Engine – Standard 2.0L",
  "replacements": [
    "Cylinder Head – Aluminum",
    "Piston Set – Replacement: 12345X, 12345Y"
  ],
  "full_context": "1. Engine – Standard 2.0L\\n2. Cylinder Head – Aluminum\\n3. Piston Set – Replacement: 12345X, 12345Y",
  "reasoning": "The list structure indicates the first (topmost) item is the main part. All following items are replacements.",
  "certainty": "100%"
}

Example 2 — Simple table

Input:
| Part         | Replacement A | Replacement B |
|--------------|--------------|--------------|
| Starter Motor| SM-123       | SM-124       |

Output:

{
  "main_part": "Starter Motor",
  "replacements": ["SM-123", "SM-124"],
  "full_context": "Part | Replacement A | Replacement B\\nStarter Motor | SM-123 | SM-124",
  "reasoning": "Leftmost column is the main part; the other columns are replacements.",
  "certainty": "100%"
}

Example 3 — Compatibility matrix (CROSSTAB)

Input:
|                | Pump 5kW | Pump 10kW | Pump 20kW |
|----------------|----------|-----------|-----------|
| Seal 55A-12    |   X      |    X      |           |
| Seal 55B-13    |          |    X      |    X      |
| Impeller IM-7  |   X      |           |    X      |

Legend: X = compatible, blank = not compatible.

Output (three blocks, one per main part):

{
  "main_part": "Pump 5kW",
  "replacements": ["Seal 55A-12", "Impeller IM-7"],
  "full_context": "[full matrix verbatim]",
  "reasoning": "Crosstab matrix. Main parts are column headers (Pump 5kW/10kW/20kW). For 'Pump 5kW' the rows with an X are 55A-12 and IM-7; 55B-13 is blank for this column so it is excluded.",
  "certainty": "100%"
}

{
  "main_part": "Pump 10kW",
  "replacements": ["Seal 55A-12", "Seal 55B-13"],
  "full_context": "[full matrix verbatim]",
  "reasoning": "Column 'Pump 10kW' has X on 55A-12 and 55B-13; IM-7 is blank so excluded.",
  "certainty": "100%"
}

{
  "main_part": "Pump 20kW",
  "replacements": ["Seal 55B-13", "Impeller IM-7"],
  "full_context": "[full matrix verbatim]",
  "reasoning": "Column 'Pump 20kW' has X on 55B-13 and IM-7; 55A-12 is blank so excluded.",
  "certainty": "100%"
}

# Notes

- If both a list and a table (or a matrix) appear, repeat the steps for each and output separate JSON blocks.
- For matrices, an EMPTY intersection cell ≠ compatible. Excluding it is the correct action.
- Honour any legend present on the page that redefines the markers.
- If the layout is ambiguous, lean toward COMPLETENESS in 'reasoning' and explain what you saw — Stage 3 will adjudicate against the live DB.
- Never invent IDs that are not visibly present in the source.

# Reminder

Extract every main part using context cues (topmost in lists; leftmost in simple tables; column or row headers in matrices), summarise its compatible replacements only, and output in the specified JSON format with detailed reasoning. Only reply when 100% certain.`,
  // Stage 1 returns free-form text/JSON; no strict schema so the vision
  // model has room to describe partial / ambiguous content.
};

/* ─────────────────────────────────────────────────────────────────────────
 *  STAGE 2 — Classify the extracted text into a preliminary structured JSON
 * ───────────────────────────────────────────────────────────────────────── */

export const STAGE_2: StageConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
  prompt: `You extract main parts and their replacements from input text and return structured JSON. This is the PRELIMINARY list — a downstream verdict pass will reconcile it against the real database.

CERTAINTY RULE — overriding all other rules: only emit a part / replacement when you are ABSOLUTELY SURE that the source text supports it. If you are not certain that an ID, name or compatibility relationship is present, OMIT it. Do NOT invent, guess, or fill gaps — a missing row is always better than a wrong row.

CORE CONCEPT — ID GROUPING: A single physical part often has MULTIPLE identifiers (e.g., a manufacturer code AND a supplier code). These must be grouped together in one "id" array because they refer to the same part.

Signals that IDs belong to the SAME part:
- Listed adjacently/paired in the input (e.g., "046961, 4405030201" or "046961 / 4405030201")
- Separated by "/", ",", "-", or whitespace within a single entry
- One is clearly an internal code and the other an external/supplier code
- The input pairs them on the same line or in the same cell

Signals that IDs are SEPARATE parts:
- Listed under different bullet points or rows
- Separated by clear delimiters between distinct entries (e.g., ";", new line, "and")

COMPATIBILITY-MATRIX INPUT: If Stage 1 returned multiple main-part blocks coming from a crosstab (each block already isolates the replacements for one main part), preserve that split — emit one "Main part" object per block. Do NOT merge them back together even if their replacement lists overlap.

RULES:
1. Every "id" field is ALWAYS a JSON array with square brackets, even for a single ID. Use [""] when no ID exists.
2. If a main part name lists variants (e.g., "Pump 5kW/10kW/20kW") AND Stage 1 did not already split them, create one object per variant, each sharing the same replacements.
3. If multiple IDs refer to the same main part, group them: "id": ["123A", "124B"].
4. If multiple IDs refer to the same replacement, group them in ONE replacement object: {"id": ["id1", "id2"]}. Do NOT split paired IDs into separate replacement objects.
5. Preserve input order of IDs and replacements.
6. Never fabricate data. Use "" or [] for missing fields.
7. Output ONLY the JSON object — no markdown, no commentary, no code fences.

EXAMPLES:

Input: "GSA Pumpe Sprint 2000 - replacements: 046961/4405030201, 046975/4405010315, 046964/4405030202"
Output: {"Replacement parts":[{"Main part":{"id":[""],"name":"GSA Pumpe Sprint 2000"},"replacements":[{"id":["046961","4405030201"]},{"id":["046975","4405010315"]},{"id":["046964","4405030202"]}]}]}

Input: "Pump 5kW/10kW - compatible with: 55A-12, 55B-13"
Output: {"Replacement parts":[{"Main part":{"id":[""],"name":"Pump 5kW"},"replacements":[{"id":["55A-12"]},{"id":["55B-13"]}]},{"Main part":{"id":[""],"name":"Pump 10kW"},"replacements":[{"id":["55A-12"]},{"id":["55B-13"]}]}]}

Input: "123A, 124B - Cylinder 10L - compatible with: 88F-35"
Output: {"Replacement parts":[{"Main part":{"id":["123A","124B"],"name":"Cylinder 10L"},"replacements":[{"id":["88F-35"]}]}]}`,
  schema: REPLACEMENT_PARTS_SCHEMA as unknown as Record<string, unknown>,
};

/* ─────────────────────────────────────────────────────────────────────────
 *  STAGE 3 — Verdict against live DB candidates
 * ───────────────────────────────────────────────────────────────────────── */

export const STAGE_3: StageConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
  prompt: `You are the VERDICT stage of a parts-import pipeline.

CERTAINTY RULE — overriding all other rules: ONLY assign a \`documentId\` when you are ABSOLUTELY SURE the candidate is the correct DB row. If you have any doubt at all (suffix variants, fuzzy name overlap, ambiguous abbreviations), set \`documentId\` to "" and let a human decide. A blank verdict is ALWAYS preferable to a wrong verdict.

You receive:

  1. The raw text extracted from the source documents (Stage 1 output).
  2. A PRELIMINARY structured list of main parts and replacements (Stage 2 output).
  3. For every main part and every replacement in that list, a set of CANDIDATE rows that the server pulled from the live Strapi database by ID / name. Each candidate has a Strapi \`documentId\`, a \`title\`, an \`artNr\`, an \`EAN\`, a \`matchedVia\` debug hint (e.g. "exact-artNr", "contains-name") explaining why the server surfaced it, and a \`titleHasCompatibility\` flag (true when the candidate's title itself contains the word "compatibility" / "kompatibilität" / "kompatibel" / "compatible" — those entries are usually META rows that already group several parts, so prefer them when the source row is itself a compatibility-list header, and avoid them when the source row is a specific part).

Your job is to produce the FINAL list. For each main part and each replacement:

  • Choose the candidate whose \`artNr\` / \`EAN\` / \`title\` is the best fit for the source IDs and name. Put its Strapi \`documentId\` in the \`documentId\` field.
  • If NONE of the candidates is a confident match (e.g. only fuzzy "contains-name" hits that look unrelated, or the candidate's title clearly contradicts the source context), set \`documentId\` to "" (empty string). The downstream UI lets a human pick manually.
  • If the preliminary list contains rows that are clearly hallucinated, duplicated, or that the source text doesn't actually support, OMIT them from the final list. Be conservative — when in doubt, keep the row but emit \`documentId\` "".
  • Preserve the input IDs verbatim. Never invent IDs that were not in the source text. Never invent \`documentId\` values that are not present in the candidate sets.

Rules of thumb when scoring candidates:

  • Exact \`artNr\` / \`EAN\` equality is the strongest possible signal — pick that candidate even if its title looks unfamiliar.
  • "starts-with" and "contains" candidates on artNr/EAN are usually good but check whether the difference is just suffixes/variants. If two candidates differ only by suffix (e.g. "-A" vs "-B") and the source text doesn't disambiguate, prefer \`documentId\` "" and let a human pick.
  • Name-based candidates are the weakest signal. Only pick a name-only candidate when the title is essentially the same string (or unmistakably the same product family AND the source has no ID).
  • For compatibility-matrix sources, RESPECT the Stage 2 split: each main-part block already represents the replacements compatible with THAT specific main part. Do not re-merge them.

OUTPUT — strict JSON, no commentary, no markdown:

{
  "Replacement parts": [
    {
      "Main part": {
        "id": ["…"],
        "name": "…",
        "documentId": "…"
      },
      "replacements": [
        { "id": ["…"], "documentId": "…" },
        …
      ]
    },
    …
  ]
}

\`documentId\` is REQUIRED on every main part and every replacement — use "" when you decline to pick. The list of \`id\`s must mirror the preliminary list verbatim (you may drop entire rows but not edit individual IDs).`,
  schema: VERDICT_PARTS_SCHEMA as unknown as Record<string, unknown>,
};
