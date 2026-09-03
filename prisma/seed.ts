/**
 * Development seed — safe, synthetic configuration only.
 *
 * Seeds: category tree, one brand, one demo product with Size/Colour options and
 * four variants (each with an inventory record + opening stock movement), an
 * example Ontario tax region/rate, and an example shipping zone/method.
 *
 * Optionally seeds ONE administrator account, but only when both
 * SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are present in the environment. The
 * password is read from the environment, hashed with Argon2id, and never logged.
 *
 * Contains NO real or fake customers and NO secrets in source. Idempotent: every
 * write is an upsert keyed on a unique column, so it is safe to run repeatedly.
 *
 * Run with:  npx prisma db seed
 */
import { hash as argon2Hash } from "@node-rs/argon2";
import { PrismaClient, StockMovementType } from "@prisma/client";

const prisma = new PrismaClient();

// Mirrors src/server/auth/config.ts ARGON2_OPTIONS (OWASP defaults). Seed cannot
// import the `@/` alias, so the values are repeated here intentionally.
// `@node-rs/argon2` defaults the algorithm to Argon2id.
const SEED_ARGON = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

async function seedCategories() {
  const roots = [
    { name: "Uniforms", slug: "uniforms", sortOrder: 1 },
    { name: "Protective Gear", slug: "protective-gear", sortOrder: 2 },
    { name: "Training Equipment", slug: "training-equipment", sortOrder: 3 },
    { name: "Accessories", slug: "accessories", sortOrder: 4 },
  ];

  const created = new Map<string, string>();
  for (const category of roots) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name, sortOrder: category.sortOrder, active: true },
      create: category,
    });
    created.set(row.slug, row.id);
  }

  // One sample sub-category to exercise the self-relation.
  await prisma.category.upsert({
    where: { slug: "student-uniforms" },
    update: { name: "Student Uniforms", parentId: created.get("uniforms"), sortOrder: 1 },
    create: {
      name: "Student Uniforms",
      slug: "student-uniforms",
      parentId: created.get("uniforms"),
      sortOrder: 1,
    },
  });

  return created;
}

async function seedTax() {
  const region = await prisma.taxRegion.upsert({
    where: { country_province: { country: "CA", province: "ON" } },
    update: { name: "Ontario", active: true },
    create: { name: "Ontario", country: "CA", province: "ON" },
  });

  // Example rate only — operator-editable. 13% HST expressed as an exact fraction.
  await prisma.taxRate.upsert({
    where: { regionId_name_taxCategory: { regionId: region.id, name: "HST", taxCategory: "" } },
    update: { rate: "0.130000", active: true },
    create: { regionId: region.id, name: "HST", taxCategory: "", rate: "0.130000" },
  });
}

async function seedShipping() {
  const zone = await prisma.shippingZone.upsert({
    where: { name: "Canada" },
    update: { active: true },
    create: { name: "Canada" },
  });

  await prisma.shippingZoneRegion.upsert({
    where: { zoneId_country_province: { zoneId: zone.id, country: "CA", province: "" } },
    update: {},
    create: { zoneId: zone.id, country: "CA", province: "" },
  });

  await prisma.shippingMethod.upsert({
    where: { zoneId_name: { zoneId: zone.id, name: "Standard" } },
    update: {
      flatRateCents: 1200,
      freeShippingThresholdCents: 15000,
      minDeliveryDays: 3,
      maxDeliveryDays: 7,
      active: true,
    },
    create: {
      zoneId: zone.id,
      name: "Standard",
      description: "Example flat-rate ground shipping",
      flatRateCents: 1200,
      freeShippingThresholdCents: 15000,
      minDeliveryDays: 3,
      maxDeliveryDays: 7,
    },
  });
}

async function seedDemoProduct(categoryIds: Map<string, string>) {
  const brand = await prisma.brand.upsert({
    where: { slug: "taek-basics" },
    update: { name: "Taek Basics", active: true },
    create: { name: "Taek Basics", slug: "taek-basics", description: "House brand (sample data)" },
  });

  const product = await prisma.product.upsert({
    where: { slug: "student-taekwondo-uniform" },
    update: {
      name: "Student Taekwondo Uniform",
      categoryId: categoryIds.get("uniforms"),
      brandId: brand.id,
    },
    create: {
      name: "Student Taekwondo Uniform",
      slug: "student-taekwondo-uniform",
      description: "Lightweight poly-cotton dobok for beginners. Sample seed data.",
      status: "ACTIVE",
      active: true,
      taxCategory: "standard",
      categoryId: categoryIds.get("uniforms"),
      brandId: brand.id,
    },
  });

  const optionSpecs = [
    { name: "Size", values: ["140", "160"] },
    { name: "Colour", values: ["White", "Black"] },
  ];

  const optionValueIds = new Map<string, string>(); // `${option}:${value}` -> id
  const optionIdByName = new Map<string, string>();

  for (const [optionIndex, spec] of optionSpecs.entries()) {
    const option = await prisma.productOption.upsert({
      where: { productId_name: { productId: product.id, name: spec.name } },
      update: { position: optionIndex },
      create: { productId: product.id, name: spec.name, position: optionIndex },
    });
    optionIdByName.set(spec.name, option.id);

    for (const [valueIndex, value] of spec.values.entries()) {
      const optionValue = await prisma.productOptionValue.upsert({
        where: { optionId_value: { optionId: option.id, value } },
        update: { position: valueIndex },
        create: { optionId: option.id, value, position: valueIndex },
      });
      optionValueIds.set(`${spec.name}:${value}`, optionValue.id);
    }
  }

  const variantSpecs = [
    { size: "140", colour: "White", sku: "UNI-STU-WHT-140", priceCents: 3999, stock: 25 },
    { size: "160", colour: "White", sku: "UNI-STU-WHT-160", priceCents: 4299, stock: 18 },
    { size: "140", colour: "Black", sku: "UNI-STU-BLK-140", priceCents: 4199, stock: 12 },
    { size: "160", colour: "Black", sku: "UNI-STU-BLK-160", priceCents: 4499, stock: 9 },
  ];

  for (const [index, spec] of variantSpecs.entries()) {
    const sizeValueId = optionValueIds.get(`Size:${spec.size}`)!;
    const colourValueId = optionValueIds.get(`Colour:${spec.colour}`)!;
    // Mirrors src/server/catalog/option-signature.ts (seed cannot import the `@/`
    // alias). Required so `@@unique([productId, optionSignature])` distinguishes
    // the four variants instead of collapsing them onto the column default "".
    const signature = [...new Set([sizeValueId, colourValueId])].sort().join("|");

    const variant = await prisma.productVariant.upsert({
      where: { sku: spec.sku },
      update: { priceCents: spec.priceCents, active: true, optionSignature: signature },
      create: {
        productId: product.id,
        sku: spec.sku,
        name: `${spec.colour} / ${spec.size} cm`,
        position: index,
        priceCents: spec.priceCents,
        compareAtPriceCents: spec.priceCents + 1000,
        currency: "CAD",
        weightGrams: 650,
        optionSignature: signature,
      },
    });

    for (const [optionName, value] of [
      ["Size", spec.size],
      ["Colour", spec.colour],
    ] as const) {
      const optionId = optionIdByName.get(optionName)!;
      const optionValueId = optionValueIds.get(`${optionName}:${value}`)!;
      await prisma.productVariantOptionValue.upsert({
        where: { variantId_optionValueId: { variantId: variant.id, optionValueId } },
        update: {},
        create: { variantId: variant.id, optionId, optionValueId },
      });
    }

    const inventory = await prisma.inventoryItem.upsert({
      where: { variantId: variant.id },
      update: { reorderLevel: 5 },
      create: {
        variantId: variant.id,
        quantityOnHand: spec.stock,
        quantityReserved: 0,
        reorderLevel: 5,
        reorderQuantity: 20,
      },
    });

    // Opening balance movement — only once per inventory item.
    const existingInitial = await prisma.stockMovement.findFirst({
      where: { inventoryItemId: inventory.id, type: StockMovementType.INITIAL },
    });
    if (!existingInitial) {
      await prisma.stockMovement.create({
        data: {
          inventoryItemId: inventory.id,
          variantId: variant.id,
          type: StockMovementType.INITIAL,
          quantityDelta: spec.stock,
          reason: "Seed opening balance",
        },
      });
    }
  }

  return product.id;
}

/**
 * Optional single administrator. Development/demo mechanism only:
 * - runs solely when SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are both set;
 * - the password never appears in source or logs;
 * - idempotent: re-running keeps role/status ACTIVE/ADMIN and does NOT rotate
 *   the password unless SEED_ADMIN_FORCE_PASSWORD=true.
 */
async function seedAdminUser(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.info("[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping admin user.");
    return;
  }
  if (password.length < 10) {
    console.warn("[seed] SEED_ADMIN_PASSWORD is below the 10-character policy minimum — skipping.");
    return;
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });
  const force = process.env.SEED_ADMIN_FORCE_PASSWORD === "true";
  const shouldSetPassword = !existing || !existing.passwordHash || force;
  const passwordHash = shouldSetPassword ? await argon2Hash(password, SEED_ARGON) : undefined;

  await prisma.user.upsert({
    where: { email },
    update: {
      role: "ADMIN",
      status: "ACTIVE",
      ...(passwordHash ? { passwordHash } : {}),
    },
    create: {
      email,
      role: "ADMIN",
      status: "ACTIVE",
      firstName: "Seed",
      lastName: "Admin",
      emailVerifiedAt: new Date(),
      passwordHash: passwordHash ?? (await argon2Hash(password, SEED_ARGON)),
    },
  });

  console.info(
    "[seed] admin user ensured: %s (role=ADMIN, password %s)",
    email,
    shouldSetPassword ? "set from env" : "left unchanged",
  );
}

async function main() {
  const categoryIds = await seedCategories();
  await seedTax();
  await seedShipping();
  const productId = await seedDemoProduct(categoryIds);
  await seedAdminUser();

  const [categories, products, variants, inventory, users] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.productVariant.count(),
    prisma.inventoryItem.count(),
    prisma.user.count(),
  ]);

  console.log(
    `Seed complete: ${categories} categories, ${products} product(s) ` +
      `(demo=${productId}), ${variants} variants, ${inventory} inventory items, ${users} user(s).`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error("Seed failed:", error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
