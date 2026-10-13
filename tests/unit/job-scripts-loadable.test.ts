// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression guard found by running the production image: `scripts/dispatch-emails.ts`
 * and `scripts/cleanup-image-uploads.ts` run under plain `node` (type-stripping
 * only), which rejects non-erasable TypeScript — notably constructor parameter
 * properties — with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. `ResendOrderMailer` used one,
 * so the email job could not even start in production while every Vitest suite
 * (which transpiles) stayed green. This loads the exact modules those scripts import
 * (read from the scripts themselves, so the list can't go stale) under real `node`.
 * Import only — no database is touched and no script's `main()` runs.
 */

const root = resolve(__dirname, "..", "..");
const NODE_SCRIPTS = ["scripts/dispatch-emails.ts", "scripts/cleanup-image-uploads.ts"];

function relativeSrcImports(script: string): string[] {
  const source = readFileSync(join(root, script), "utf8");
  return [...source.matchAll(/from\s+"(\.\.\/src\/[^"]+\.ts)"/g)].map((m) => m[1]!);
}

describe("node-run job scripts import only type-strippable modules", () => {
  for (const script of NODE_SCRIPTS) {
    const imports = relativeSrcImports(script);

    it(`${script} imports at least one app module (the extraction itself works)`, () => {
      expect(imports.length).toBeGreaterThan(0);
    });

    for (const rel of imports) {
      it(`${script} → ${rel} loads under plain node`, () => {
        const url = pathToFileURL(resolve(root, "scripts", rel)).href;
        expect(() =>
          execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], {
            cwd: root,
            stdio: "pipe",
            timeout: 30_000,
            env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x" },
          }),
        ).not.toThrow();
      });
    }
  }
});
