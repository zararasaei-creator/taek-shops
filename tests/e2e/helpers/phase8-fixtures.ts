import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 8 admin-order fixture identifiers, shared between
 * `global-setup.ts` (runs once, in Playwright's main process) and
 * `admin-orders.spec.ts` (runs in a separate worker process).
 *
 * A run id generated independently in each process would NOT match —
 * `randomBytes()` at module top-level re-executes per process, so the spec
 * would derive different emails/order numbers than what setup actually
 * wrote to the database (this is exactly what happened before this file
 * existed: every login failed with "unknown user"). The id is generated
 * once by setup and written to a temp file; the spec reads the same file.
 */

const RUN_ID_FILE = join(tmpdir(), "taek-shops-e2e-phase8-run-id.json");

export function generateAndPersistRunId(): string {
  const id = randomBytes(4).toString("hex");
  writeFileSync(RUN_ID_FILE, JSON.stringify({ id }));
  return id;
}

export function readPersistedRunId(): string {
  const raw = readFileSync(RUN_ID_FILE, "utf8");
  const { id } = JSON.parse(raw) as { id: string };
  return id;
}

export function removePersistedRunId(): void {
  try {
    rmSync(RUN_ID_FILE);
  } catch {
    // Already gone — fine.
  }
}

export const PHASE8_PASSWORD = "Phase8-Verify-2026!";

export function phase8Emails(runId: string) {
  return {
    customer: `e2e-phase8-customer-${runId}@taek.local`,
    staff: `e2e-phase8-staff-${runId}@taek.local`,
    manager: `e2e-phase8-manager-${runId}@taek.local`,
  } as const;
}

/** A dedicated MANAGER account for `auth-session.spec.ts` — not shared with
 * the Phase 8 order-management fixtures, so the two specs stay decoupled. */
export function authSessionEmail(runId: string): string {
  return `e2e-auth-session-${runId}@taek.local`;
}

export function phase8Orders(runId: string) {
  return {
    confirmed: {
      orderNumber: `E2E-PF8-${runId}-CONFIRMED`,
      email: `e2e-phase8-buyer-a-${runId}@taek.local`,
      totalCents: 4500,
    },
    pending: {
      orderNumber: `E2E-PF8-${runId}-PENDING`,
      email: `e2e-phase8-buyer-b-${runId}@taek.local`,
      totalCents: 2000,
    },
    completed: {
      orderNumber: `E2E-PF8-${runId}-COMPLETED`,
      email: `e2e-phase8-buyer-c-${runId}@taek.local`,
      totalCents: 9900,
    },
  } as const;
}
