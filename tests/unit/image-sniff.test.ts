// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sniffImageFormat } from "@/server/storage/image-sniff";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function padded(header: number[], total = 16): Uint8Array {
  const out = new Uint8Array(total);
  out.set(header.slice(0, total));
  return out;
}

describe("sniffImageFormat", () => {
  it("detects a real JPEG by its magic bytes", () => {
    expect(sniffImageFormat(padded([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF")]))).toBe(
      "image/jpeg",
    );
  });

  it("detects a real PNG by its magic bytes", () => {
    expect(
      sniffImageFormat(padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])),
    ).toBe("image/png");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(sniffImageFormat(padded(ascii("GIF87a") ))).toBe("image/gif");
    expect(sniffImageFormat(padded(ascii("GIF89a")))).toBe("image/gif");
  });

  it("detects WEBP (RIFF....WEBP)", () => {
    const header = [...ascii("RIFF"), 0x00, 0x00, 0x00, 0x00, ...ascii("WEBP")];
    expect(sniffImageFormat(padded(header))).toBe("image/webp");
  });

  it("detects AVIF (ftyp box with avif/avis brand)", () => {
    const avif = [0x00, 0x00, 0x00, 0x1c, ...ascii("ftyp"), ...ascii("avif")];
    expect(sniffImageFormat(padded(avif))).toBe("image/avif");
    const avis = [0x00, 0x00, 0x00, 0x1c, ...ascii("ftyp"), ...ascii("avis")];
    expect(sniffImageFormat(padded(avis))).toBe("image/avif");
  });

  it("rejects SVG content even though it's plausible-looking text", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageFormat(svg)).toBeNull();
  });

  it("rejects SVG with an XML prolog", () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg></svg>');
    expect(sniffImageFormat(svg)).toBeNull();
  });

  it("rejects SVG content mislabeled with JPEG-like padding (defense in depth)", () => {
    // Leading whitespace / BOM before the markup must not defeat detection.
    const svg = new TextEncoder().encode('   \n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageFormat(svg)).toBeNull();
  });

  it("rejects plain garbage bytes", () => {
    expect(sniffImageFormat(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBeNull();
  });

  it("rejects a truncated/too-short buffer", () => {
    expect(sniffImageFormat(bytes(0xff, 0xd8, 0xff))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
  });

  it("does not misidentify a JPEG as any other format", () => {
    const jpeg = padded([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffImageFormat(jpeg)).toBe("image/jpeg");
    expect(sniffImageFormat(jpeg)).not.toBe("image/png");
  });
});
