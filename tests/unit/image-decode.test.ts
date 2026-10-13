// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  decodeImageDimensions,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGE_PIXELS,
} from "@/server/storage/image-decode";

describe("decodeImageDimensions", () => {
  it("decodes a genuinely valid image and reports its real dimensions", async () => {
    const bytes = await sharp({
      create: { width: 50, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const result = await decodeImageDimensions(bytes);
    expect(result).toEqual({ width: 50, height: 30 });
  });

  it("rejects a corrupt/truncated image — valid magic bytes, but the body doesn't actually decode", async () => {
    const valid = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    // A real, valid JPEG magic-byte header (sniffImageFormat would accept
    // this), but the body is cut off mid-scan — a decoder must reject it,
    // even though byte-sniffing alone cannot tell the difference.
    const truncated = valid.subarray(0, Math.floor(valid.length * 0.5));
    expect(await decodeImageDimensions(truncated)).toBeNull();
  });

  it("rejects plain garbage bytes", async () => {
    const garbage = new Uint8Array(200).fill(0x42);
    expect(await decodeImageDimensions(garbage)).toBeNull();
  });

  it("rejects an image whose width exceeds the configured dimension limit", async () => {
    // A 1px-tall strip — cheap to generate/encode — still proves the
    // per-axis dimension check independently of the total pixel-count cap.
    const tooWide = await sharp({
      create: { width: MAX_IMAGE_DIMENSION_PX + 1, height: 1, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .png()
      .toBuffer();
    expect(await decodeImageDimensions(tooWide)).toBeNull();
  });

  it("accepts an image exactly at the dimension limit (boundary correctness)", async () => {
    const atLimit = await sharp({
      create: { width: MAX_IMAGE_DIMENSION_PX, height: 1, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .png()
      .toBuffer();
    const result = await decodeImageDimensions(atLimit);
    expect(result).toEqual({ width: MAX_IMAGE_DIMENSION_PX, height: 1 });
  });

  it("rejects an image whose total pixel count exceeds the limit even within per-axis bounds", async () => {
    // 7500 x 6000 = 45,000,000 px > MAX_IMAGE_PIXELS (40,000,000), while
    // both axes individually stay under MAX_IMAGE_DIMENSION_PX — proves the
    // area check is independent of the per-axis check (a decompression-bomb
    // guard specifically, per this module's own doc comment).
    expect(7500 * 6000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(7500).toBeLessThan(MAX_IMAGE_DIMENSION_PX);
    const bomb = await sharp({
      create: { width: 7500, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(await decodeImageDimensions(bomb)).toBeNull();
  }, 20_000);
});
