import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import ExcelJS from "exceljs";
import { PrismaClient, UserRole } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword } from "@/server/auth/password";
import { loginAs } from "./helpers/login";

/**
 * Phase 10 — import history, error reports, and the CSV AND XLSX import
 * flows, against the dedicated e2e server (localhost:3100 — see
 * playwright.config.ts) and the isolated `TEST_DATABASE_URL`. Self-contained:
 * creates and tears down its own fixtures, independent of other specs'.
 *
 * One real login for BOTH formats' whole consolidated flow (the same
 * budget-conscious approach `admin-orders.spec.ts` and
 * `product-images.spec.ts` already use for this suite's shared, IP-keyed
 * login rate limit — see those files' comments): every step that needs an
 * authenticated request after that reuses the same browser session
 * (`page.goto`) or its cookies (`page.request`), never a second `loginAs`.
 * CSV and XLSX were originally two separate spec files, each with its own
 * login; merged into this one login after adding a second file pushed the
 * whole suite's total logins over the shared budget (confirmed via a real
 * login timeout in a full-suite run) — the fix is here, consolidating
 * logins, never in the rate limiter itself, same remedy this codebase has
 * applied before. The denial check below uses `request`/`page.goto` with
 * NO login at all (matching `catalog.spec.ts`'s existing "requires
 * authentication" style), so it costs nothing against that budget.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN_ID = randomBytes(4).toString("hex");
const MANAGER_EMAIL = `e2e-imphist-manager-${RUN_ID}@taek.local`;
const PASSWORD = "ImportHistory-Verify-2026!";
const SLUG_PREFIX = `zzz-e2e-imphist-${RUN_ID}`;
const FILE_PREFIX = `zzz-e2e-imphist-${RUN_ID}`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

const HEADER =
  "sku,product_name,product_slug,description,price,compare_at_price,inventory_quantity," +
  "option1_name,option1_value,option2_name,option2_value,image_url,variant_image_url";

function csvBuffer(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join("\n") + "\n", "utf-8");
}

const XLSX_HEADER = ["sku", "product_name", "product_slug", "price"];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function xlsxBuffer(
  rows: (string | number)[][],
  opts: { extraSheetWithData?: boolean } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(XLSX_HEADER);
  for (const row of rows) sheet.addRow(row);
  if (opts.extraSheetWithData) {
    const other = workbook.addWorksheet("Also Has Data");
    other.addRow(["unexpected", "data"]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test.beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  await db.user.create({
    data: {
      email: MANAGER_EMAIL,
      role: UserRole.MANAGER,
      status: "ACTIVE",
      firstName: "E2E",
      lastName: "ImportHistory Manager",
      emailVerifiedAt: new Date(),
      passwordHash,
    },
  });
});

test.afterAll(async () => {
  await db.productImage.deleteMany({ where: { product: { slug: { startsWith: SLUG_PREFIX } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  const jobs = await db.importJob.findMany({
    where: { originalFilename: { startsWith: FILE_PREFIX } },
    select: { id: true },
  });
  await db.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  const actor = await db.user.findUnique({ where: { email: MANAGER_EMAIL }, select: { id: true } });
  if (actor) await db.auditLog.deleteMany({ where: { actorUserId: actor.id } });
  await db.user.deleteMany({ where: { email: MANAGER_EMAIL } });
  await db.$disconnect();
});

test("a MANAGER runs a CSV import and an XLSX import, each with a real validation failure, then reviews both via history, detail, and a downloaded error report", async ({
  page,
}) => {
  await loginAs(page, MANAGER_EMAIL, PASSWORD);

  // --- Upload → preview → commit, with one genuine duplicate-SKU failure ---
  const slug = `${SLUG_PREFIX}-a`;
  const okSku = `E2EIMPHIST-${RUN_ID}-OK`;
  const dupSku = `E2EIMPHIST-${RUN_ID}-DUP`;
  const filename = `${FILE_PREFIX}-with-errors.csv`;
  const csv = csvBuffer([
    `${okSku},E2E Import History Product,${slug},x,19.99,,,Size,140,,,,`,
    `${dupSku},E2E Import History Product,${slug},x,21.99,,,Size,150,,,,`,
    `${dupSku},E2E Import History Product,${slug},x,23.99,,,Size,160,,,,`,
  ]);

  await page.goto("/admin/catalog/import");
  await page.getByLabel("CSV or XLSX file").setInputFiles({ name: filename, mimeType: "text/csv", buffer: csv });
  await page.getByRole("button", { name: "Preview (dry-run)" }).click();
  await expect(page.getByText("2 create")).toBeVisible();
  await expect(page.getByText("1 error")).toBeVisible();

  await page.getByRole("button", { name: /Commit \d+ row\(s\)/ }).click();
  await expect(page.getByText(/Import completed: 2 created/)).toBeVisible();
  await expect(page.getByText("1 failed", { exact: false })).toBeVisible();

  const detailLink = page.getByRole("link", { name: "View details" });
  await expect(detailLink).toBeVisible();
  const downloadLink = page.getByRole("link", { name: "Download error report (CSV)" });
  await expect(downloadLink).toBeVisible();
  const detailHref = await detailLink.getAttribute("href");
  const downloadHref = await downloadLink.getAttribute("href");
  expect(detailHref).toMatch(/\/admin\/catalog\/import\/history\/.+/);
  expect(downloadHref).toMatch(/\/api\/admin\/import\/products\/.+\/errors/);

  // --- History list shows the just-completed job ---
  await page.goto("/admin/catalog/import/history");
  await expect(page.getByRole("link", { name: filename })).toBeVisible();

  // --- Detail page shows the real failure, actor, and status ---
  await page.goto(detailHref!);
  await expect(page.getByRole("heading", { name: filename })).toBeVisible();
  await expect(page.getByText("COMPLETED", { exact: true })).toBeVisible();
  await expect(page.getByText(dupSku)).toBeVisible();
  // The rendered table shows the human-readable message, not the internal
  // error code (that's in the CSV export instead — checked below).
  await expect(page.getByText("already appears on row", { exact: false })).toBeVisible();
  await expect(page.locator("dd", { hasText: MANAGER_EMAIL })).toBeVisible();

  // --- The downloaded CSV itself, fetched with the same authenticated
  // session (no second login) ---
  const download = await page.request.get(downloadHref!);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain("text/csv");
  expect(download.headers()["content-disposition"]).toContain("attachment");
  expect(download.headers()["cache-control"]).toContain("no-store");
  const body = await download.text();
  expect(body).toContain(dupSku);
  expect(body).toContain("duplicate_sku_in_file");
  expect(body.trim().split("\r\n")).toHaveLength(2); // header + exactly one failed row

  // --- A job with no failed rows shows that clearly, with no download link ---
  const cleanSlug = `${SLUG_PREFIX}-b`;
  const cleanFilename = `${FILE_PREFIX}-clean.csv`;
  await page.goto("/admin/catalog/import");
  await page.getByLabel("CSV or XLSX file").setInputFiles({
    name: cleanFilename,
    mimeType: "text/csv",
    buffer: csvBuffer([`E2EIMPHIST-${RUN_ID}-CLEAN,Clean Product,${cleanSlug},x,9.99,,,,,,,,`]),
  });
  await page.getByRole("button", { name: "Preview (dry-run)" }).click();
  await page.getByRole("button", { name: /Commit \d+ row\(s\)/ }).click();
  await expect(page.getByText(/Import completed: 1 created/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download error report (CSV)" })).toHaveCount(0);

  const cleanDetailHref = await page.getByRole("link", { name: "View details" }).getAttribute("href");
  await page.goto(cleanDetailHref!);
  await expect(page.getByText("No failed rows for this import.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download error report (CSV)" })).toHaveCount(0);

  // --- A missing job is a clean 404, not a crash ---
  const missing = await page.goto("/admin/catalog/import/history/does-not-exist");
  expect(missing?.status()).toBe(404);

  // --- Same login: a real .xlsx file through the same admin UI ---
  const xlsxSlug = `${SLUG_PREFIX}-xlsx`;
  const xlsxOkSku = `E2EIMPHIST-${RUN_ID}-XOK`;
  const xlsxBadSku = `E2EIMPHIST-${RUN_ID}-XBAD`;
  const xlsxFilename = `${FILE_PREFIX}.xlsx`;
  const xlsxFile = await xlsxBuffer([
    [xlsxOkSku, "E2E XLSX Product", xlsxSlug, 19.99],
    [xlsxBadSku, "E2E XLSX Product Bad Row", xlsxSlug, ""], // blank price -> row 3
  ]);

  await page.goto("/admin/catalog/import");
  await page
    .getByLabel("CSV or XLSX file")
    .setInputFiles({ name: xlsxFilename, mimeType: XLSX_MIME, buffer: xlsxFile });
  await page.getByRole("button", { name: "Preview (dry-run)" }).click();
  await expect(page.getByText("1 create")).toBeVisible();
  await expect(page.getByText("1 error")).toBeVisible();

  await page.getByRole("button", { name: /Commit \d+ row\(s\)/ }).click();
  await expect(page.getByText(/Import completed: 1 created/)).toBeVisible();

  const xlsxDetailLink = page.getByRole("link", { name: "View details" });
  const xlsxDownloadLink = page.getByRole("link", { name: "Download error report (CSV)" });
  await expect(xlsxDownloadLink).toBeVisible();
  const xlsxDetailHref = await xlsxDetailLink.getAttribute("href");
  const xlsxDownloadHref = await xlsxDownloadLink.getAttribute("href");

  // History list shows the XLSX job, with its format.
  await page.goto("/admin/catalog/import/history");
  await expect(page.getByRole("link", { name: xlsxFilename })).toBeVisible();
  const xlsxHistoryRow = page.locator("tr", { hasText: xlsxFilename });
  await expect(xlsxHistoryRow.getByText("XLSX", { exact: true })).toBeVisible();

  // Detail page: format, status, and the real failed row.
  await page.goto(xlsxDetailHref!);
  await expect(page.getByRole("heading", { name: xlsxFilename })).toBeVisible();
  await expect(page.getByText("XLSX", { exact: true })).toBeVisible();
  await expect(page.getByText("Price is required.", { exact: false })).toBeVisible();

  // The error-report CSV itself, same authenticated session.
  const xlsxDownload = await page.request.get(xlsxDownloadHref!);
  expect(xlsxDownload.status()).toBe(200);
  const xlsxBody = await xlsxDownload.text();
  expect(xlsxBody).toContain("price");
  expect(xlsxBody).toContain("required");
  expect(xlsxBody).toContain("Price is required.");

  // Documented worksheet rule: a second populated worksheet is refused,
  // not silently ignored.
  await page.goto("/admin/catalog/import");
  const multiSheetFilename = `${FILE_PREFIX}-multisheet.xlsx`;
  const multiSheetBuffer = await xlsxBuffer(
    [[`E2EIMPHIST-${RUN_ID}-XMS`, "X", `${SLUG_PREFIX}-xlsx-b`, 9.99]],
    { extraSheetWithData: true },
  );
  await page
    .getByLabel("CSV or XLSX file")
    .setInputFiles({ name: multiSheetFilename, mimeType: XLSX_MIME, buffer: multiSheetBuffer });
  await page.getByRole("button", { name: "Preview (dry-run)" }).click();
  await expect(page.getByText(/worksheets/i)).toBeVisible();

  // --- The real HTTP upload boundary rejects an oversized file ---
  // This drives the actual browser upload form (real cookies, real CSRF
  // token the app's own client code attaches), reaching the genuine
  // `IMPORT_MAX_FILE_SIZE_BYTES` check in
  // `src/app/api/admin/import/products/preview/route.ts` — the route's own
  // pre-check on `file.size`, which runs before any CSV/XLSX-specific
  // parsing and is identical for both formats. A CSV buffer is used here
  // (simpler to pad to an exact oversized byte count than a compressed
  // `.xlsx`); since the check fires on raw upload size before the route
  // ever branches on format, this is equally valid coverage for an
  // oversized XLSX upload hitting the same boundary. Default
  // `IMPORT_MAX_FILE_SIZE_BYTES` is 5,000,000 bytes (no override in this
  // e2e environment — confirmed via `src/server/config/env.ts` and the
  // absence of any env file setting it).
  await page.goto("/admin/catalog/import");
  const oversizedFilename = `${FILE_PREFIX}-oversized.csv`;
  const oversizedBuffer = Buffer.concat([
    Buffer.from("sku,product_name,product_slug,price\n", "utf-8"),
    Buffer.alloc(5_000_001, "A"),
  ]);
  await page.getByLabel("CSV or XLSX file").setInputFiles({
    name: oversizedFilename,
    mimeType: "text/csv",
    buffer: oversizedBuffer,
  });
  await page.getByRole("button", { name: "Preview (dry-run)" }).click();
  await expect(page.getByText(/exceeds the 5,000,000 byte limit/i)).toBeVisible();
});

test("unauthenticated access to import history and the error-report endpoint is denied, not silently allowed", async ({
  page,
  request,
}) => {
  await page.goto("/admin/catalog/import/history");
  await expect(page).toHaveURL(/\/login/);

  const response = await request.get("/api/admin/import/products/some-job-id/errors");
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});
