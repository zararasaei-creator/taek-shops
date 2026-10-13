// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setLogSink,
  errorCategory,
  errorFields,
  logError,
  logInfo,
  logWarn,
  sanitizeFields,
  startJobRun,
  type LogLevel,
} from "@/server/observability/logger";
import { checkReadiness } from "@/server/observability/readiness";

let captured: { level: LogLevel; record: Record<string, unknown>; line: string }[] = [];
beforeEach(() => {
  captured = [];
  __setLogSink((level, line) => captured.push({ level, line, record: JSON.parse(line) as Record<string, unknown> }));
});
afterEach(() => __setLogSink(null));

// Representative secrets / personal data. NONE of these may ever appear in a log line.
const SECRETS = [
  "sk_live_51HabcdefghijklmnopQRSTUV",
  "sk_test_SECRETKEY1234567890",
  "whsec_abcdef1234567890ABCDEF",
  "re_AbCdEf123456_7890",
  "hunter2-SuperSecretPassword",
  "jane.doe@example.com",
  "postgresql://appuser:s3cr3tPW@db.internal:5432/prod",
  "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
];

describe("structured logger", () => {
  it("writes one JSON object per call with ts, level, event and service; info→stdout-level, warn/error→stderr-level", () => {
    logInfo("job.started", { job: "x", runId: "r1" });
    logWarn("job.completed", { job: "x" });
    logError("job.failed", { job: "x" });
    expect(captured.map((c) => c.level)).toEqual(["info", "warn", "error"]);
    for (const { record, line } of captured) {
      expect(line).not.toContain("\n");
      expect(new Date(record.ts as string).toISOString()).toBe(record.ts);
      expect(record.service).toBe("taek-shops");
      expect(typeof record.event).toBe("string");
    }
    expect(captured[0]!.record).toMatchObject({ level: "info", event: "job.started", job: "x", runId: "r1" });
  });

  it("caller fields can never overwrite the envelope (ts, level, event, service)", () => {
    logInfo("real.event", { ts: "1999-01-01", level: "debug", event: "fake", service: "evil" } as never);
    expect(captured[0]!.record).toMatchObject({ level: "info", event: "real.event", service: "taek-shops" });
    expect(captured[0]!.record.ts).not.toBe("1999-01-01");
  });

  it("redacts by FIELD NAME whatever the value", () => {
    logInfo("t", {
      password: "x",
      passwd: "x",
      apiKey: "x",
      stripeSecret: "x",
      sessionToken: "x",
      cookie: "x",
      authorization: "x",
      connectionString: "x",
      databaseUrl: "x",
      customerEmail: "x",
      shippingAddress: "x",
      phone: "x",
      firstName: "x",
      payload: "x",
      requestBody: "x",
      signature: "x",
      cardNumber: "x",
    });
    const { record } = captured[0]!;
    for (const key of Object.keys(record).filter((k) => !["ts", "level", "event", "service"].includes(k))) {
      expect(record[key], key).toBe("[redacted]");
    }
  });

  it("keeps ordinary operational identifiers", () => {
    logInfo("t", { eventId: "evt_123", eventType: "payment_intent.succeeded", orderId: "cl123", count: 3, durationMs: 12, ok: true, none: null, stage: "x" });
    expect(captured[0]!.record).toMatchObject({ eventId: "evt_123", eventType: "payment_intent.succeeded", orderId: "cl123", count: 3, durationMs: 12, ok: true, none: null, stage: "x" });
  });

  it("scrubs secret SHAPES out of string values, whichever field they arrive in", () => {
    // (An arbitrary bare password has no shape to detect — see the logger's stated limit; it is
    // covered by field-name redaction and by errors being category-only, tested below.)
    const shaped = SECRETS.filter((x) => !x.startsWith("hunter2"));
    logError("t", { detail: shaped.join(" | ") });
    for (const secret of shaped) expect(captured[0]!.line).not.toContain(secret);
    expect(captured[0]!.line).not.toMatch(/s3cr3tPW|SECRETKEY|jane\.doe|eyJhbGci/);
  });

  it("drops non-primitive values (objects, arrays, errors, functions) and truncates long strings", () => {
    const out = sanitizeFields({
      obj: { password: "x" } as never,
      arr: [1, 2] as never,
      err: new Error("boom hunter2") as never,
      fn: (() => 1) as never,
      long: "a".repeat(5000),
    });
    expect(Object.keys(out)).toEqual(["long"]);
    expect((out.long as string).length).toBeLessThan(400);
  });

  it("never throws, even if the sink does", () => {
    __setLogSink(() => {
      throw new Error("disk full");
    });
    expect(() => logError("t")).not.toThrow();
  });
});

describe("error fields are category-only", () => {
  class PaymentGatewayError extends Error {
    ambiguous: boolean;
    constructor(message: string, ambiguous: boolean) {
      super(message);
      this.name = "PaymentGatewayError";
      this.ambiguous = ambiguous;
    }
  }
  class PrismaClientKnownRequestError extends Error {
    code = "P2002";
    constructor(message: string) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
    }
  }
  class PrismaClientInitializationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PrismaClientInitializationError";
    }
  }

  it("maps known failures to stable categories", () => {
    expect(errorCategory(new PrismaClientKnownRequestError("x"))).toBe("database:P2002");
    expect(errorCategory(new PrismaClientInitializationError("x"))).toBe("database:connection");
    expect(errorCategory(new PaymentGatewayError("x", true))).toBe("provider:ambiguous");
    expect(errorCategory(new PaymentGatewayError("x", false))).toBe("provider:declined");
    expect(errorCategory(Object.assign(new Error("x"), { name: "WebhookSignatureError" }))).toBe("signature");
    expect(errorCategory(Object.assign(new Error("x"), { name: "ZodError" }))).toBe("validation");
    expect(errorCategory(new Error("x"))).toBe("unexpected");
    expect(errorCategory("a string")).toBe("unexpected");
    expect(errorCategory(null)).toBe("unexpected");
  });

  it("never carries the message, stack or cause — even when the message is full of secrets", () => {
    const error = new PaymentGatewayError(`Invalid API Key ${SECRETS.join(" ")}`, false);
    (error as { cause?: unknown }).cause = new Error(SECRETS[1]);
    logError("t", errorFields(error));
    expect(captured[0]!.record).toMatchObject({ errorName: "PaymentGatewayError", errorCategory: "provider:declined" });
    for (const secret of SECRETS) expect(captured[0]!.line).not.toContain(secret);
    expect(captured[0]!.line).not.toContain("Invalid API Key");
    expect(captured[0]!.line).not.toContain("at "); // no stack frames
  });
});

describe("job runs", () => {
  it("emits job.started then job.completed with the same runId and a duration; status decides the level", async () => {
    const run = startJobRun("emails:dispatch");
    await new Promise((r) => setTimeout(r, 15));
    run.finish("ok", { claimed: 2, sent: 2, notSent: 0 });
    expect(captured.map((c) => c.record.event)).toEqual(["job.started", "job.completed"]);
    const [started, completed] = captured.map((c) => c.record);
    expect(started).toMatchObject({ job: "emails:dispatch", runId: run.runId });
    expect(completed).toMatchObject({ job: "emails:dispatch", runId: run.runId, status: "ok", claimed: 2 });
    expect(completed!.durationMs).toBeGreaterThanOrEqual(10);
    expect(captured[1]!.level).toBe("info");
  });

  it("completed_with_errors / attention_required / skipped are warnings", () => {
    for (const status of ["completed_with_errors", "attention_required", "skipped"] as const) {
      captured = [];
      startJobRun("j").finish(status);
      expect(captured.at(-1)!.level).toBe("warn");
      expect(captured.at(-1)!.record.status).toBe(status);
    }
  });

  it("job.failed carries a category and duration but no message, and does not touch the exit code", () => {
    const before = process.exitCode;
    const run = startJobRun("images:cleanup-uploads");
    run.fail(new Error(`connect failed ${SECRETS[6]}`));
    const failed = captured.at(-1)!;
    expect(failed.level).toBe("error");
    expect(failed.record).toMatchObject({ event: "job.failed", job: "images:cleanup-uploads", runId: run.runId, status: "failed", errorCategory: "unexpected" });
    expect(typeof failed.record.durationMs).toBe("number");
    expect(failed.line).not.toContain("s3cr3tPW");
    expect(process.exitCode).toBe(before); // each script keeps its own non-zero exit
  });
});

describe("readiness check", () => {
  it("true when the query succeeds; false (and a category-only log) when it fails or hangs", async () => {
    expect(await checkReadiness({ $queryRaw: (async () => [{ "?column?": 1 }]) as never })).toBe(true);

    captured = [];
    expect(
      await checkReadiness({ $queryRaw: (async () => { throw new Error(`down ${SECRETS[6]}`); }) as never }),
    ).toBe(false);
    expect(captured[0]!.record).toMatchObject({ event: "health.readiness_failed", level: "error", check: "database", errorCategory: "unexpected" });
    expect(captured[0]!.line).not.toContain("s3cr3tPW");

    captured = [];
    expect(await checkReadiness({ $queryRaw: (() => new Promise(() => {})) as never }, 40)).toBe(false);
    expect(captured[0]!.record).toMatchObject({ errorCategory: "timeout" });
  });
});
