/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Server-side PDF text extraction
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Used by the data-import pipeline (`/api/auth/admin/import-data`) to pull
 * embedded text out of PDFs BEFORE they hit the AI provider. This solves
 * two problems at once:
 *
 *   1. PDF acceptance — some provider/model combinations choke on the
 *      Files-API document path (rejection at upload time, silent empty
 *      output, or "unsupported file" errors). Extracting locally and
 *      sending plain text bypasses that entirely.
 *
 *   2. Token spend — vision-encoded PDF pages cost roughly 1k-3k input
 *      tokens per page on most providers. The same page as embedded text
 *      is usually 100-500 tokens. For a 20-page catalogue that is a
 *      10-60× saving, and the model gets exact character data instead of
 *      OCR-ish guesses.
 *
 * Scanned / image-only PDFs have no embedded text — `extractPdfText` will
 * report `ok: true` with an empty/very short string, and `hasUsefulText`
 * returns false. The caller should fall back to uploading the original
 * PDF so the vision model can OCR it.
 *
 * pdfjs-dist (Mozilla PDF.js) is pure JS, has no native deps, and works
 * in the Node runtime that Next.js uses for route handlers. We import it
 * dynamically so the (~1 MB) module is only loaded on the first import
 * request — keeps cold start fast.
 */

export interface PdfExtractResult {
  /** Extracted text, page-tagged (`--- Page N ---`). Empty string on failure. */
  text: string;
  /** Page count if the PDF parsed, otherwise 0. */
  pageCount: number;
  /** True when pdf.js successfully opened and walked the document. The
   *  result may still be empty text on image-only PDFs — check
   *  `hasUsefulText` before deciding to skip the upload path. */
  ok: boolean;
  /** Error message when `ok` is false. Always undefined when ok is true. */
  error?: string;
}

/* ── Minimal structural types for the bits of pdf.js we touch ──────────── */
/* We don't pull in pdfjs-dist's full type surface (it drags DOM types via
   /types/src/pdf.d.ts that don't apply to the Node runtime). Declaring
   only the calls we make keeps the typechecker happy without that mess. */

interface PdfJsTextItem {
  str: string;
  hasEOL?: boolean;
  /** `transform` is a 6-element affine matrix; index 5 is the Y position. */
  transform?: number[];
}

interface PdfJsPage {
  getTextContent: () => Promise<{ items: PdfJsTextItem[] }>;
  cleanup: () => void;
}

interface PdfJsDocument {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfJsPage>;
  destroy: () => Promise<void>;
}

interface PdfJsModule {
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<PdfJsDocument>;
  };
}

/**
 * Extract embedded text from a PDF buffer.
 *
 *  - Workers are disabled (`useWorkerFetch: false`, no `workerSrc`). pdf.js
 *    runs in "fake worker" mode on the main thread, which is fine for
 *    text-only extraction and saves us from shipping the worker bundle
 *    through Next.js's bundler.
 *  - `isEvalSupported: false` disables `eval()` paths inside pdf.js — not
 *    strictly required in Node but good hygiene.
 *  - `disableFontFace: true` + `useSystemFonts: false` keep the extractor
 *    completely offline; font metrics are irrelevant when we only want
 *    `.str` from each text item.
 *  - `verbosity: 0` silences pdf.js's internal console warnings (e.g.
 *    "Warning: TT: undefined function: 32"), which are noisy and benign.
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<PdfExtractResult> {
  let pdf: PdfJsDocument | null = null;
  try {
    /* Dynamic ESM import — pdfjs-dist v5 is ESM-only and ~1 MB; loading
       it eagerly would slow cold-start for routes that never touch a PDF. */
    const pdfjs = (await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    )) as unknown as PdfJsModule;

    /* pdf.js takes ownership of the underlying buffer and may detach it.
       Copy into a fresh Uint8Array so we don't poison the caller's
       Buffer (which is also fed to the file-upload fallback path). */
    const u8 = new Uint8Array(buffer);

    const loadingTask = pdfjs.getDocument({
      data: u8,
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });

    pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    const pageTexts: string[] = [];

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      /* Group text items by approximate Y position so we keep line breaks.
         pdf.js returns items left-to-right top-to-bottom but with no
         explicit line markers — items on the same line share Y. */
      const lines: string[] = [];
      let lineBuf = "";
      let lastY: number | null = null;
      for (const item of content.items) {
        const y = item.transform?.[5] ?? null;
        const newLine =
          item.hasEOL === true ||
          (lastY !== null && y !== null && Math.abs(y - lastY) > 1);
        if (newLine && lineBuf) {
          lines.push(lineBuf.trimEnd());
          lineBuf = "";
        }
        if (
          lineBuf &&
          !lineBuf.endsWith(" ") &&
          item.str &&
          !item.str.startsWith(" ")
        ) {
          lineBuf += " ";
        }
        lineBuf += item.str;
        lastY = y;
      }
      if (lineBuf.trim()) lines.push(lineBuf.trimEnd());

      pageTexts.push(
        lines.length > 0
          ? `--- Page ${pageNum} ---\n${lines.join("\n")}`
          : `--- Page ${pageNum} ---\n(no embedded text)`,
      );

      page.cleanup();
    }

    const text = pageTexts.join("\n\n");
    return { text, pageCount, ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { text: "", pageCount: 0, ok: false, error };
  } finally {
    if (pdf) {
      try {
        await pdf.destroy();
      } catch {
        /* destroy() is best-effort cleanup; ignore secondary failures. */
      }
    }
  }
}

/**
 * Heuristic: was enough text extracted to justify sending it as text
 * instead of falling back to the vision/document upload path?
 *
 * Scanned PDFs (image-only) typically yield 0-20 characters total — just
 * metadata strings pdf.js scrapes from font dictionaries. Native-text
 * PDFs yield hundreds to thousands of characters per page.
 *
 * Threshold: at least 50 chars overall AND at least 30 chars per page on
 * average. The per-page check is what catches the common "20-page scan
 * with a single text-watermark page" case.
 *
 * The character count strips page markers and whitespace so a 100-page
 * scan with "--- Page N ---" headers doesn't pass on padding alone.
 */
export function hasUsefulText(text: string, pageCount: number): boolean {
  if (pageCount === 0) return false;
  const cleaned = text
    .replace(/--- Page \d+ ---/g, "")
    .replace(/\(no embedded text\)/g, "")
    .replace(/\s+/g, "");
  return cleaned.length >= Math.max(50, pageCount * 30);
}

/**
 * MIME / filename test for "is this thing a PDF?". The frontend may send
 * a PDF with MIME `application/octet-stream` (older browsers, some
 * upload widgets), so we also sniff the extension.
 */
export function isPdfFile(mime: string, filename: string): boolean {
  if (mime === "application/pdf") return true;
  if (mime === "application/x-pdf") return true;
  return filename.toLowerCase().endsWith(".pdf");
}
