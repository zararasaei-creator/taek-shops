/**
 * Restore verification: compares a SOURCE database with a RESTORED copy of it, and then
 * reads the restored copy through the application's own Prisma client and services.
 * An archive that merely lists is not proof of restoration — this is.
 *
 *   SOURCE_DATABASE_URL=… RESTORED_DATABASE_URL=… tsx scripts/db/verify-restore.ts
 *
 * Both URLs come from the environment (never printed). Read-only on both databases.
 * Exit 0 only if every check passes; 1 otherwise.
 *
 * Checks, all against the real data:
 *  1. every public table exists in both with identical row counts;
 *  2. a content fingerprint of EVERY table (md5 over each row's full text) is identical;
 *  3. schema parity: index, constraint and enum-type counts;
 *  4. referential integrity of the restored copy: no orphaned single-column foreign key;
 *  5. business invariants on the restored copy: order totals reconcile
 *     (subtotal − discount + shipping + tax = total), financial sums and per-item
 *     inventory quantities equal the source, ledger counters reconcile (the app's own
 *     `reconcileAllInventory`);
 *  6. the restored data is readable through the application's services (customer order
 *     history, admin order detail), returning the same figures as the source.
 */
import { PrismaClient } from "@prisma/client";

import { reconcileAllInventory } from "@/server/inventory/invariant";
import { getOrderDetail } from "@/server/orders/order-management-service";
import { getMyOrderDetail, listMyOrders } from "@/server/orders/order-queries";

type Row = Record<string, unknown>;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function client(envName: string): PrismaClient {
  const url = process.env[envName];
  if (!url) throw new Error(`${envName} is required`);
  return new PrismaClient({ datasourceUrl: url, log: ["error"] });
}

const q = <T extends Row = Row>(db: PrismaClient, sql: string) => db.$queryRawUnsafe<T[]>(sql);
const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function tables(db: PrismaClient): Promise<string[]> {
  const rows = await q<{ table_name: string }>(
    db,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function main(): Promise<void> {
  const src = client("SOURCE_DATABASE_URL");
  const dst = client("RESTORED_DATABASE_URL");
  try {
    // 1 + 2. Tables, row counts, content fingerprints.
    const srcTables = await tables(src);
    const dstTables = await tables(dst);
    check("same set of tables", JSON.stringify(srcTables) === JSON.stringify(dstTables), `${srcTables.length} tables`);

    let totalRows = 0;
    const countMismatch: string[] = [];
    const fingerprintMismatch: string[] = [];
    for (const t of srcTables) {
      const sel = `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS fp FROM ${quote(t)} x`;
      const [a] = await q<{ n: number; fp: string }>(src, sel);
      const [b] = await q<{ n: number; fp: string }>(dst, sel);
      totalRows += a!.n;
      if (a!.n !== b!.n) countMismatch.push(`${t} ${a!.n}≠${b!.n}`);
      if (a!.fp !== b!.fp) fingerprintMismatch.push(t);
    }
    check("row counts equal in every table", countMismatch.length === 0, countMismatch.join("; ") || `${totalRows} rows in total`);
    check("content fingerprint (every row's full text) equal in every table", fingerprintMismatch.length === 0, fingerprintMismatch.join(", ") || "identical");

    // 3. Schema parity.
    const schemaSql = `SELECT
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
      (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public') AS constraints,
      (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e') AS enums`;
    const [sa] = await q(src, schemaSql);
    const [sb] = await q(dst, schemaSql);
    check("schema parity (indexes / constraints / enum types)", JSON.stringify(sa) === JSON.stringify(sb), JSON.stringify(sb));

    // 4. Foreign-key integrity on the restored copy (single-column FKs; composite ones are counted).
    const fks = await q<{ child_t: string; child_c: string; parent_t: string; parent_c: string }>(
      dst,
      `SELECT kcu.table_name AS child_t, kcu.column_name AS child_c, ccu.table_name AS parent_t, ccu.column_name AS parent_c
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
         AND tc.constraint_name IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_schema = 'public' GROUP BY constraint_name HAVING count(*) = 1)`,
    );
    const orphans: string[] = [];
    for (const fk of fks) {
      const [r] = await q<{ n: number }>(
        dst,
        `SELECT count(*)::int AS n FROM ${quote(fk.child_t)} c LEFT JOIN ${quote(fk.parent_t)} p ON p.${quote(fk.parent_c)} = c.${quote(fk.child_c)} WHERE c.${quote(fk.child_c)} IS NOT NULL AND p.${quote(fk.parent_c)} IS NULL`,
      );
      if (r!.n > 0) orphans.push(`${fk.child_t}.${fk.child_c}→${fk.parent_t} (${r!.n})`);
    }
    check("no orphaned foreign keys in the restored copy", orphans.length === 0, orphans.join("; ") || `${fks.length} foreign keys checked`);

    // 5. Business invariants and financial / inventory equality.
    const [recon] = await q<{ bad: number; n: number }>(
      dst,
      `SELECT count(*) FILTER (WHERE "subtotalCents" - "discountCents" + "shippingCents" + "taxCents" <> "totalCents")::int AS bad, count(*)::int AS n FROM "Order"`,
    );
    check("every restored order's totals reconcile (subtotal − discount + shipping + tax = total)", recon!.bad === 0 && recon!.n > 0, `${recon!.n} orders`);

    const money = (db: PrismaClient) =>
      q(
        db,
        `SELECT (SELECT coalesce(sum("totalCents"),0)::bigint FROM "Order") AS order_total,
                (SELECT coalesce(sum("taxCents"),0)::bigint FROM "Order") AS order_tax,
                (SELECT coalesce(sum("shippingCents"),0)::bigint FROM "Order") AS order_shipping,
                (SELECT coalesce(sum("lineTotalCents"),0)::bigint FROM "OrderItem") AS item_total,
                (SELECT coalesce(sum("amountCents"),0)::bigint FROM "Payment") AS payment_total,
                (SELECT coalesce(sum("amountCents"),0)::bigint FROM "Refund") AS refund_total,
                (SELECT count(*)::int FROM "Order" o WHERE o."paymentStatus" = 'PAID') AS paid_orders`,
      ).then((r) => JSON.parse(JSON.stringify(r[0], (_k, v) => (typeof v === "bigint" ? Number(v) : v))));
    const ma = await money(src);
    const mb = await money(dst);
    check("financial totals equal (orders, tax, shipping, items, payments, refunds, paid count)", JSON.stringify(ma) === JSON.stringify(mb), JSON.stringify(mb));

    const inv = (db: PrismaClient) =>
      q(db, `SELECT v."sku", i."quantityOnHand", i."quantityReserved" FROM "InventoryItem" i JOIN "ProductVariant" v ON v.id = i."variantId" ORDER BY v."sku"`);
    const ia = await inv(src);
    const ib = await inv(dst);
    check("per-SKU inventory (on hand / reserved) equal", ia.length > 0 && JSON.stringify(ia) === JSON.stringify(ib), `${ib.length} SKUs: ${ib.map((r) => `${r.quantityOnHand}/${r.quantityReserved}`).join(" ")}`);

    // 6. Through the application's Prisma client and services.
    const health = await reconcileAllInventory(dst);
    const healthSrc = await reconcileAllInventory(src);
    check("app inventory reconciliation (ledger vs counters) ok on the restored copy", health.ok && health.itemsChecked === healthSrc.itemsChecked, `${health.itemsChecked} items`);

    const alice = await dst.user.findUniqueOrThrow({ where: { email: "alice@drill.example.test" } });
    const aliceSrc = await src.user.findUniqueOrThrow({ where: { email: "alice@drill.example.test" } });
    const mine = await listMyOrders(alice as never, {}, dst);
    const mineSrc = await listMyOrders(aliceSrc as never, {}, src);
    check(
      "customer order history readable via the app (listMyOrders) with the same figures",
      mine.total > 0 && JSON.stringify(mine.orders.map((o) => [o.orderNumber, o.totalCents])) === JSON.stringify(mineSrc.orders.map((o) => [o.orderNumber, o.totalCents])),
      `${mine.total} order(s) for the customer`,
    );
    const detail = await getMyOrderDetail(alice as never, mine.orders[0]!.orderNumber, dst);
    check("order detail readable via the app (items present)", detail.items.length > 0, `${detail.items.length} line(s)`);

    const manager = await dst.user.findUniqueOrThrow({ where: { email: "manager@drill.example.test" } });
    const anyOrder = await dst.order.findFirstOrThrow({ where: { payments: { some: {} } }, select: { id: true } }).catch(() => null);
    if (anyOrder) {
      const d = await getOrderDetail(manager as never, anyOrder.id, dst);
      check("admin order detail readable via the app (order + payment)", Boolean(d), "ok");
    }
  } finally {
    await src.$disconnect();
    await dst.$disconnect();
  }

  console.info(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("[verify-restore] failed:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
