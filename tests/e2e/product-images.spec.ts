import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import { PrismaClient, UserRole } from "@prisma/client";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { hashPassword } from "@/server/auth/password";
import { loginAs } from "./helpers/login";

/**
 * Phase 9 product images — upload-to-storefront, against the dedicated e2e
 * server (localhost:3100 — see playwright.config.ts) and the isolated
 * `TEST_DATABASE_URL`. This process forces the LOCAL-filesystem storage
 * backend, pointed at its own dedicated, isolated directory
 * (`LOCAL_STORAGE_ROOT=.e2e-storage-objects`) — never real dev-local
 * storage, never real MinIO — so the single-step server-proxy upload path
 * is what's exercised here (`signedUpload` is null for this backend). The
 * S3-compatible presigned-upload path is covered by
 * `tests/integration/product-images.integration.test.ts`'s
 * `FakeObjectStorage`, which simulates a presigned URL; a real browser
 * can't usefully PUT to a fake URL, so that path isn't re-proven here.
 *
 * Self-contained: creates and tears down its own fixtures (a dedicated
 * MANAGER account + one ACTIVE product with a variant), independent of
 * `global-setup.ts` / other specs' fixtures.
 *
 * This file's one real login draws from the same shared, IP-keyed e2e login
 * rate-limit budget every spec file shares (`src/server/auth/rate-limit.ts`,
 * 10 attempts / 15 min — see `customer-order-history.spec.ts`'s comment for
 * the full explanation). Adding this file pushed the whole suite's total
 * over that budget; the fix landed in `admin-orders.spec.ts` (consolidating
 * three same-actor logins into one), not here and not in the limiter.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN_ID = randomBytes(4).toString("hex");
const MANAGER_EMAIL = `e2e-images-manager-${RUN_ID}@taek.local`;
const PASSWORD = "Images-Verify-2026!";
const PRODUCT_SLUG = `zzz-e2e-images-${RUN_ID}`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

// A genuinely decodable JPEG (real sharp/libvips) — `uploadProductImage`
// (the local-filesystem backend's single-step path) runs real image
// decoding, not just magic-byte sniffing, so the upload must survive an
// actual decode to prove the real, end-to-end validation path, not just the
// header check.
let VALID_JPEG_BYTES: Buffer;

let productId: string;

test.beforeAll(async () => {
  VALID_JPEG_BYTES = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer();

  const passwordHash = await hashPassword(PASSWORD);
  await db.user.create({
    data: {
      email: MANAGER_EMAIL,
      role: UserRole.MANAGER,
      status: "ACTIVE",
      firstName: "E2E",
      lastName: "Images Manager",
      emailVerifiedAt: new Date(),
      passwordHash,
    },
  });

  const product = await db.product.create({
    data: {
      name: "E2E Image Test Product",
      slug: PRODUCT_SLUG,
      status: "ACTIVE",
      active: true,
      variants: {
        create: {
          sku: `E2E-IMG-SKU-${RUN_ID}`,
          priceCents: 2999,
          optionSignature: "",
          active: true,
        },
      },
    },
    select: { id: true },
  });
  productId = product.id;
});

test.afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityType: "Product", entityId: productId } });
  await db.product.deleteMany({ where: { slug: PRODUCT_SLUG } });
  await db.user.deleteMany({ where: { email: MANAGER_EMAIL } });
  await db.$disconnect();
});

test("a MANAGER uploads a product image through the admin UI and it renders on the storefront", async ({
  page,
}) => {
  await loginAs(page, MANAGER_EMAIL, PASSWORD);

  await page.goto(`/admin/catalog/products/${productId}`);
  await expect(page.getByRole("heading", { name: "E2E Image Test Product" })).toBeVisible();
  await expect(page.getByText("No images yet.")).toBeVisible();

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "test-image.jpg",
    mimeType: "image/jpeg",
    buffer: VALID_JPEG_BYTES,
  });

  // The upload → validate → attach round trip completes and the page
  // reflects the real, persisted state (not just optimistic UI).
  await expect(page.getByText("primary")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No images yet.")).not.toBeVisible();

  await page.reload();
  await expect(page.getByText("primary")).toBeVisible();

  const imageRow = await db.productImage.findFirstOrThrow({ where: { productId } });
  expect(imageRow.isPrimary).toBe(true);
  expect(imageRow.url.startsWith("storage:")).toBe(true);

  // Storefront: the uploaded image renders where a shopper would see it,
  // never a broken image / the "No image" fallback.
  await page.goto(`/products/${PRODUCT_SLUG}`);
  const storefrontImage = page.locator("img").first();
  await expect(storefrontImage).toBeVisible();
  await expect(page.getByText("No image")).not.toBeVisible();
});
