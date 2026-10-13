import type { OrderEmailMessage, OrderMailer } from "@/server/notifications";

/**
 * A controlled `OrderMailer` for integration tests — never writes a real
 * preview file, never touches the network. Scriptable per-call outcome
 * (default: succeeds), and records every call (order number + type + the
 * idempotency key it received — never the recipient/subject/body) so tests
 * can assert on call count, ordering, and idempotency-key stability across
 * retries without depending on real wall-clock delivery.
 */
export class FakeOrderMailer implements OrderMailer {
  readonly calls: { orderNumber: string; type: string; idempotencyKey: string }[] = [];
  private failNext = 0;
  private failNextError: Error = new Error("fake transport failure");

  /** The next N `send` calls throw `error` (default: a generic failure), then it succeeds again. */
  scriptFailures(count: number, error?: Error): void {
    this.failNext = count;
    if (error) this.failNextError = error;
  }

  async send(message: OrderEmailMessage): Promise<void> {
    this.calls.push({
      orderNumber: message.orderNumber,
      type: message.type,
      idempotencyKey: message.idempotencyKey,
    });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw this.failNextError;
    }
  }
}
