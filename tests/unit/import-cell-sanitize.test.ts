// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  csvField,
  escapeForCsvOutput,
  looksLikeFormula,
  neutralizeForImport,
  toCsv,
} from "@/server/import/cell-sanitize";

describe("CSV / spreadsheet injection defence", () => {
  it("detects formula-triggering leads", () => {
    for (const value of ["=SUM(A1)", "+1+1", "-1", "@cmd", "\t=x"]) {
      expect(looksLikeFormula(value)).toBe(true);
    }
    expect(looksLikeFormula("Taek Basics")).toBe(false);
  });

  it("neutralises values read from an upload", () => {
    expect(neutralizeForImport("=1+1")).toEqual({ value: "1+1", wasNeutralized: true });
    expect(neutralizeForImport("@SUM(A1:A9)")).toEqual({
      value: "SUM(A1:A9)",
      wasNeutralized: true,
    });
    expect(neutralizeForImport("  =cmd|' /C calc'!A0")).toEqual({
      value: "cmd|' /C calc'!A0",
      wasNeutralized: true,
    });
    expect(neutralizeForImport("Normal value")).toEqual({
      value: "Normal value",
      wasNeutralized: false,
    });
  });

  it("strips control characters", () => {
    const withControls = `White${String.fromCharCode(0)}${String.fromCharCode(7)}Uniform`;
    expect(neutralizeForImport(withControls)).toEqual({
      value: "WhiteUniform",
      wasNeutralized: true,
    });
  });

  it("escapes values written back to CSV", () => {
    expect(escapeForCsvOutput("=1+1")).toBe("'=1+1");
    expect(escapeForCsvOutput("safe")).toBe("safe");
    expect(csvField('a"b,c')).toBe('"a""b,c"');
    expect(csvField("=x")).toBe("'=x");
  });

  it("builds a CSV document", () => {
    const csv = toCsv(["a", "b"], [["1", "=2"]]);
    expect(csv).toBe("a,b\r\n1,'=2\r\n");
  });
});
