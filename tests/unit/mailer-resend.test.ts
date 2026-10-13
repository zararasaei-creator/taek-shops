// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `ResendMailer` (auth: password reset, email verification) — like
 * `ResendOrderMailer`, a thin wrapper; the HTTP/retry/timeout mechanics are
 * already covered in `tests/unit/resend-client.test.ts`. This proves the
 * wrapper renders the right template and content into the request, and
 * never logs the token, the full recipient, or the body on failure.
 */

vi.mock("@/server/email/resend-client", async () => {
  const actual = await vi.importActual<typeof import("@/server/email/resend-client")>(
    "@/server/email/resend-client",
  );
  return { ...actual, sendViaResend: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ResendMailer — sendPasswordReset", () => {
  it("renders the reset link with the raw token and sends it via Resend", async () => {
    const { sendViaResend } = await import("@/server/email/resend-client");
    vi.mocked(sendViaResend).mockResolvedValue({ id: "msg_1" });

    const { ResendMailer } = await import("@/server/auth/mailer");
    const mailer = new ResendMailer("re_key", "Taek Shops <noreply@example.test>");
    await mailer.sendPasswordReset({ to: "customer@example.test", token: "the-raw-token" });

    expect(sendViaResend).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendViaResend).mock.calls[0]![0];
    expect(call.apiKey).toBe("re_key");
    expect(call.from).toBe("Taek Shops <noreply@example.test>");
    expect(call.to).toBe("customer@example.test");
    expect(call.html).toContain("the-raw-token");
    expect(call.text).toContain("the-raw-token");
    expect(call.subject.toLowerCase()).toContain("reset");
  });

  it("re-throws on failure and never logs the token, the full recipient, or the body", async () => {
    const { sendViaResend, ResendApiError } = await import("@/server/email/resend-client");
    vi.mocked(sendViaResend).mockRejectedValue(
      new ResendApiError("Resend API returned 403: domain not verified", 403, false),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { ResendMailer } = await import("@/server/auth/mailer");
    const mailer = new ResendMailer("re_key", "Taek Shops <noreply@example.test>");

    await expect(
      mailer.sendPasswordReset({ to: "customer@example.test", token: "super-secret-token" }),
    ).rejects.toBeInstanceOf(ResendApiError);

    const loggedArgs = consoleError.mock.calls.flat().map(String).join(" | ");
    expect(loggedArgs).not.toContain("super-secret-token");
    expect(loggedArgs).not.toContain("customer@example.test");
  });
});

describe("getMailer() — resolves to the right implementation per EMAIL_TRANSPORT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves to ResendMailer when EMAIL_TRANSPORT=resend with credentials, outside a test run", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    vi.resetModules();

    const { getMailer, ResendMailer } = await import("@/server/auth/mailer");
    expect(getMailer()).toBeInstanceOf(ResendMailer);
  });

  it("resolves to LocalPreviewMailer when EMAIL_TRANSPORT is unset outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "");
    vi.resetModules();

    const { getMailer, LocalPreviewMailer } = await import("@/server/auth/mailer");
    expect(getMailer()).toBeInstanceOf(LocalPreviewMailer);
  });

  it("resolves to NoopMailer when EMAIL_TRANSPORT=noop", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "noop");
    vi.resetModules();

    const { getMailer, NoopMailer } = await import("@/server/auth/mailer");
    expect(getMailer()).toBeInstanceOf(NoopMailer);
  });

  it("__setMailer overrides the resolved singleton (the test-suite-wide safety seam)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    vi.resetModules();

    const { getMailer, __setMailer, NoopMailer } = await import("@/server/auth/mailer");
    __setMailer(new NoopMailer());
    expect(getMailer()).toBeInstanceOf(NoopMailer); // never resolves "resend" once overridden
  });
});

describe("ResendMailer — sendEmailVerification", () => {
  it("renders the verification link with the raw token and sends it via Resend", async () => {
    const { sendViaResend } = await import("@/server/email/resend-client");
    vi.mocked(sendViaResend).mockResolvedValue({ id: "msg_2" });

    const { ResendMailer } = await import("@/server/auth/mailer");
    const mailer = new ResendMailer("re_key", "Taek Shops <noreply@example.test>");
    await mailer.sendEmailVerification({ to: "customer@example.test", token: "verify-token" });

    const call = vi.mocked(sendViaResend).mock.calls[0]![0];
    expect(call.html).toContain("verify-token");
    expect(call.subject.toLowerCase()).toContain("verify");
  });
});
