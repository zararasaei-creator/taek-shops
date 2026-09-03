// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isValidSlug, normalizeSlug, slugify } from "@/server/catalog/slug";
import { optionSignature } from "@/server/catalog/option-signature";

describe("slug", () => {
  it("slugifies arbitrary text", () => {
    expect(slugify("Student Taekwondo Uniform")).toBe("student-taekwondo-uniform");
    expect(slugify("Cafe  Taekwon-Do / 000!")).toBe("cafe-taekwon-do-000");
    expect(slugify("---")).toBe("");
  });

  it("validates slugs strictly", () => {
    expect(isValidSlug("a-b-1")).toBe(true);
    expect(isValidSlug("A-B")).toBe(false);
    expect(isValidSlug("a--b")).toBe(false);
    expect(isValidSlug("-a")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("normalizeSlug keeps valid input and slugifies the rest", () => {
    expect(normalizeSlug("already-valid")).toBe("already-valid");
    expect(normalizeSlug("Needs Fixing")).toBe("needs-fixing");
    expect(() => normalizeSlug("!!!")).toThrow();
  });
});

describe("optionSignature", () => {
  it("is order-independent and de-duplicated", () => {
    expect(optionSignature(["b", "a", "c"])).toBe("a|b|c");
    expect(optionSignature(["a", "a"])).toBe("a");
    expect(optionSignature([])).toBe("");
  });
});
