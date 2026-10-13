// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ResendApiError, sendViaResend } from "@/server/email/resend-client";

/**
 * Mocked-provider coverage for the raw-`fetch` Resend client — never a real
 * network call. Covers success, timeout, rejection, and the
 * retryable/non-retryable classification the outbox's own backoff depends
 * on (`email-outbox.ts`'s `resolveEmailJobFailure` doesn't branch on this
 * directly today, but a future caller reasonably could, so the
 * classification itself must be right and tested, not just the happy path).
 */

const INPUT = {
  apiKey: "re_test_key",
  from: "Taek Shops <noreply@example.test>",
  to: "customer@example.test",
  subject: "Test subject",
  html: "<p>hi</p>",
  text: "hi",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sendViaResend — success", () => {
  it("returns the provider's message id on 200, and sends the documented request shape", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.resend.com/emails");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
      expect(JSON.parse(init.body as string)).toMatchObject({
        from: INPUT.from,
        to: INPUT.to,
        subject: INPUT.subject,
        html: INPUT.html,
        text: INPUT.text,
      });
      return jsonResponse(200, { id: "msg_123" });
    });

    const result = await sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ id: "msg_123" });
  });

  it("sends the Idempotency-Key header when provided, and omits it when not", async () => {
    const withKey = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("job-abc");
      return jsonResponse(200, { id: "msg_1" });
    });
    await sendViaResend(
      { ...INPUT, idempotencyKey: "job-abc" },
      { fetchImpl: withKey as unknown as typeof fetch },
    );

    const withoutKey = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
      return jsonResponse(200, { id: "msg_2" });
    });
    await sendViaResend(INPUT, { fetchImpl: withoutKey as unknown as typeof fetch });
  });
});

describe("sendViaResend — rejection", () => {
  it("401 (invalid API key) is a non-retryable ResendApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: "Invalid API key" }));
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 401, retryable: false });
  });

  it("403 (unverified domain) is a non-retryable ResendApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { message: "domain not verified" }));
    const error = await sendViaResend(INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ResendApiError);
    expect(error.retryable).toBe(false);
  });

  it("422 (validation error) is a non-retryable ResendApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { message: "Missing required field" }));
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 422, retryable: false });
  });

  it("never includes the recipient address or email body in the thrown error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { message: "Missing required field" }));
    const error: ResendApiError = await sendViaResend(INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error.message).not.toContain(INPUT.to);
    expect(error.message).not.toContain(INPUT.html);
  });
});

describe("sendViaResend — retryable failures", () => {
  it("429 (rate limit) is a retryable ResendApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { message: "rate_limit_exceeded" }));
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it("500/503 (provider-side failure) is a retryable ResendApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { message: "service_unavailable" }));
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("a thrown network error is wrapped as a retryable ResendApiError with no HTTP status", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: null, retryable: true });
  });

  it("a timeout (AbortSignal firing) is a retryable ResendApiError with no HTTP status", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      // Simulate what a real timeout looks like: the fetch implementation
      // rejects with the same DOMException `AbortSignal.timeout` produces,
      // without this test needing to wait out a real timer.
      const reason = (init.signal as AbortSignal | undefined)?.reason;
      throw reason ?? new DOMException("The operation was aborted.", "TimeoutError");
    });
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1 }),
    ).rejects.toMatchObject({ status: null, retryable: true });
  });

  it("a 2xx response with no message id is a non-retryable ResendApiError, not a silent success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(
      sendViaResend(INPUT, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
