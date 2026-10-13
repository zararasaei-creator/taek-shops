import ExcelJS from "exceljs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commitImport, previewImport } from "@/server/import/product-import-service";
import { getImportJob, listFailedImportRows, buildImportErrorReportCsv } from "@/server/import/import-queries";
import { adjustInventory } from "@/server/inventory/inventory-service";
import { db, ensureActor } from "./helpers/db";

/**
 * Phase 10 — XLSX product import against a real PostgreSQL instance, proving
 * the format-neutral pipeline end to end: a real `.xlsx` file produces
 * exactly the same outcomes CSV does (row mapping, validation, upsert), and
 * the import-history/error-report feature (built against CSV originally)
 * works unmodified for an XLSX-sourced job.
 *
 * Fixtures: products slug starts `zzz-impxlsx-`, variants sku starts
 * `IMPXLSX-`, import jobs filename starts `zzz-impxlsx-`.
 */

const SLUG_PREFIX = "zzz-impxlsx-";
const FILE_PREFIX = "zzz-impxlsx-";
const HEADER = ["sku", "product_name", "product_slug", "price", "option1_name", "option1_value"];

async function xlsxBytes(rows: (string | number)[][]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(HEADER);
  for (const row of rows) sheet.addRow(row);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

afterEach(async () => {
  await db.productImage.deleteMany({ where: { product: { slug: { startsWith: SLUG_PREFIX } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await db.importJob.deleteMany({ where: { originalFilename: { startsWith: FILE_PREFIX } } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("a real .xlsx file flows through the exact same pipeline as CSV", () => {
  it("maps rows into a product with two variants, same as the CSV path", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}dobok`;
    const filename = `${FILE_PREFIX}valid.xlsx`;
    const bytes = await xlsxBytes([
      [`IMPXLSX-140`, "Student Dobok", slug, 39.99, "Size", "140"],
      [`IMPXLSX-160`, "Student Dobok", slug, 42.99, "Size", "160"],
    ]);

    const preview = await previewImport(actor, { filename, bytes }, db);
    expect(preview.counts).toMatchObject({ create: 2, error: 0 });

    const commit = await commitImport(actor, preview.importJobId, {}, db);
    expect(commit.counts).toMatchObject({ created: 2, failed: 0 });

    const product = await db.product.findUniqueOrThrow({
      where: { slug },
      include: { variants: true },
    });
    expect(product.variants).toHaveLength(2);
  });

  it("preserves a leading zero in a genuinely text-typed SKU cell end to end", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}leadzero`;
    const filename = `${FILE_PREFIX}leadzero.xlsx`;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(HEADER);
    const row = sheet.addRow(["placeholder", "Lead Zero Product", slug, 9.99, "", ""]);
    row.getCell(1).value = "007"; // explicitly a string value -> text-typed cell
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const preview = await previewImport(actor, { filename, bytes }, db);
    expect(preview.rows[0]!.sku).toBe("007");
    const commit = await commitImport(actor, preview.importJobId, {}, db);
    expect(commit.counts.created).toBe(1);

    const variant = await db.productVariant.findUniqueOrThrow({ where: { sku: "007" } });
    expect(variant.sku).toBe("007");
  });

  it("a missing-price row fails with the same validation error CSV produces, at the correct source row", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}badrow`;
    const filename = `${FILE_PREFIX}invalid.xlsx`;
    const bytes = await xlsxBytes([
      [`IMPXLSX-OK`, "Valid Row", slug, 19.99, "", ""],
      [`IMPXLSX-BAD`, "Bad Row", slug, "", "", ""], // price blank -> row 3
    ]);

    const preview = await previewImport(actor, { filename, bytes }, db);
    expect(preview.counts).toMatchObject({ create: 1, error: 1 });
    const badRow = preview.rows.find((r) => r.action === "error")!;
    expect(badRow.rowNumber).toBe(3); // header=1, first data row=2, second=3
    expect(badRow.errors[0]).toMatchObject({ column: "price", code: "required" });

    const commit = await commitImport(actor, preview.importJobId, {}, db);
    expect(commit.counts).toMatchObject({ created: 1, failed: 0 }); // the bad row already failed at preview

    // The import-history/error-report feature (built against CSV) works
    // unchanged for this XLSX-sourced job.
    const job = await getImportJob(actor, commit.importJobId, db);
    expect(job.sourceFormat).toBe("XLSX");
    expect(job.failedRowCount).toBe(1);

    // `parseProductRow` returns no `data` at all when ANY field fails
    // validation — including a field other than SKU — so `ImportJobRow.sku`
    // is `null` here even though the SKU cell itself parsed fine. This is
    // pre-existing `previewImport` behaviour (unrelated to XLSX, unchanged
    // by this pass), not something the history/error-report feature alters.
    const failedPage = await listFailedImportRows(actor, commit.importJobId, {}, db);
    expect(failedPage.rows[0]).toMatchObject({ rowNumber: 3, sku: null });
    expect(failedPage.rows[0]!.errors[0]).toMatchObject({ column: "price", code: "required" });

    const report = await buildImportErrorReportCsv(actor, commit.importJobId, db);
    expect(report.csv).toContain("required");
    expect(report.csv).toContain("Price is required.");
  });

  it("explicitly rejects a formula cell with a clear error — never commits its cached result, and never silently drops it as a soft warning", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}formula`;
    const filename = `${FILE_PREFIX}formula.xlsx`;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(HEADER);
    const row = sheet.addRow(["IMPXLSX-FORMULA", "Formula Row", slug, null, "", ""]);
    row.getCell(4).value = { formula: "1+1", result: 9999.99 } as unknown as ExcelJS.CellValue;
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const preview = await previewImport(actor, { filename, bytes }, db);
    expect(preview.counts).toMatchObject({ create: 0, error: 1 });
    const errorCodes = preview.rows[0]!.errors.map((e) => e.code);
    // The explicit, hard rejection (never a soft warning the row could
    // otherwise sail through on)...
    expect(errorCodes).toContain("formula_cell_rejected");
    // ...and, because this formula happened to be in a required field, the
    // formula's cached result (9999.99) is also never trusted/committed —
    // the price cell reads as empty, which independently fails validation.
    expect(errorCodes).toContain("required");

    await db.product.deleteMany({ where: { slug } }); // nothing should have been created anyway
    expect(await db.product.findUnique({ where: { slug } })).toBeNull();
  });

  it("explicitly rejects a formula cell in an OPTIONAL field — never silently imports the row with that field just blank", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}formula-optional`;
    const filename = `${FILE_PREFIX}formula-optional.xlsx`;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow([...HEADER, "description"]);
    const row = sheet.addRow(["IMPXLSX-FORMOPT", "Formula Optional Row", slug, 9.99, "", "", ""]);
    row.getCell(7).value = { formula: "1+1", result: "fake description" } as unknown as ExcelJS.CellValue;
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const preview = await previewImport(actor, { filename, bytes }, db);
    // Every other field (sku, product_name, product_slug, price) is valid —
    // without the explicit formula rejection, this row would otherwise be
    // accepted with `description` simply blank, no error surfaced anywhere.
    expect(preview.counts).toMatchObject({ create: 0, error: 1 });
    expect(preview.rows[0]!.errors.map((e) => e.code)).toContain("formula_cell_rejected");

    await db.product.deleteMany({ where: { slug } });
    expect(await db.product.findUnique({ where: { slug } })).toBeNull();
  });

  it("rejects a file over IMPORT_MAX_FILE_SIZE_BYTES at the real pipeline entry point (previewImport), same as CSV", async () => {
    // Exercises the actual upload boundary this codebase has a precedent
    // for testing: `previewImport`, the service function the upload route
    // calls into immediately after its own (untested-at-the-route-level,
    // CSRF-guarded) redundant pre-check. There is no existing precedent in
    // this codebase for invoking a `guardMutation`-protected route handler
    // directly in a test (the only route tested directly is the
    // signature-authenticated Stripe webhook, which has no CSRF/session
    // auth to satisfy) — building that infrastructure was out of scope for
    // this focused pass. This test proves the byte-size cap is enforced on
    // a real, larger-than-the-limit `.xlsx` file flowing through the same
    // entry point a real upload reaches, not just `parseXlsx` in isolation.
    const actor = await ensureActor();
    const filename = `${FILE_PREFIX}toolarge.xlsx`;
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push([`IMPXLSX-SIZE-${i}`, "Padding row to inflate file size well past any small limit", `${SLUG_PREFIX}size-${i}`, 9.99, "Size", `${i}`]);
    }
    const bytes = await xlsxBytes(rows);
    // `serverEnv` is parsed once at module load, so mutating `process.env`
    // alone would not change the already-cached limit — the same
    // stub-env + reset-modules + dynamic-reimport pattern used in
    // `tests/unit/import-xlsx-parser.test.ts` is needed to get a fresh
    // `previewImport` bound to the lowered limit.
    vi.stubEnv("IMPORT_MAX_FILE_SIZE_BYTES", String(Math.floor(bytes.byteLength / 2)));
    vi.resetModules();
    const { previewImport: cappedPreview } = await import("@/server/import/product-import-service");
    try {
      await expect(cappedPreview(actor, { filename, bytes }, db)).rejects.toMatchObject({
        code: "file_too_large",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("reports an in-file duplicate SKU in an XLSX file at preview time, same as CSV", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}dupsku`;
    const filename = `${FILE_PREFIX}dupsku.xlsx`;
    const bytes = await xlsxBytes([
      [`IMPXLSX-DUP`, "Dup Row A", slug, 19.99, "Size", "140"],
      [`IMPXLSX-DUP`, "Dup Row A", slug, 19.99, "Size", "160"],
    ]);

    const preview = await previewImport(actor, { filename, bytes }, db);
    expect(preview.counts).toMatchObject({ create: 1, error: 1 });
    const dupRow = preview.rows.find((r) => r.action === "error")!;
    expect(dupRow.errors.map((e) => e.code)).toContain("duplicate_sku_in_file");

    // The non-duplicate row commits fine; the duplicate never reaches
    // commit at all (it already failed at preview, same as CSV).
    const commit = await commitImport(actor, preview.importJobId, {}, db);
    expect(commit.counts).toMatchObject({ created: 1, failed: 0 });
  });

  it("re-importing the identical XLSX file is a business-level no-op: no duplicate products/variants or inventory changes (new audit/history rows are expected)", async () => {
    const actor = await ensureActor();
    const slug = `${SLUG_PREFIX}idempotent`;
    const filename = `${FILE_PREFIX}idempotent.xlsx`;
    const bytes = await xlsxBytes([
      [`IMPXLSX-IDEMP-1`, "Idempotent Dobok", slug, 44.99, "Size", "140"],
      [`IMPXLSX-IDEMP-2`, "Idempotent Dobok", slug, 47.99, "Size", "160"],
    ]);

    const firstPreview = await previewImport(actor, { filename, bytes }, db);
    expect(firstPreview.counts).toMatchObject({ create: 2, error: 0 });
    const firstCommit = await commitImport(actor, firstPreview.importJobId, {}, db);
    expect(firstCommit.counts).toMatchObject({ created: 2, failed: 0 });

    const productAfterFirst = await db.product.findUniqueOrThrow({
      where: { slug },
      include: { variants: { include: { inventoryItem: true } } },
    });
    expect(productAfterFirst.variants).toHaveLength(2);

    // Give each variant a known, non-zero on-hand quantity so the re-import
    // safety check below is a real comparison, not a trivial 0 === 0 one
    // (a fresh import always creates inventory at 0, which would pass this
    // assertion even if the re-import logic were broken).
    await adjustInventory(
      actor,
      { sku: "IMPXLSX-IDEMP-1", setOnHand: 15, reason: "test fixture" },
      db,
    );
    await adjustInventory(
      actor,
      { sku: "IMPXLSX-IDEMP-2", setOnHand: 9, reason: "test fixture" },
      db,
    );
    const stockBySku = (variants: { sku: string; inventoryItem: { quantityOnHand: number } | null }[]) =>
      Object.fromEntries(variants.map((v) => [v.sku, v.inventoryItem?.quantityOnHand ?? null]));

    const stockBefore = stockBySku(
      (
        await db.product.findUniqueOrThrow({
          where: { slug },
          include: { variants: { include: { inventoryItem: true } } },
        })
      ).variants,
    );
    expect(stockBefore).toEqual({ "IMPXLSX-IDEMP-1": 15, "IMPXLSX-IDEMP-2": 9 });

    // Re-import the exact same bytes as a brand-new job (a real re-upload
    // would also produce a new ImportJob/ImportJobRow — that bookkeeping is
    // expected and is NOT what this test asserts against).
    const secondPreview = await previewImport(actor, { filename, bytes }, db);
    // Preview classifies an already-existing SKU as "update" (it cannot
    // know ahead of commit whether the data is actually unchanged); the
    // true no-op outcome ("skipped") is only determined inside `applyRow`
    // at commit time, asserted below.
    expect(secondPreview.counts).toMatchObject({ create: 0, update: 2, error: 0 });
    const secondCommit = await commitImport(actor, secondPreview.importJobId, {}, db);
    expect(secondCommit.counts).toMatchObject({ created: 0, updated: 0, skipped: 2, failed: 0 });

    const productsAfterSecond = await db.product.findMany({
      where: { slug },
      include: { variants: { include: { inventoryItem: true } } },
    });
    // No duplicate product and no duplicate variants were created.
    expect(productsAfterSecond).toHaveLength(1);
    expect(productsAfterSecond[0]!.variants).toHaveLength(2);
    // No unintended inventory change from the no-op re-import.
    const stockAfter = stockBySku(productsAfterSecond[0]!.variants);
    expect(stockAfter).toEqual(stockBefore);

    // New ImportJob/ImportJobRow rows from the second run are expected and
    // legitimate (audit trail), unlike catalog/inventory duplication.
    const jobs = await db.importJob.findMany({ where: { originalFilename: filename } });
    expect(jobs).toHaveLength(2);
  });

  it(
    "a deterministic injected failure partway through commit: the earlier row stays committed, the " +
      "failing row's own transaction rolls back with no partial write, later rows still commit, and the " +
      "supported retry workflow (a new import) fills the gap without duplicates or inventory drift",
    async () => {
      // This is INJECTED-EXCEPTION coverage of `commitImport`'s real,
      // already-existing per-row transaction design (confirmed by reading
      // `product-import-service.ts` fresh: each row's `applyRow` runs
      // inside its own `db.$transaction`, wrapped in a per-row try/catch
      // that marks the row FAILED and continues the loop — there is no
      // whole-commit transaction, and no documented crash-recovery
      // guarantee anywhere in the source). It proves behaviour under a
      // real exception thrown mid-loop by genuine application logic (a
      // Prisma unique-constraint violation) — it does NOT prove, and is
      // not evidence of, recovery from a real process crash (e.g. the
      // Node process being killed or losing power mid-commit); no test in
      // this codebase exercises that scenario.
      const actor = await ensureActor();
      const slug = `${SLUG_PREFIX}failrecover`;
      const filename = `${FILE_PREFIX}failrecover.xlsx`;

      // Row A and Row C are independently valid. Row B is engineered to
      // pass every preview-time check — `previewImport` only detects
      // duplicate SKUs in-file, never duplicate option combinations — but
      // to fail for real at commit time: it reuses product X's exact
      // "Size: 140" option combination already taken by Row A, which
      // violates the real `@@unique([productId, optionSignature])`
      // constraint `applyRow` relies on. This is a genuine, reproducible
      // `applyRow` failure, not a mocked or forced exception.
      const bytes = await xlsxBytes([
        [`IMPXLSX-FAILREC-A`, "Fail Recovery Dobok", slug, 29.99, "Size", "140"],
        [`IMPXLSX-FAILREC-B`, "Fail Recovery Dobok", slug, 31.99, "Size", "140"],
        [`IMPXLSX-FAILREC-C`, "Fail Recovery Dobok", slug, 33.99, "Size", "160"],
      ]);

      const preview = await previewImport(actor, { filename, bytes }, db);
      // Preview cannot see the option-combination clash, so all three rows
      // look valid at this stage.
      expect(preview.counts).toMatchObject({ create: 3, error: 0 });

      const commit = await commitImport(actor, preview.importJobId, {}, db);
      expect(commit.counts).toMatchObject({ created: 2, failed: 1 });

      // Row A (committed before the failure) remains; Row C (attempted
      // after the failure) was still created — the loop did not abort on
      // Row B's exception. Row B itself produced no variant at all — its
      // own transaction rolled back completely, leaving no partial write.
      const productAfterFailure = await db.product.findUniqueOrThrow({
        where: { slug },
        include: { variants: { include: { inventoryItem: true } } },
      });
      expect(productAfterFailure.variants.map((v) => v.sku).sort()).toEqual([
        "IMPXLSX-FAILREC-A",
        "IMPXLSX-FAILREC-C",
      ]);

      const failedPage = await listFailedImportRows(actor, commit.importJobId, {}, db);
      expect(failedPage.rows).toHaveLength(1);
      expect(failedPage.rows[0]).toMatchObject({ sku: "IMPXLSX-FAILREC-B" });
      expect(failedPage.rows[0]!.errors[0]!.code).toBe("commit_failed");

      // The real, supported behaviour: a partially-successful commit still
      // ends the job in COMPLETED (not VALIDATED) status, so `commitImport`
      // cannot be called again on this same job — there is no "retry the
      // same job" path.
      const jobAfterFailure = await db.importJob.findUniqueOrThrow({
        where: { id: commit.importJobId },
      });
      expect(jobAfterFailure.status).toBe("COMPLETED");
      await expect(commitImport(actor, commit.importJobId, {}, db)).rejects.toMatchObject({
        code: "job_wrong_state",
      });

      // Give the two already-succeeded variants a known, non-zero on-hand
      // quantity so the retry's safety can be checked against real
      // inventory state, not a trivial 0 === 0 comparison.
      await adjustInventory(
        actor,
        { sku: "IMPXLSX-FAILREC-A", setOnHand: 12, reason: "test fixture" },
        db,
      );
      await adjustInventory(
        actor,
        { sku: "IMPXLSX-FAILREC-C", setOnHand: 7, reason: "test fixture" },
        db,
      );

      // The supported retry workflow: re-upload a corrected file (same
      // SKUs, Row B's option value fixed to no longer clash) as a
      // brand-new import job. Upsert-by-SKU means the two already-
      // succeeded rows are safely re-attempted (expected to be no-ops),
      // and only the genuinely-missing row is newly created.
      const retryFilename = `${FILE_PREFIX}failrecover-retry.xlsx`;
      const retryBytes = await xlsxBytes([
        [`IMPXLSX-FAILREC-A`, "Fail Recovery Dobok", slug, 29.99, "Size", "140"],
        [`IMPXLSX-FAILREC-B`, "Fail Recovery Dobok", slug, 31.99, "Size", "180"],
        [`IMPXLSX-FAILREC-C`, "Fail Recovery Dobok", slug, 33.99, "Size", "160"],
      ]);
      const retryPreview = await previewImport(actor, { filename: retryFilename, bytes: retryBytes }, db);
      const retryCommit = await commitImport(actor, retryPreview.importJobId, {}, db);
      expect(retryCommit.counts).toMatchObject({ created: 1, updated: 0, skipped: 2, failed: 0 });

      const productAfterRetry = await db.product.findUniqueOrThrow({
        where: { slug },
        include: { variants: { include: { inventoryItem: true } } },
      });
      // All three variants now exist, exactly once each — no duplicates
      // from either the original partial commit or the retry.
      expect(productAfterRetry.variants.map((v) => v.sku).sort()).toEqual([
        "IMPXLSX-FAILREC-A",
        "IMPXLSX-FAILREC-B",
        "IMPXLSX-FAILREC-C",
      ]);

      // The retry did not disturb the already-correct inventory of the two
      // previously-succeeded variants.
      const stockA = productAfterRetry.variants.find((v) => v.sku === "IMPXLSX-FAILREC-A")!
        .inventoryItem!.quantityOnHand;
      const stockC = productAfterRetry.variants.find((v) => v.sku === "IMPXLSX-FAILREC-C")!
        .inventoryItem!.quantityOnHand;
      expect(stockA).toBe(12);
      expect(stockC).toBe(7);
    },
  );
});
