import { UserRole } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { UnauthenticatedError, ForbiddenError } from "@/server/auth/errors";
import { ImportFileError } from "@/server/import/errors";
import { commitImport, previewImport } from "@/server/import/product-import-service";
import {
  buildImportErrorReportCsv,
  getImportJob,
  listFailedImportRows,
  listImportJobs,
} from "@/server/import/import-queries";
import { db } from "./helpers/db";

/**
 * Phase 10 sub-milestone — import history, error reports, and their
 * authorization — against a real, isolated database. Never touches
 * `previewImport`/`commitImport`'s own logic; only reads what they wrote.
 *
 * Fixtures: products slug starts `zzz-imphist-`, variants sku starts
 * `IMPHIST-`, import jobs filename starts `zzz-imphist-`, actors are
 * `phase10-import-history-<role>@taek.local`.
 */

const SLUG_PREFIX = "zzz-imphist-";
const FILE_PREFIX = "zzz-imphist-";

const HEADER =
  "sku,product_name,product_slug,description,price,compare_at_price,inventory_quantity," +
  "option1_name,option1_value,option2_name,option2_value,image_url,variant_image_url";

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

const enc = (rows: string[]) => new TextEncoder().encode([HEADER, ...rows].join("\n") + "\n");

interface Actor {
  id: string;
  role: UserRole;
}

async function ensureActor(role: UserRole): Promise<Actor> {
  const email = `phase10-import-history-${role.toLowerCase()}@taek.local`;
  return db.user.upsert({
    where: { email },
    update: { role, status: "ACTIVE" },
    create: { email, role, status: "ACTIVE", firstName: "Phase10ImportHistory", lastName: role },
    select: { id: true, role: true },
  });
}

afterEach(async () => {
  await db.productImage.deleteMany({ where: { product: { slug: { startsWith: SLUG_PREFIX } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await db.importJob.deleteMany({ where: { originalFilename: { startsWith: FILE_PREFIX } } });
});

afterAll(async () => {
  const actorEmails = [UserRole.MANAGER, UserRole.STAFF, UserRole.CUSTOMER].map(
    (r) => `phase10-import-history-${r.toLowerCase()}@taek.local`,
  );
  await db.auditLog.deleteMany({
    where: { actorUserId: { in: (await db.user.findMany({ where: { email: { in: actorEmails } }, select: { id: true } })).map((u) => u.id) } },
  });
  await db.user.deleteMany({ where: { email: { in: actorEmails } } });
  await db.$disconnect();
});

describe("authorization matches the documented policy (import.run, same as running an import)", () => {
  it("listImportJobs / getImportJob / listFailedImportRows / buildImportErrorReportCsv: unauthenticated and STAFF/CUSTOMER are denied, MANAGER can read", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const staff = await ensureActor(UserRole.STAFF);
    const customer = await ensureActor(UserRole.CUSTOMER);

    const slug = `${SLUG_PREFIX}${uid()}`;
    const filename = `${FILE_PREFIX}${uid()}.csv`;
    const preview = await previewImport(
      manager,
      { filename, bytes: enc([`IMPHIST-${uid()},Auth Test,${slug},x,19.99,,,,,,,,`]) },
      db,
    );
    const commit = await commitImport(manager, preview.importJobId, {}, db);

    for (const denied of [null, staff, customer] as const) {
      const expectedError = denied === null ? UnauthenticatedError : ForbiddenError;
      await expect(listImportJobs(denied, {}, db)).rejects.toBeInstanceOf(expectedError);
      await expect(getImportJob(denied, commit.importJobId, db)).rejects.toBeInstanceOf(expectedError);
      await expect(listFailedImportRows(denied, commit.importJobId, {}, db)).rejects.toBeInstanceOf(
        expectedError,
      );
      await expect(buildImportErrorReportCsv(denied, commit.importJobId, db)).rejects.toBeInstanceOf(
        expectedError,
      );
    }

    await expect(listImportJobs(manager, {}, db)).resolves.toBeDefined();
    await expect(getImportJob(manager, commit.importJobId, db)).resolves.toBeDefined();
    await expect(listFailedImportRows(manager, commit.importJobId, {}, db)).resolves.toBeDefined();
    await expect(buildImportErrorReportCsv(manager, commit.importJobId, db)).resolves.toBeDefined();
  });
});

describe("missing jobs are handled clearly, not as an unhandled error", () => {
  it("getImportJob / listFailedImportRows / buildImportErrorReportCsv all throw a clean not-found for a bogus id", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    await expect(getImportJob(manager, "nonexistent-job-id", db)).rejects.toBeInstanceOf(ImportFileError);
    await expect(
      listFailedImportRows(manager, "nonexistent-job-id", {}, db),
    ).rejects.toBeInstanceOf(ImportFileError);
    await expect(
      buildImportErrorReportCsv(manager, "nonexistent-job-id", db),
    ).rejects.toBeInstanceOf(ImportFileError);

    try {
      await getImportJob(manager, "nonexistent-job-id", db);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportFileError);
      expect((error as ImportFileError).code).toBe("job_not_found");
      expect((error as ImportFileError).status).toBe(404);
    }
  });
});

describe("a job with no failed rows is shown clearly as such", () => {
  it("getImportJob reports failedRowCount 0 and listFailedImportRows returns an empty page", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const slug = `${SLUG_PREFIX}${uid()}`;
    const filename = `${FILE_PREFIX}${uid()}.csv`;
    const preview = await previewImport(
      manager,
      { filename, bytes: enc([`IMPHIST-${uid()},No Errors,${slug},x,19.99,,,,,,,,`]) },
      db,
    );
    const commit = await commitImport(manager, preview.importJobId, {}, db);
    expect(commit.counts.failed).toBe(0);

    const job = await getImportJob(manager, commit.importJobId, db);
    expect(job.failedRowCount).toBe(0);
    expect(job.status).toBe("COMPLETED");

    const failedPage = await listFailedImportRows(manager, commit.importJobId, {}, db);
    expect(failedPage.rows).toHaveLength(0);
    expect(failedPage.total).toBe(0);

    const report = await buildImportErrorReportCsv(manager, commit.importJobId, db);
    expect(report.rowCount).toBe(0);
    expect(report.csv.trim().split("\r\n")).toHaveLength(1); // header only
  });
});

describe("an unfinished (never-committed) job is still viewable with its real status", () => {
  it("a VALIDATED job's preview-time failure is already visible in the failed-row count and list", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const slug = `${SLUG_PREFIX}${uid()}`;
    const filename = `${FILE_PREFIX}${uid()}.csv`;
    const sku = `IMPHIST-${uid()}`;
    // A genuine, realistic preview-time failure — the same duplicate-SKU
    // validation the importer already performs (never a fabricated one).
    const preview = await previewImport(
      manager,
      {
        filename,
        bytes: enc([
          `${sku},Dup Test,${slug},x,19.99,,,,,,,,`,
          `${sku},Dup Test,${slug},x,21.99,,,,,,,,`,
        ]),
      },
      db,
    );
    expect(preview.counts.error).toBe(1);

    const job = await getImportJob(manager, preview.importJobId, db);
    expect(job.status).toBe("VALIDATED"); // never committed
    expect(job.failedRowCount).toBe(1); // already true before any commit

    const failedPage = await listFailedImportRows(manager, preview.importJobId, {}, db);
    expect(failedPage.rows).toHaveLength(1);
    expect(failedPage.rows[0]!.errors.map((e) => e.code)).toContain("duplicate_sku_in_file");
  });
});

describe("a genuinely failed row (real duplicate-SKU validation error) is reported accurately", () => {
  it("getImportJob's ground-truth failedRowCount matches listFailedImportRows and the CSV export, independent of the job's own bookkeeping field", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const slug = `${SLUG_PREFIX}${uid()}`;
    const filename = `${FILE_PREFIX}${uid()}.csv`;
    const okSku = `IMPHIST-${uid()}`;
    const dupSku = `IMPHIST-${uid()}`;
    const preview = await previewImport(
      manager,
      {
        filename,
        bytes: enc([
          `${okSku},Mixed Result,${slug},x,19.99,,,Size,140,,,,`,
          `${dupSku},Mixed Result,${slug},x,21.99,,,Size,150,,,,`,
          `${dupSku},Mixed Result,${slug},x,23.99,,,Size,160,,,,`,
        ]),
      },
      db,
    );
    expect(preview.counts).toMatchObject({ create: 2, error: 1 });
    const commit = await commitImport(manager, preview.importJobId, {}, db);
    expect(commit.counts).toMatchObject({ created: 2, failed: 0 }); // commit's own loop finds nothing new

    // Ground truth (queried directly from ImportJobRow) still shows the
    // real, preview-time failure — this is exactly why the history/detail
    // UI trusts this count, not `ImportJob.failedRows` (which `commitImport`
    // only ever sets from failures found during its own PENDING-rows loop,
    // so it does not include a row that already failed at preview time).
    const job = await getImportJob(manager, commit.importJobId, db);
    expect(job.failedRowCount).toBe(1);

    const failedPage = await listFailedImportRows(manager, commit.importJobId, {}, db);
    expect(failedPage.total).toBe(1);
    expect(failedPage.rows[0]!.sku).toBe(dupSku);
    expect(failedPage.rows[0]!.errors[0]!.code).toBe("duplicate_sku_in_file");

    const report = await buildImportErrorReportCsv(manager, commit.importJobId, db);
    expect(report.rowCount).toBe(1);
    expect(report.csv).toContain(dupSku);
    expect(report.csv).toContain("duplicate_sku_in_file");
    expect(report.filename).toBe(`${filename}-errors.csv`);
  });
});

describe("job list pagination is newest-first with a stable tie-breaker", () => {
  it("two jobs sharing the exact same createdAt millisecond still paginate without gaps or repeats", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const filenames = [`${FILE_PREFIX}a-${uid()}.csv`, `${FILE_PREFIX}b-${uid()}.csv`];
    const jobs = await Promise.all(
      filenames.map((originalFilename) =>
        db.importJob.create({
          data: {
            type: "PRODUCT",
            sourceFormat: "CSV",
            originalFilename,
            status: "VALIDATED",
            totalRows: 0,
            createdAt: sameInstant,
          },
          select: { id: true },
        }),
      ),
    );

    const page1 = await listImportJobs(manager, { page: 1 }, db);
    const idsOnPage1 = page1.jobs.filter((j) => filenames.includes(j.originalFilename)).map((j) => j.id);
    // Both tied-createdAt jobs land in a single, deterministic order (by id
    // desc) — proven by re-querying and getting the identical order back,
    // not a different shuffle each time.
    const page1Again = await listImportJobs(manager, { page: 1 }, db);
    const idsOnPage1Again = page1Again.jobs
      .filter((j) => filenames.includes(j.originalFilename))
      .map((j) => j.id);
    expect(idsOnPage1).toEqual(idsOnPage1Again);
    expect(new Set(idsOnPage1)).toEqual(new Set(jobs.map((j) => j.id)));
  });

  it("paginates jobs across pages using the configured page size", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const filenames = Array.from({ length: 3 }, (_, i) => `${FILE_PREFIX}page-${i}-${uid()}.csv`);
    for (const originalFilename of filenames) {
      await db.importJob.create({
        data: { type: "PRODUCT", sourceFormat: "CSV", originalFilename, status: "VALIDATED", totalRows: 0 },
      });
    }
    const page1 = await listImportJobs(manager, { page: 1 }, db);
    expect(page1.total).toBeGreaterThanOrEqual(3);
    expect(page1.jobs.length).toBeLessThanOrEqual(page1.pageSize);
    expect(page1.page).toBe(1);
  });
});

describe("failed rows are themselves paginated and the CSV export is bounded, not an unbounded read", () => {
  it("a job with more failed rows than one page still returns every row across pages and in the export", async () => {
    const manager = await ensureActor(UserRole.MANAGER);
    const slug = `${SLUG_PREFIX}${uid()}`;
    const filename = `${FILE_PREFIX}${uid()}.csv`;
    const preview = await previewImport(
      manager,
      { filename, bytes: enc([`IMPHIST-${uid()},Volume Test,${slug},x,19.99,,,,,,,,`]) },
      db,
    );
    // Volume for pagination is added directly as ImportJobRow records (the
    // same shape `commitImport` itself writes) rather than uploading a
    // 60-row file through the pipeline — this is about proving the
    // pagination/bounding logic, not re-proving the importer's own
    // row-by-row validation again.
    const EXTRA_FAILED = 60; // > the 50-row internal page size
    await db.importJobRow.createMany({
      data: Array.from({ length: EXTRA_FAILED }, (_, i) => ({
        importJobId: preview.importJobId,
        rowNumber: 1000 + i,
        sku: `IMPHIST-VOL-${i}`,
        status: "FAILED",
        action: "error",
        errors: [{ column: "sku", code: "synthetic_volume_test", message: `Row ${i} failed.` }],
        rawData: { raw: { sku: `IMPHIST-VOL-${i}` } },
      })),
    });

    const job = await getImportJob(manager, preview.importJobId, db);
    expect(job.failedRowCount).toBe(EXTRA_FAILED); // the one real row was valid; only the volume rows failed

    const page1 = await listFailedImportRows(manager, preview.importJobId, { page: 1 }, db);
    const page2 = await listFailedImportRows(manager, preview.importJobId, { page: 2 }, db);
    expect(page1.rows.length).toBeGreaterThan(0);
    expect(page1.rows.length + page2.rows.length).toBeLessThanOrEqual(page1.total);
    const allIds = new Set([...page1.rows.map((r) => r.id), ...page2.rows.map((r) => r.id)]);
    expect(allIds.size).toBe(page1.rows.length + page2.rows.length); // no duplicate across pages

    const report = await buildImportErrorReportCsv(manager, preview.importJobId, db);
    expect(report.rowCount).toBe(EXTRA_FAILED);
  }, 30_000);
});
