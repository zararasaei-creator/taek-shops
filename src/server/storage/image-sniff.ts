/**
 * Byte-level image format detection (Phase 9).
 *
 * `contentType` on an upload request is a claim the browser makes — it is
 * never trusted for authorization or storage decisions. This module inspects
 * the actual bytes (magic numbers) and returns a format ONLY when they
 * genuinely match a supported raster image container. SVG (an XML/text
 * format, not a raster container, and a known XSS vector when served
 * inline) is explicitly never accepted here, regardless of what a request
 * claims — checked first, ahead of the raster signatures, as a deliberate
 * belt-and-braces reject rather than merely "not matched by anything else."
 *
 * Relative imports only — see `order-mailer.ts`'s module comment in
 * `src/server/notifications/` for why some modules in this codebase avoid
 * the `@/` alias (this one doesn't strictly need to, but stays consistent
 * with its sibling `object-storage.ts`/`s3-object-storage.ts`, which do).
 */

export type SniffedImageFormat = "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "image/gif";

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiEqual(bytes: Uint8Array, offset: number, text: string): boolean {
  return bytesEqual(
    bytes,
    offset,
    [...text].map((c) => c.charCodeAt(0)),
  );
}

/** Rejects SVG/XML/plain-text content, even if mislabeled as a raster type. */
function looksLikeSvgOrText(bytes: Uint8Array): boolean {
  // Skip a UTF-8 BOM and leading ASCII whitespace, then look for the
  // telltale start of an XML/SVG document within the first ~256 bytes.
  let start = 0;
  if (bytesEqual(bytes, 0, [0xef, 0xbb, 0xbf])) start = 3;
  const head = bytes.subarray(start, Math.min(bytes.length, start + 256));
  const text = Array.from(head)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0x09 || b === 0x0a || b === 0x0d ? " " : "\0"))
    .join("")
    .trimStart()
    .toLowerCase();
  return text.startsWith("<?xml") || text.startsWith("<svg") || text.startsWith("<!doctype svg");
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytesEqual(bytes, 0, [0xff, 0xd8, 0xff]);
}

function isPng(bytes: Uint8Array): boolean {
  return bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isGif(bytes: Uint8Array): boolean {
  return asciiEqual(bytes, 0, "GIF87a") || asciiEqual(bytes, 0, "GIF89a");
}

function isWebp(bytes: Uint8Array): boolean {
  return asciiEqual(bytes, 0, "RIFF") && asciiEqual(bytes, 8, "WEBP");
}

function isAvif(bytes: Uint8Array): boolean {
  if (!asciiEqual(bytes, 4, "ftyp")) return false;
  const brand = Array.from(bytes.subarray(8, 12))
    .map((b) => String.fromCharCode(b))
    .join("");
  return brand === "avif" || brand === "avis";
}

/**
 * Detect the actual image format from its bytes. Returns `null` for
 * anything that doesn't match a supported format exactly — including SVG,
 * any other XML/text content, a truncated/corrupt file, or an unsupported
 * format. The caller must treat `null` as "reject," never as "assume a
 * default."
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat | null {
  if (bytes.length < 12) return null;
  if (looksLikeSvgOrText(bytes)) return null;
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isGif(bytes)) return "image/gif";
  if (isWebp(bytes)) return "image/webp";
  if (isAvif(bytes)) return "image/avif";
  return null;
}
