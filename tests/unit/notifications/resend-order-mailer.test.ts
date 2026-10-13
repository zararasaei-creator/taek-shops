// @vitest-environment node
import { OrderEmailType } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `ResendOrderMailer` is a thin wrapper — the HTTP/retry/timeout mechanics
 * it delegates to are already thoroughly covered in `tests/unit/resend-client.test.ts`.
 * This file only proves the wrapper itself: it passes the right fields
 * through (including the job's own idempotency key), and on failure it
 * logs safely (never the recipient or body) and re-throws so the outbox's
 * own retry/backoff still runs.
 */

vi.mock("@/server/email/resend-client", async () => {
  const actual = await vi.importActual<typeof import("@/server/email/resend-client")>(
    "@/server/email/resend-client",
  );
  return { ...actual, sendViaResend: vi.fn() };
});

const MESSAGE = {
  to: "customer@example.test",
  subject: "Your order is confirmed",
  html: "<p>Thanks for your order</p>",
  text: "Thanks for your order",
  idempotencyKey: "order-email-job-1",
  orderNumber: "ORD-1001",
  type: OrderEmailType.ORDER_CONFIRMATION,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ResendOrderMailer", () => {
  it("passes the message fields and the job's idempotency key through to sendViaResend", async () => {
    const { sendViaResend } = await import("@/server/email/resend-client");
    vi.mocked(sendViaResend).mockResolvedValue({ id: "msg_1" });

    const { ResendOrderMailer } = await import("@/server/notifications/order-mailer");
    const mailer = new ResendOrderMailer("re_key", "Taek Shops <noreply@example.test>");
    await mailer.send(MESSAGE);

    expect(sendViaResend).toHaveBeenCalledWith({
      apiKey: "re_key",
      from: "Taek Shops <noreply@example.test>",
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
      idempotencyKey: MESSAGE.idempotencyKey,
    });
  });

  it("re-throws on failure (so the outbox's own retry/backoff still applies) and never logs the recipient or body", async () => {
    const { sendViaResend, ResendApiError } = await import("@/server/email/resend-client");
    vi.mocked(sendViaResend).mockRejectedValue(
      new ResendApiError("Resend API returned 429: rate_limit_exceeded", 429, true),
    );
    // Failures are logged through the shared structured logger (JSON lines), not console.error.
    const { __setLogSink } = await import("@/server/observability/logger");
    const lines: string[] = [];
    __setLogSink((_level, line) => lines.push(line));

    const { ResendOrderMailer } = await import("@/server/notifications/order-mailer");
    const mailer = new ResendOrderMailer("re_key", "Taek Shops <noreply@example.test>");

    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(ResendApiError);
    __setLogSink(null);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "order_email.send_failed",
      level: "error",
      orderNumber: MESSAGE.orderNumber,
      providerStatus: 429,
      retryable: true,
      errorCategory: "unexpected",
    });
    const loggedArgs = lines.join(" | ");
    expect(loggedArgs).not.toContain("rate_limit_exceeded"); // the provider's response text is not logged either
    expect(loggedArgs).not.toContain(MESSAGE.to);
    expect(loggedArgs).not.toContain(MESSAGE.html);
    expect(loggedArgs).not.toContain(MESSAGE.text);
  });
});

describe("getOrderMailer() — resolves to the right implementation per EMAIL_TRANSPORT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves to ResendOrderMailer when EMAIL_TRANSPORT=resend with credentials, outside a test run", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    vi.resetModules();

    const { getOrderMailer, ResendOrderMailer } = await import("@/server/notifications/order-mailer");
    expect(getOrderMailer()).toBeInstanceOf(ResendOrderMailer);
  });

  it("resolves to LocalPreviewOrderMailer when EMAIL_TRANSPORT is unset outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "");
    vi.resetModules();

    const { getOrderMailer, LocalPreviewOrderMailer } = await import(
      "@/server/notifications/order-mailer"
    );
    expect(getOrderMailer()).toBeInstanceOf(LocalPreviewOrderMailer);
  });

  it("__setOrderMailer overrides the resolved singleton (the integration-suite safety seam)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    vi.resetModules();

    const { getOrderMailer, __setOrderMailer, LocalPreviewOrderMailer } = await import(
      "@/server/notifications/order-mailer"
    );
    __setOrderMailer(new LocalPreviewOrderMailer());
    expect(getOrderMailer()).toBeInstanceOf(LocalPreviewOrderMailer); // never resolves "resend" once overridden
  });
});
