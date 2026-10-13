import sharp from "sharp";

/**
 * Real image decoding (Phase 9 hardening) — genuinely decodes the bytes via
 * libvips (through `sharp`), not just magic-number sniffing
 * (`image-sniff.ts`). Catches two things byte-sniffing cannot:
 *
 * 1. A file whose header matches a real format's magic bytes but whose body
 *    is truncated/corrupt — `sniffImageFormat` would accept it; a decoder
 *    throws.
 * 2. A "decompression bomb" — a tiny file that decodes to an enormous
 *    pixel grid, a known DoS vector for anything that later processes the
 *    image (this app never resizes/re-encodes server-side today, but
 *    admin UI thumbnails and any future processing should never receive
 *    something a decoder wasn't bounded against).
 *
 * Both checks run in sequence in `image-service.ts`: `sniffImageFormat`
 * first (cheap, format-specific), then this (authoritative, catches what
 * sniffing structurally cannot).
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Either side, in pixels. Generous for real product photography. */
export const MAX_IMAGE_DIMENSION_PX = 8_000;
/** Total pixel count — the actual decompression-bomb guard (a thin 8000x8000 image is still 64MP). */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Decode the image for real and return its dimensions, or `null` if the
 * bytes don't actually decode as a valid image, or decode to dimensions
 * outside the configured bounds. Never throws — every failure mode
 * (corrupt data, an unsupported/inconsistent format, a pixel count over
 * the limit) is a `null` return, for the caller to treat uniformly as
 * "reject."
 */
export async function decodeImageDimensions(bytes: Uint8Array): Promise<ImageDimensions | null> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) return null;
    if (metadata.width > MAX_IMAGE_DIMENSION_PX || metadata.height > MAX_IMAGE_DIMENSION_PX) return null;
    if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) return null;
    return { width: metadata.width, height: metadata.height };
  } catch {
    // sharp throws for corrupt/truncated data, an unsupported/ambiguous
    // format, or (with `limitInputPixels` set) an oversized image it
    // refuses to even fully parse — all of these are "reject," uniformly.
    return null;
  }
}
