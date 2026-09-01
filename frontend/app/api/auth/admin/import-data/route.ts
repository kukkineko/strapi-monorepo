import { type NextRequest, NextResponse } from "next/server";
import https from "node:https";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import {
  STAGE_1,
  STAGE_2,
  STAGE_3,
  type StageConfig,
  type ProviderName,
} from "@/app/lib/import-prompts";
import {
  gatherCandidates,
  type CandidateMatch,
} from "@/app/lib/strapi-search";
import {
  extractPdfText,
  hasUsefulText,
  isPdfFile,
} from "@/app/lib/pdf-extract";

/* Allow up to 5 minutes — a two-stage reasoning pipeline on a dense parts
 * list can take 30-90 seconds per stage. The default 10s serverless budget
 * is far too short. */
export const maxDuration = 300;

/* ── config ─────────────────────────────────────────────────────────────── */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

/* ── helpers shared between stages ──────────────────────────────────────── */

/** Stage 2 is configured with a strict JSON schema, but we still treat the
 *  output defensively: an upstream model swap or a temporary provider hiccup
 *  could deliver JSON wrapped in a code fence. Try plain JSON.parse first,
 *  then fall back to the first fenced ```json block. */
function safeParseJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** Build the user-turn text sent to Stage 3.
 *
 *  The model sees three things:
 *   1. The Stage 1 source text (so it can reason about the original page).
 *   2. The preliminary list (with IDs and names).
 *   3. The DB candidates the server pre-resolved for every ID/name.
 *
 *  The format is plain markdown — strict enough for the model to grep on,
 *  loose enough that adding a new candidate field later (e.g. desc) is a
 *  one-line change. We trim each candidate to the discriminating fields so
 *  the prompt budget stays bounded even on large lists. */
type EnrichedGroup = {
  mainPart: { id: string[]; name: string; candidates: CandidateMatch[] };
  replacements: Array<{ id: string[]; candidates: CandidateMatch[] }>;
};

function buildVerdictInput(
  stage1Text: string,
  enriched: EnrichedGroup[],
): string {
  const truncate = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n)}…` : s;

  const COMPAT_RE = /(compatibilit|kompatibilit|kompatibel|compatible)/i;
  const renderCandidate = (c: CandidateMatch) => {
    const title = truncate(c.title ?? "", 120);
    const compat = COMPAT_RE.test(title);
    return (
      `      - documentId="${c.documentId}" · title=${JSON.stringify(title)}` +
      ` · artNr=${JSON.stringify(c.artNr ?? "")}` +
      ` · EAN=${JSON.stringify(c.EAN ?? "")}` +
      ` · matchedVia=${c.matchedVia}` +
      ` · matchedOn=${JSON.stringify(c.sourceValue)}` +
      ` · titleHasCompatibility=${compat}`
    );
  };

  const renderCandidatesBlock = (cands: CandidateMatch[]) =>
    cands.length === 0
      ? "      (no candidates — DB has nothing matching)"
      : cands.map(renderCandidate).join("\n");

  const groupBlocks = enriched.map((g, gi) => {
    const repBlocks = g.replacements
      .map(
        (r, ri) =>
          `    Replacement #${ri + 1} · ids=${JSON.stringify(r.id)}\n` +
          `${renderCandidatesBlock(r.candidates)}`,
      )
      .join("\n");

    return (
      `## Group ${gi + 1}\n` +
      `  Main part · ids=${JSON.stringify(g.mainPart.id)} · name=${JSON.stringify(
        g.mainPart.name,
      )}\n` +
      `${renderCandidatesBlock(g.mainPart.candidates)}\n` +
      `\n  Replacements:\n${repBlocks || "    (none)"}`
    );
  });

  return (
    `# Source text (Stage 1 extraction, may include multiple files)\n\n` +
    `${truncate(stage1Text, 20000)}\n\n` +
    `# Preliminary list + DB candidates\n\n` +
    `${groupBlocks.join("\n\n")}\n\n` +
    `# Task\n\n` +
    `For every Main part and every Replacement above, pick the candidate ` +
    `whose documentId you are confident is the correct DB row, OR set ` +
    `documentId to "" if no candidate is a confident match. Drop entire ` +
    `rows that the source clearly does not support. Emit the final JSON ` +
    `in the schema you were given.`
  );
}

/* ── low-level HTTPS helper ─────────────────────────────────────────────── */
/* Direct node:https calls bypass Next.js's patched fetch + corporate TLS   */
/* proxy that has caused intermittent failures on this deployment.          */

function httpsJSON<T>(
  hostname: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;

    const req = https.request(
      {
        hostname,
        port: 443,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...headers,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `${hostname} ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 800)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`Non-JSON response: ${raw.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`HTTPS error: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Multipart upload — used for both OpenAI Files and Anthropic Files API. */
function multipartUpload(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  fileField: { name: string; filename: string; mime: string; data: Buffer },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const boundary = "----IMPORTBoundary" + Date.now().toString(36);
    const parts: Buffer[] = [];
    const str = (s: string) => Buffer.from(s, "utf-8");

    for (const [k, v] of Object.entries(fields)) {
      parts.push(
        str(
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        ),
      );
    }
    parts.push(
      str(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename.replace(/"/g, "_")}"\r\n` +
          `Content-Type: ${fileField.mime}\r\n\r\n`,
      ),
    );
    parts.push(fileField.data);
    parts.push(str(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = https.request(
      {
        hostname,
        port: 443,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          ...headers,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `Upload to ${hostname}${path} failed (${res.statusCode}): ${raw.slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Non-JSON upload response: ${raw.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`Upload HTTPS error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

/* ── OpenAI Responses API ───────────────────────────────────────────────── */

type OpenAIResponseObj = {
  id: string;
  status: string;
  output_text?: string;
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  error?: { message: string };
};

function extractOpenAIText(response: OpenAIResponseObj): string {
  if (response.output_text && response.output_text.trim()) {
    return response.output_text;
  }
  const message = response.output?.find(
    (o) => o.type === "message" && o.role === "assistant",
  );
  if (!message?.content) return "";
  const block = message.content.find(
    (c) => c.type === "output_text" || c.type === "text",
  );
  return block?.text ?? "";
}

/** True for any MIME type that OpenAI's Responses API expects via the
 *  `input_image` content block rather than `input_file`. OpenAI's
 *  `/v1/files` endpoint with `purpose: "user_data"` REJECTS images
 *  (returns "Expected context stuffing file type to be a supported
 *  format … but got .png"). The reliable cross-account way to attach an
 *  image is to inline it as a base64 data URL on an `input_image` block —
 *  no upload needed. */
function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Upload a single file to OpenAI's Files API. Images are NOT supported by
 *  this endpoint with `purpose: "user_data"`, so we return an empty string
 *  for them and the caller sends them inline via `input_image` instead. */
async function uploadFileToOpenAI(file: UploadedFile): Promise<string> {
  if (isImageMime(file.mime)) return "";
  const result = (await multipartUpload(
    "api.openai.com",
    "/v1/files",
    { Authorization: `Bearer ${OPENAI_API_KEY}` },
    { purpose: "user_data" },
    { name: "file", filename: file.name, mime: file.mime, data: file.buf },
  )) as { id: string };
  return result.id;
}

/**
 * Run a single stage against OpenAI's Responses API.
 *  - `files` are the raw uploaded files (used so images can be inlined as
 *    base64 `input_image` blocks rather than going through `/v1/files`).
 *  - `fileIds` are OpenAI file IDs aligned 1:1 with `files`. Empty string
 *    at index i means "file i is an image; send inline".
 *  - `userText` is the user-turn text content (e.g. the previous stage's
 *    output for Stage 2; a short instruction for Stage 1).
 */
async function runOpenAIStage(
  stage: StageConfig,
  files: UploadedFile[],
  fileIds: string[],
  userText: string,
): Promise<string> {
  type UserPart =
    | { type: "input_file"; file_id: string }
    | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
    | { type: "input_text"; text: string };

  const content: UserPart[] = [];
  let inlineImages = 0;
  let uploadedFiles = 0;
  let extractedDocs = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (f.extractedText) {
      /* Server-extracted PDF text. Send inline as a text block — no upload
         needed and the model sees exact character data (cheaper and more
         accurate than vision-encoded PDF pages). */
      content.push({
        type: "input_text",
        text:
          `=== File ${i + 1}: ${f.name} (server-extracted text` +
          (f.extractedPageCount
            ? `, ${f.extractedPageCount} page${f.extractedPageCount === 1 ? "" : "s"}`
            : "") +
          ") ===\n" +
          f.extractedText,
      });
      extractedDocs++;
    } else if (isImageMime(f.mime)) {
      /* Inline as data URL. OpenAI's Responses API accepts data URLs in
         `image_url` directly — no separate upload step needed. */
      const dataUrl = `data:${f.mime};base64,${f.buf.toString("base64")}`;
      content.push({ type: "input_image", image_url: dataUrl, detail: "high" });
      inlineImages++;
    } else {
      const fid = fileIds[i];
      if (!fid) {
        throw new Error(
          `OpenAI stage: non-image file ${f.name} has no file_id (upload likely failed).`,
        );
      }
      content.push({ type: "input_file", file_id: fid });
      uploadedFiles++;
    }
  }
  if (userText) content.push({ type: "input_text", text: userText });

  const body: Record<string, unknown> = {
    model: stage.model,
    instructions: stage.prompt,
    input: [{ role: "user", content }],
  };
  if (stage.schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "stage_output",
        strict: true,
        schema: stage.schema,
      },
    };
  }
  if (stage.reasoningEffort) {
    body.reasoning = { effort: stage.reasoningEffort };
  }

  console.log(
    "[import-data] OpenAI stage · model:",
    stage.model,
    "· inline images:",
    inlineImages,
    "· uploaded files:",
    uploadedFiles,
    "· extracted docs:",
    extractedDocs,
    "· schema:",
    stage.schema ? "strict" : "none",
  );

  const response = await httpsJSON<OpenAIResponseObj>(
    "api.openai.com",
    "POST",
    "/v1/responses",
    { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body,
  );

  if (response.status === "failed") {
    throw new Error(
      `OpenAI stage failed: ${response.error?.message ?? "Unknown error"}`,
    );
  }
  if (response.status && response.status !== "completed") {
    throw new Error(
      `OpenAI stage did not complete (status: ${response.status}).`,
    );
  }

  const text = extractOpenAIText(response);
  if (!text) throw new Error("OpenAI returned an empty response.");
  return text;
}

/* ── Anthropic Messages API ─────────────────────────────────────────────── */

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown };

type AnthropicResponseObj = {
  id: string;
  stop_reason: string;
  content: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** Tokens written to the cache this request (~1.25× cost). */
    cache_creation_input_tokens?: number;
    /** Tokens served from the cache this request (~0.1× cost). */
    cache_read_input_tokens?: number;
  };
  error?: { message?: string };
};

const ANTHROPIC_HEADERS: Record<string, string> = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "files-api-2025-04-14",
};

async function uploadFileToAnthropic(file: UploadedFile): Promise<string> {
  const result = (await multipartUpload(
    "api.anthropic.com",
    "/v1/files",
    ANTHROPIC_HEADERS,
    {},
    { name: "file", filename: file.name, mime: file.mime, data: file.buf },
  )) as { id: string };
  return result.id;
}

/**
 * Run a single stage against Anthropic's Messages API.
 *
 * Structured output is achieved via a single forced tool call whose
 * `input_schema` matches `stage.schema`. The tool input is the final JSON.
 */
async function runAnthropicStage(
  stage: StageConfig,
  files: UploadedFile[],
  fileIds: string[],
  userText: string,
): Promise<string> {
  type Block =
    | { type: "text"; text: string }
    | {
        type: "document";
        source: { type: "file"; file_id: string };
      }
    | {
        type: "image";
        source: { type: "file"; file_id: string };
      };

  const content: Block[] = [];
  let extractedDocs = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (f.extractedText) {
      /* Server-extracted PDF text — skip the Files API upload entirely
         and send the contents as a plain text block. Saves tokens and
         dodges any document-handling quirks on the provider side. */
      content.push({
        type: "text",
        text:
          `=== File ${i + 1}: ${f.name} (server-extracted text` +
          (f.extractedPageCount
            ? `, ${f.extractedPageCount} page${f.extractedPageCount === 1 ? "" : "s"}`
            : "") +
          ") ===\n" +
          f.extractedText,
      });
      extractedDocs++;
      continue;
    }
    const fid = fileIds[i];
    if (!fid) {
      throw new Error(
        `Anthropic stage: file ${f.name} has no file_id (upload likely failed).`,
      );
    }
    if (f.mime.startsWith("image/")) {
      content.push({ type: "image", source: { type: "file", file_id: fid } });
    } else {
      content.push({ type: "document", source: { type: "file", file_id: fid } });
    }
  }
  if (userText) content.push({ type: "text", text: userText });

  const body: Record<string, unknown> = {
    model: stage.model,
    max_tokens: 16000,
    /* Claude Opus 5 turns thinking ON by default, and max_tokens caps thinking
     * + output together. This pipeline wants deterministic extraction /
     * structured output, not visible reasoning — and adaptive thinking is
     * incompatible with the forced tool_choice used by the schema stages. Turn
     * it off explicitly (accepted at the default "high" effort on Opus 5). */
    thinking: { type: "disabled" },
    /* Prompt caching: the per-stage system prompt is large and byte-identical
     * on every request, so mark it as a cache breakpoint. Render order is
     * tools → system → messages, so a breakpoint on the (single) system block
     * caches the tool schema AND the system prompt together as one prefix; the
     * per-request user content (documents / prior-stage text) stays uncached
     * after it. The default 5-minute TTL comfortably covers the per-file
     * Stage 1 fallback loop and back-to-back import runs. No beta header
     * needed — prompt caching is GA. */
    system: [
      {
        type: "text",
        text: stage.prompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content }],
  };

  if (stage.schema) {
    body.tools = [
      {
        name: "emit_result",
        description: "Emit the structured result.",
        input_schema: stage.schema,
      },
    ];
    body.tool_choice = { type: "tool", name: "emit_result" };
  }

  console.log(
    "[import-data] Anthropic stage · model:",
    stage.model,
    "· files:",
    fileIds.length,
    "· extracted docs:",
    extractedDocs,
    "· schema:",
    stage.schema ? "tool-forced" : "none",
  );

  const response = await httpsJSON<AnthropicResponseObj>(
    "api.anthropic.com",
    "POST",
    "/v1/messages",
    ANTHROPIC_HEADERS,
    body,
  );

  /* Cache observability: cache_read > 0 means the system+tools prefix was
     served from cache; cache_creation > 0 means this request wrote it. If both
     stay 0 across repeated runs, a silent invalidator changed the prefix. */
  const u = response.usage;
  if (u) {
    console.log(
      "[import-data] Anthropic usage · input:",
      u.input_tokens ?? 0,
      "· output:",
      u.output_tokens ?? 0,
      "· cache write:",
      u.cache_creation_input_tokens ?? 0,
      "· cache read:",
      u.cache_read_input_tokens ?? 0,
    );
  }

  if (stage.schema) {
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("Anthropic did not return the expected tool_use block.");
    }
    return JSON.stringify(toolBlock.input);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
    throw new Error("Anthropic returned an empty response.");
  }
  return textBlock.text;
}

/* ── Stage dispatch ─────────────────────────────────────────────────────── */

interface UploadedFile {
  name: string;
  mime: string;
  buf: Buffer;
  /**
   * Server-side extracted text. When set, the file is NOT uploaded to the
   * AI provider — the text is sent as a plain `input_text` block instead.
   * Currently populated only for PDFs whose embedded text passed the
   * `hasUsefulText` threshold (see `app/lib/pdf-extract.ts`). Image-only
   * "scanned" PDFs leave this undefined and follow the normal upload path
   * so the vision model can OCR them.
   */
  extractedText?: string;
  /** Page count, recorded for logging when extractedText is set. */
  extractedPageCount?: number;
}

/** Cache of (provider → file index → provider file ID) so Stage 1 only uploads
 *  each file once per provider. */
type FileIdCache = Partial<Record<ProviderName, string[]>>;

async function ensureUploadedTo(
  provider: ProviderName,
  files: UploadedFile[],
  cache: FileIdCache,
): Promise<string[]> {
  const cached = cache[provider];
  if (cached) return cached;

  const ids: string[] = [];
  for (const f of files) {
    /* PDFs whose text we extracted server-side never get uploaded — the
       text is sent inline as a text block by run*Stage. Push a placeholder
       so the index alignment with `files[]` stays intact. */
    if (f.extractedText) {
      console.log(
        `[import-data] Skipping upload to ${provider} (text already extracted):`,
        f.name,
        `(${f.extractedText.length} chars,`,
        `${f.extractedPageCount ?? "?"} pages)`,
      );
      ids.push("");
      continue;
    }
    /* For OpenAI, images bypass /v1/files entirely (the endpoint rejects
       PNG/JPEG with purpose=user_data). They are inlined as base64 data
       URLs by runOpenAIStage. We still emit a placeholder "" so the index
       alignment with `files[]` is preserved. */
    if (provider === "openai" && isImageMime(f.mime)) {
      console.log(
        `[import-data] Inlining image for openai:`,
        f.name,
        `(${f.buf.length} bytes, ${f.mime})`,
      );
      ids.push("");
      continue;
    }
    console.log(
      `[import-data] Uploading to ${provider}:`,
      f.name,
      `(${f.buf.length} bytes, ${f.mime})`,
    );
    const id =
      provider === "openai"
        ? await uploadFileToOpenAI(f)
        : await uploadFileToAnthropic(f);
    ids.push(id);
  }
  cache[provider] = ids;
  return ids;
}

async function runStage(
  stage: StageConfig,
  files: UploadedFile[],
  fileIds: string[],
  userText: string,
): Promise<string> {
  if (stage.provider === "openai") {
    if (!OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not configured but a stage requires the OpenAI provider.",
      );
    }
    return runOpenAIStage(stage, files, fileIds, userText);
  }
  if (stage.provider === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not configured but a stage requires the Anthropic provider.",
      );
    }
    return runAnthropicStage(stage, files, fileIds, userText);
  }
  throw new Error(`Unsupported provider: ${stage.provider as string}`);
}

/* ── POST handler ───────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  /* Auth guard */
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    console.log("[import-data] Parsing form data…");
    const formData = await req.formData();

    /* Collect files into memory (we may need to upload them to multiple
       providers if Stage 1 and Stage 2 use different APIs). */
    const files: UploadedFile[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === "files" && value instanceof File) {
        const buf = Buffer.from(await value.arrayBuffer());
        files.push({
          name: value.name,
          mime: value.type || "application/octet-stream",
          buf,
        });
      }
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: "At least one file is required." },
        { status: 400 },
      );
    }

    /* ── PDF text pre-extraction ────────────────────────────────────────
       For any PDF in the batch, try to pull its embedded text out
       server-side with pdf.js. If we get a non-trivial amount of text
       back, that text is sent to Stage 1 inline (cheaper, more accurate,
       and dodges any provider/model PDF-handling quirks). If the PDF is
       a scan / image-only file the extractor returns empty and we keep
       the original upload path so the vision model can OCR it. */
    let pdfExtractAttempts = 0;
    let pdfExtractSuccesses = 0;
    for (const f of files) {
      if (!isPdfFile(f.mime, f.name)) continue;
      pdfExtractAttempts++;
      const result = await extractPdfText(f.buf);
      if (!result.ok) {
        console.warn(
          `[import-data] PDF parse failed for ${f.name} — will upload as file ·`,
          result.error,
        );
        continue;
      }
      if (!hasUsefulText(result.text, result.pageCount)) {
        console.log(
          `[import-data] PDF has no usable embedded text (${result.pageCount} pages, ${result.text.length} chars) · ${f.name} — falling back to upload for OCR`,
        );
        continue;
      }
      f.extractedText = result.text;
      f.extractedPageCount = result.pageCount;
      pdfExtractSuccesses++;
      console.log(
        `[import-data] PDF text extracted · ${f.name} ·`,
        `${result.pageCount} pages · ${result.text.length} chars`,
      );
    }
    if (pdfExtractAttempts > 0) {
      console.log(
        "[import-data] PDF extraction summary ·",
        `${pdfExtractSuccesses}/${pdfExtractAttempts}`,
        "PDFs handled inline (rest fall back to upload)",
      );
    }

    console.log(
      "[import-data] Stage 1:",
      STAGE_1.provider,
      STAGE_1.model,
      "→ Stage 2:",
      STAGE_2.provider,
      STAGE_2.model,
      "→ Stage 3:",
      STAGE_3.provider,
      STAGE_3.model,
      `· ${files.length} file(s)`,
    );

    /* Upload files to whichever provider Stage 1 uses. Stage 2 receives
       Stage 1's text output and never needs file access. */
    const fileIdCache: FileIdCache = {};
    const stage1FileIds = await ensureUploadedTo(
      STAGE_1.provider,
      files,
      fileIdCache,
    );

    /* ─── Stage 1: documents → text ──────────────────────────────────────
       BATCHED: all files go in a single request so the system prompt is
       sent only ONCE instead of once-per-file. The model is instructed
       (see import-prompts.ts) to emit "=== FILE n ===" headers between
       each attachment's blocks so Stage 2 can tell them apart.
       Falls back to per-file processing if the batched call fails (e.g.
       provider context-window error on huge uploads). */
    const perFileOutputs: Array<{
      name: string;
      ok: boolean;
      text: string;
      error?: string;
    }> = [];
    let stage1Output = "";

    const fileList = files
      .map((f, i) => {
        const kind = f.extractedText
          ? "server-extracted text"
          : isImageMime(f.mime)
            ? "image"
            : `binary (${f.mime})`;
        return `${i + 1}. ${f.name} — ${kind}`;
      })
      .join("\n");
    const batchedUserText =
      `Process ${files.length} attached document(s) in a single pass ` +
      `according to your instructions.\n\nAttached files (in order):\n${fileList}\n\n` +
      `Note: items marked "server-extracted text" arrive as plain text blocks ` +
      `(the server already pulled their embedded text from the PDF) rather than ` +
      `as visual file attachments. Treat them exactly the same as if you had ` +
      `read the original document yourself.\n\n` +
      `Emit one "=== FILE <n> ===" header followed by that file's main_part ` +
      `blocks, in the same order as the attachment list. Apply the certainty ` +
      `rule strictly — omit anything you are not 100% sure of.`;

    try {
      const text = await runStage(
        STAGE_1,
        files,
        stage1FileIds,
        batchedUserText,
      );
      stage1Output = text;
      /* Record one fake "ok" entry per input file so downstream debug UI
         (which iterates perFileOutputs) still has something to show. */
      for (const f of files) {
        perFileOutputs.push({ name: f.name, ok: true, text: "" });
      }
      console.log(
        "[import-data] Stage 1 (batched) complete ·",
        files.length,
        "files · combined length:",
        text.length,
      );
    } catch (batchErr) {
      const message =
        batchErr instanceof Error ? batchErr.message : String(batchErr);
      console.warn(
        "[import-data] Stage 1 BATCHED failed, falling back to per-file ·",
        message,
      );

      /* Per-file fallback. Files run sequentially (providers serialise
         heavy vision requests on the account anyway). */
      perFileOutputs.length = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const fileId = stage1FileIds[i]!;
        const sourceKind = file.extractedText
          ? "server-extracted PDF text (inline below)"
          : "attached document";
        try {
          const text = await runStage(
            STAGE_1,
            [file],
            [fileId],
            `Process the ${sourceKind} according to your instructions. Source filename: ${file.name}`,
          );
          perFileOutputs.push({ name: file.name, ok: true, text });
          console.log(
            "[import-data] Stage 1 (fallback) ·",
            file.name,
            "→",
            text.length,
            "chars",
          );
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          perFileOutputs.push({
            name: file.name,
            ok: false,
            text: "",
            error: m,
          });
          console.warn(
            "[import-data] Stage 1 FAILED ·",
            file.name,
            "·",
            m,
          );
        }
      }

      const successful = perFileOutputs.filter((p) => p.ok && p.text);
      if (successful.length === 0) {
        const errs = perFileOutputs
          .map((p) => `${p.name}: ${p.error ?? "empty output"}`)
          .join(" | ");
        throw new Error(
          `Stage 1 produced no usable output (batched + fallback). ` +
            `Batched error: ${message}. Per-file errors: ${errs}`,
        );
      }

      stage1Output = successful
        .map((p) => `=== FILE: ${p.name} ===\n${p.text}`)
        .join("\n\n");
      console.log(
        "[import-data] Stage 1 (fallback) complete ·",
        successful.length,
        "of",
        files.length,
        "files · combined length:",
        stage1Output.length,
      );
    }

    /* ─── Stage 2: text → preliminary structured JSON ───────────────────── */
    const stage2Output = await runStage(STAGE_2, files, [], stage1Output);
    console.log("[import-data] Stage 2 complete · length:", stage2Output.length);

    /* Parse Stage 2 so we can pre-resolve DB candidates for Stage 3. */
    type PrelimGroup = {
      "Main part": { id: string[]; name: string };
      replacements: Array<{ id: string[] }>;
    };
    type PrelimDoc = { "Replacement parts"?: PrelimGroup[] };

    const stage2Parsed = safeParseJson<PrelimDoc>(stage2Output);
    const prelimGroups = stage2Parsed?.["Replacement parts"] ?? [];

    /* ─── DB pre-resolution: gather candidates for each ID / name ───────── */
    /* Main parts get name fallback; replacements never do (their IDs are
       the only signal worth trusting at this point — see match/route.ts). */
    const enriched: EnrichedGroup[] = [];
    for (const g of prelimGroups) {
      const mainCands = await gatherCandidates(
        g["Main part"].id ?? [],
        g["Main part"].name ?? null,
        true,
      );
      const reps: EnrichedGroup["replacements"] = [];
      for (const r of g.replacements ?? []) {
        const cands = await gatherCandidates(r.id ?? [], null, false);
        reps.push({ id: r.id ?? [], candidates: cands });
      }
      enriched.push({
        mainPart: {
          id: g["Main part"].id ?? [],
          name: g["Main part"].name ?? "",
          candidates: mainCands,
        },
        replacements: reps,
      });
    }
    const candidateCount = enriched.reduce(
      (n, g) =>
        n +
        g.mainPart.candidates.length +
        g.replacements.reduce((m, r) => m + r.candidates.length, 0),
      0,
    );
    console.log(
      "[import-data] DB candidates gathered ·",
      enriched.length,
      "groups ·",
      candidateCount,
      "total candidates",
    );

    /* ─── Stage 3: verdict against live DB candidates ───────────────────── */
    /* Skip Stage 3 entirely when Stage 2 produced nothing parseable — there
       is nothing to adjudicate. Return the Stage 2 raw text so the UI can
       still surface what the AI saw. */
    let finalOutput = stage2Output;
    let stage3Output: string | null = null;
    if (enriched.length > 0) {
      const verdictInput = buildVerdictInput(stage1Output, enriched);
      stage3Output = await runStage(STAGE_3, files, [], verdictInput);
      console.log(
        "[import-data] Stage 3 complete · length:",
        stage3Output.length,
      );
      finalOutput = stage3Output;
    } else {
      console.warn(
        "[import-data] Stage 3 skipped · Stage 2 produced no parseable groups",
      );
    }

    return NextResponse.json({
      ok: true,
      response: finalOutput,
      stage1: stage1Output,
      stage1PerFile: perFileOutputs,
      stage2: stage2Output,
      stage3: stage3Output,
      candidates: enriched,
      model:
        `${STAGE_1.provider}:${STAGE_1.model} → ` +
        `${STAGE_2.provider}:${STAGE_2.model} → ` +
        `${STAGE_3.provider}:${STAGE_3.model}`,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Import processing failed.";
    console.error("[import-data] ERROR:", message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
