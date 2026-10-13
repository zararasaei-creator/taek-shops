import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "./helpers/db";
import { cleanupOwnedWebhookEvents } from "./helpers/payments";

/**
 * Regression coverage for the fixed `WebhookEvent` cleanup defect:
 * `payments.integration.test.ts` used to run `db.webhookEvent.deleteMany({})`
 * in its `afterAll`, which erased every `WebhookEvent` row in the database —
 * including ones belonging to real, unrelated application traffic. The fix
 * extracted the cleanup into `cleanupOwnedWebhookEvents` (helpers/payments.ts)
 * and this test calls that SAME function — not a re-implemented copy of its
 * logic — so it exercises the real code path `payments.integration.test.ts`
 * relies on.
 */
describe("webhook-event cleanup scoping", () => {
  beforeAll(async () => {
    // Prove the client this test uses — the application's own shared `db` /
    // `prisma` singleton, imported the same way every service under test
    // imports it — is actually connected to the isolated test database, not
    // the application's. `helpers/setup.ts` already enforces this before any
    // module loads; this independently confirms the routing took effect for
    // this exact client.
    const rows = await db.$queryRawUnsafe<{ current_database: string }[]>(
      "SELECT current_database()",
    );
    const liveDatabaseName = rows[0]?.current_database;
    expect(liveDatabaseName).toBeTruthy();
    expect(liveDatabaseName).not.toBe("taek_shops");
  });

  it("removes only owned event ids, leaves an unrelated event untouched, and an empty set deletes nothing", async () => {
    // An "unrelated" event standing in for real application/webhook traffic
    // that a naive unscoped delete would previously have erased.
    const unrelatedEventId = `evt_unrelated_${randomUUID()}`;

    try {
      await db.webhookEvent.create({
        data: {
          eventId: unrelatedEventId,
          type: "payment_intent.succeeded",
          processedAt: new Date(),
        },
      });

      // Two events "owned" by this simulated test run.
      const ownedEventIds = new Set<string>([
        `evt_test_${randomUUID()}`,
        `evt_test_${randomUUID()}`,
      ]);
      for (const eventId of ownedEventIds) {
        await db.webhookEvent.create({
          data: { eventId, type: "payment_intent.succeeded", processedAt: new Date() },
        });
      }

      // 1. Empty ownership tracking deletes nothing.
      await cleanupOwnedWebhookEvents(db, new Set());
      expect(await db.webhookEvent.count({ where: { eventId: unrelatedEventId } })).toBe(1);
      for (const eventId of ownedEventIds) {
        expect(await db.webhookEvent.count({ where: { eventId } })).toBe(1);
      }

      // 2. The real cleanup function: delete only the exact ids this run owns.
      await cleanupOwnedWebhookEvents(db, ownedEventIds);

      // 3. Owned events are gone; the unrelated event survives untouched.
      for (const eventId of ownedEventIds) {
        expect(await db.webhookEvent.count({ where: { eventId } })).toBe(0);
      }
      expect(await db.webhookEvent.count({ where: { eventId: unrelatedEventId } })).toBe(1);
    } finally {
      // Remove the regression fixture itself, by its exact id — never a
      // prefix or a blanket delete.
      await cleanupOwnedWebhookEvents(db, [unrelatedEventId]);
    }
  });
});
