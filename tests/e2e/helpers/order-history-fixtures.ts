/**
 * Customer order-history ("My orders") e2e fixture identifiers — same
 * cross-process-run-id pattern as `phase8-fixtures.ts` (see that file's
 * comment for why these must be functions of a shared, file-persisted run id
 * rather than module-level randomness).
 */

export const ORDER_HISTORY_PASSWORD = "History-Verify-2026!";

export function orderHistoryEmails(runId: string) {
  return {
    customerA: `e2e-history-a-${runId}@taek.local`,
    customerB: `e2e-history-b-${runId}@taek.local`,
    customerEmpty: `e2e-history-empty-${runId}@taek.local`,
  } as const;
}

export function orderHistoryOrders(runId: string) {
  return {
    ownedByA: { orderNumber: `E2E-HIST-${runId}-A`, totalCents: 3300 },
    ownedByB: { orderNumber: `E2E-HIST-${runId}-B`, totalCents: 4400 },
  } as const;
}
