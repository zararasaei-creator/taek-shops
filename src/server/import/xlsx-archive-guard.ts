import JSZip from "jszip";

import { ImportFileError } from "@/server/import/errors";

/**
 * Bounded ZIP-archive processing for `.xlsx` uploads, run BEFORE `exceljs`
 * ever loads the workbook.
 *
 * `.xlsx` is a ZIP archive. The existing `IMPORT_MAX_FILE_SIZE_BYTES`
 * check only bounds the *compressed* upload — it does not bound how much
 * memory/CPU decompressing that archive can consume. A deliberately
 * crafted archive can be a few kilobytes on disk and expand to gigabytes
 * once inflated (a "zip bomb"); checking the uploaded byte count alone
 * does not protect against this.
 *
 * **This module enforces limits WHILE decompressing, not from ZIP
 * metadata and not after fully materializing an entry.** `JSZip.loadAsync`
 * itself only parses the archive's directory structure — it does not
 * eagerly inflate every entry — so calling it is cheap. The actual
 * decompression happens here, streamed one chunk at a time via
 * `entry.nodeStream()` (a real, pausable Node.js `Readable` backed by
 * `jszip`'s own inflate worker — pausing/destroying it genuinely halts
 * further inflate work, confirmed by reading `jszip`'s own
 * `NodejsStreamOutputAdapter` source, not assumed). The running
 * decompressed-byte count for the current entry, and for the archive as a
 * whole, is checked on every chunk; the stream is destroyed and the
 * promise rejects the instant either limit is exceeded — never after
 * reading further, and never only by trusting the ZIP central directory's
 * (attacker-controlled) declared `uncompressedSize` field.
 *
 * **The exact limits, chosen generously above anything this importer's
 * own row/column caps (`IMPORT_MAX_ROW_COUNT`, `MAX_IMPORT_COLUMNS` in
 * `xlsx-parser.ts`) could legitimately produce, while remaining far below
 * where a real zip bomb operates (ratios of 1,000x–1,000,000x+ are typical
 * for a deliberately crafted bomb; these limits catch that long before a
 * legitimate spreadsheet would ever approach them):**
 * - `MAX_ARCHIVE_ENTRIES` = 100 — a real `.xlsx` workbook typically has on
 *   the order of 10–30 parts (worksheets, styles, shared strings, theme,
 *   docProps, rels, content-types); checked from ZIP directory metadata
 *   alone (cheap, and entry *count* — unlike entry *size* — isn't
 *   something decompression can lie about).
 * - `MAX_ENTRY_DECOMPRESSED_BYTES` = 50 MB — generous for a single part's
 *   XML even at this importer's maximum row/column caps.
 * - `MAX_TOTAL_DECOMPRESSED_BYTES` = 100 MB — generous for a whole
 *   workbook under those same caps.
 *
 * **Documented limitation**: this bounds decompression *memory and
 * per-entry/total byte volume*, not raw CPU time for a pathological
 * compression structure (e.g. many small entries each near the per-entry
 * limit, or deeply nested compression) — `MAX_ARCHIVE_ENTRIES` is the
 * primary mitigation for the former, and the existing
 * `IMPORT_MAX_FILE_SIZE_BYTES` upload-size cap bounds how much compressed
 * input can even reach this code. A dedicated wall-clock timeout for this
 * specific step was not added this pass.
 */

const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ENTRY_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TOTAL_DECOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB

function streamEntryBounded(
  entry: JSZip.JSZipObject,
  entryName: string,
  totalSoFar: { bytes: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let entryBytes = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer");

    const fail = (error: ImportFileError) => {
      if (settled) return;
      settled = true;
      // `.pause()` (not `.destroy()`, which the public `NodeJS.ReadableStream`
      // type jszip declares doesn't expose) genuinely halts further inflate
      // work — confirmed via jszip's own `NodejsStreamOutputAdapter`: pausing
      // stops `_read` from calling `.resume()` on the underlying worker,
      // which is what actually drives decompression forward.
      stream.pause();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    stream.on("data", (chunk: Buffer) => {
      entryBytes += chunk.length;
      totalSoFar.bytes += chunk.length;
      if (entryBytes > MAX_ENTRY_DECOMPRESSED_BYTES) {
        fail(
          new ImportFileError(
            "archive_entry_too_large",
            `The file's "${entryName}" archive entry decompresses to more than the ` +
              `${MAX_ENTRY_DECOMPRESSED_BYTES.toLocaleString()} byte limit.`,
          ),
        );
        return;
      }
      if (totalSoFar.bytes > MAX_TOTAL_DECOMPRESSED_BYTES) {
        fail(
          new ImportFileError(
            "archive_too_large",
            `The file decompresses to more than the ` +
              `${MAX_TOTAL_DECOMPRESSED_BYTES.toLocaleString()} byte limit.`,
          ),
        );
      }
    });
    stream.on("end", succeed);
    stream.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(new ImportFileError("unparseable", `The file could not be parsed as XLSX: ${error.message}`));
    });
  });
}

/**
 * Validate that an `.xlsx` archive's entry count and decompressed size
 * (per-entry and total) stay within bounds. Throws `ImportFileError`
 * (never a raw exception) on any violation, including a malformed/
 * unparseable archive. Resolves with nothing — callers proceed to the real
 * parse (`exceljs`) only after this succeeds.
 */
export async function assertBoundedXlsxArchive(bytes: Uint8Array): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new ImportFileError(
      "unparseable",
      `The file could not be parsed as XLSX: ${(error as Error).message}`,
    );
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new ImportFileError(
      "too_many_archive_entries",
      `The file contains ${entries.length} archive entries; the limit is ${MAX_ARCHIVE_ENTRIES}.`,
    );
  }

  // Checked sequentially, not in parallel, so the running total across the
  // whole archive is accurate at every point a limit could be exceeded.
  const totalSoFar = { bytes: 0 };
  for (const entry of entries) {
    await streamEntryBounded(entry, entry.name, totalSoFar);
  }
}
