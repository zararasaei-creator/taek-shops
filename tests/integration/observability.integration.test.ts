import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { startPayment } from "@/server/orders/payment-service";
import { __setPaymentGateway } from "@/server/domain/payments";
import { __setLogSink, type LogLevel } from "@/server/observability/logger";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as readyGET } from "@/app/api/health/ready/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { cleanup, db, makeVariant } from "./helpers/db";
import { cleanupCheckout, ensureTaxAndShippingConfig, makeCart, placeOrderInput, type TestShippingConfig } from "./helpers/checkout";
import { FakeStripeGateway, cleanupOwnedWebhookEvents, makeEvent as makeRawEvent } from "./helpers/payments";

/**
 * Operational-error visibility (structured logs, job runs, webhook failures, health/readiness).
 * Synthetic data, the fake Stripe gateway and mocked transports only — nothing leaves the machine.
 */

// Representative secrets / personal data a failing provider or database call might echo back.
const LEAKY_MESSAGE =
  "Invalid API Key provided: sk_test_SECRETKEY1234567890. customer jane.doe@example.com, " +
  "123 Main Street Toronto M5V2T6, Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123def456ghi, " +
  "connect postgresql://appuser:s3cr3tPW@db.internal:5432/prod whsec_abcdef1234567890ABCDEF";
const FORBIDDEN = [
  "sk_test_SECRETKEY",
  "jane.doe",
  "Main Street",
  "M5V2T6",
  "eyJhbGci",
  "s3cr3tPW",
  "appuser",
  "postgresql://",
  "whsec_abcdef",
  "Invalid API Key",
];
function expectNoLeak(text: string): void {
  for (const bad of FORBIDDEN) expect(text, `leaked: ${bad}`).not.toContain(bad);
}

let cfg: TestShippingConfig;
let logs: { level: LogLevel; line: string; record: Record<string, unknown> }[] = [];
const ownedWebhookEventIds = new Set<string>();
function makeEvent(...args: Parameters<typeof makeRawEvent>) {
  const event = makeRawEvent(...args);
  ownedWebhookEventIds.add(event.eventId);
  return event;
}
const events = (name: string) => logs.filter((l) => l.record.event === name);

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
});
beforeEach(() => {
  logs = [];
  __setLogSink((level, line) => logs.push({ level, line, record: JSON.parse(line) as Record<string, unknown> }));
});
afterEach(() => {
  __setLogSink(null);
  __setPaymentGateway(new FakeStripeGateway());
  vi.restoreAllMocks();
});
afterAll(async () => {
  await cleanupOwnedWebhookEvents(db, ownedWebhookEventIds);
  await cleanupCheckout();
  await cleanup();
  await db.$disconnect();
});

async function paidReadyOrder(gateway: FakeStripeGateway) {
  __setPaymentGateway(gateway);
  const v = await makeVariant({ onHand: 10 });
  const cart = await makeCart();
  await addToCart({ token: cart.token }, { variantId: v.variantId, quantity: 1 });
  const order = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
  const start = await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
  const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId!;
  const pi = gateway.patch(piId, { status: "succeeded", amountReceived: start.amountCents });
  return { order, pi };
}
async function post(body: string, header: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await stripeWebhook(
    new Request("http://localhost/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": header } }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const orderState = (id: string) => db.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true } });

describe("Stripe webhook: unexpected failures are logged safely AND stay retryable", () => {
  it("an invalid signature is rejected 400 with a category-only warning and no signature content", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const secretHeader = "t=1700000000,v1=deadbeefSIGNATUREVALUE";
    const res = await post('{"id":"evt_x","type":"payment_intent.succeeded"}', secretHeader);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_signature" });
    const [rejected] = events("stripe_webhook.rejected");
    expect(rejected!.level).toBe("warn");
    expect(rejected!.record).toMatchObject({ reason: "invalid_signature" });
    expect(logs.map((l) => l.line).join("\n")).not.toContain("SIGNATUREVALUE");
  });

  it("a failure while re-fetching the PaymentIntent: 500 (as before), structured error with event id, no leak — and the SAME event succeeds on redelivery", async () => {
    const gateway = new FakeStripeGateway();
    const { order, pi } = await paidReadyOrder(gateway);
    const evt = makeEvent("payment_intent.succeeded", pi);
    vi.spyOn(gateway, "retrievePaymentIntent").mockRejectedValueOnce(new Error(LEAKY_MESSAGE));

    const failed = await post(evt.body, evt.header);

    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: "processing_error" });
    const [entry] = events("stripe_webhook.processing_failed");
    expect(entry!.level).toBe("error");
    expect(entry!.record).toMatchObject({
      eventId: evt.eventId,
      eventType: "payment_intent.succeeded",
      stage: "retrieve_payment_intent",
      errorName: "Error",
      errorCategory: "unexpected",
    });
    expectNoLeak(logs.map((l) => l.line).join("\n") + JSON.stringify(failed.json));
    // Nothing consumed: the event id was NOT recorded, the order is untouched…
    expect(await db.webhookEvent.count({ where: { eventId: evt.eventId } })).toBe(0);
    expect(await orderState(order.id)).toMatchObject({ paymentStatus: "UNPAID" });
    // …so Stripe's retry (the same event) is processed normally.
    const retry = await post(evt.body, evt.header);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ received: true, handled: true });
    expect(await orderState(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
  });

  it("a failure inside the payment transaction: 500, structured error, rolled back, retryable", async () => {
    const gateway = new FakeStripeGateway();
    const { order, pi } = await paidReadyOrder(gateway);
    const evt = makeEvent("payment_intent.succeeded", pi);
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error(LEAKY_MESSAGE));

    const failed = await post(evt.body, evt.header);

    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: "processing_error" });
    expect(events("stripe_webhook.processing_failed")[0]!.record).toMatchObject({
      eventId: evt.eventId,
      stage: "payment_transaction",
      errorCategory: "unexpected",
    });
    expectNoLeak(logs.map((l) => l.line).join("\n"));
    expect(await db.webhookEvent.count({ where: { eventId: evt.eventId } })).toBe(0);
    expect(await orderState(order.id)).toMatchObject({ paymentStatus: "UNPAID" });

    const retry = await post(evt.body, evt.header);
    expect(retry.status).toBe(200);
    expect(await orderState(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    // Repeated failure of the same event shows up as repeated events carrying the SAME eventId.
  });

  it("a successful delivery and a duplicate emit no failure events", async () => {
    const gateway = new FakeStripeGateway();
    const { pi } = await paidReadyOrder(gateway);
    const evt = makeEvent("payment_intent.succeeded", pi);
    expect((await post(evt.body, evt.header)).status).toBe(200);
    expect((await post(evt.body, evt.header)).json).toMatchObject({ duplicate: true });
    expect(events("stripe_webhook.processing_failed")).toHaveLength(0);
  });
});

describe("health: liveness vs readiness", () => {
  it("/api/health is liveness only: 200, status+timestamp, no configuration, and it never touches the database", async () => {
    const spy = vi.spyOn(db, "$queryRaw");
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    expect(body.status).toBe("ok");
    expect(JSON.stringify(body)).not.toMatch(/production|development|test|postgres|env/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(spy).not.toHaveBeenCalled();
  });

  it("/api/health/ready is 200 {status:'ready'} when the database answers", async () => {
    const res = await readyGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(events("health.readiness_failed")).toHaveLength(0);
  });

  it("/api/health/ready is 503 {status:'unavailable'} when the database is down — and the body reveals nothing", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error(LEAKY_MESSAGE));
    const res = await readyGET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "unavailable" });
    expectNoLeak(text);
    const [entry] = events("health.readiness_failed");
    expect(entry!.level).toBe("error");
    expect(entry!.record).toMatchObject({ check: "database", errorCategory: "unexpected" });
    expectNoLeak(logs.map((l) => l.line).join("\n"));
  });

  it("liveness stays 200 while readiness is 503 (a database outage is not a process failure)", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("db down"));
    expect((await healthGET()).status).toBe(200);
    expect((await readyGET()).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------
// The three jobs, run exactly as production runs them (child processes against the
// isolated test database; every external endpoint is a loopback port nothing listens on).
// ---------------------------------------------------------------------------------------
const ROOT = resolve(__dirname, "..", "..");
const UNREACHABLE_DB = "postgresql://jobuser:JOBS3CRETPW@127.0.0.1:1/jobdb?schema=public&connect_timeout=2";

interface JobResult {
  code: number | null;
  events: Record<string, unknown>[];
  raw: string;
}
function runJob(script: string, env: Record<string, string>, viaTsx = false): Promise<JobResult> {
  const args = viaTsx ? [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), script] : [script];
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        // No real provider anywhere near these runs:
        STRIPE_SECRET_KEY: "sk_test_job_synthetic",
        EMAIL_TRANSPORT: "",
        RESEND_API_KEY: "",
        S3_ENDPOINT: "",
        S3_REGION: "",
        S3_BUCKET: "",
        S3_ACCESS_KEY_ID: "",
        S3_SECRET_ACCESS_KEY: "",
        S3_PUBLIC_BASE_URL: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    child.stdout.on("data", (d) => (raw += d));
    child.stderr.on("data", (d) => (raw += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const events = raw
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolveRun({ code, events, raw });
    });
  });
}
const JOBS = [
  { job: "emails:dispatch", script: "scripts/dispatch-emails.ts", tsx: false },
  { job: "images:cleanup-uploads", script: "scripts/cleanup-image-uploads.ts", tsx: false },
  { job: "orders:expire-abandoned", script: "scripts/expire-abandoned-orders.ts", tsx: true },
] as const;

describe("jobs: start, completion summary, duration, failure — and the exit code", () => {
  const goodDb = () => process.env.DATABASE_URL!; // the isolated test database (set by the integration setup)

  it.each(JOBS)("$job succeeds: job.started then job.completed (same runId, durationMs), exit 0, no leak", async ({ job, script, tsx }) => {
    const result = await runJob(script, { DATABASE_URL: goodDb() }, tsx);
    expect(result.code).toBe(0);
    const names = result.events.map((e) => e.event);
    expect(names[0]).toBe("job.started");
    expect(names.at(-1)).toBe("job.completed");
    const [started, completed] = [result.events[0]!, result.events.at(-1)!];
    expect(started).toMatchObject({ job, level: "info", service: "taek-shops" });
    expect(completed).toMatchObject({ job, runId: started.runId });
    expect(typeof completed.durationMs).toBe("number");
    expect(typeof completed.ts).toBe("string");
    expect(result.raw).not.toContain(goodDb());
  });

  it("images:cleanup-uploads without S3 reports skipped (a warning), still exit 0 as before", async () => {
    const result = await runJob("scripts/cleanup-image-uploads.ts", { DATABASE_URL: goodDb() });
    expect(result.code).toBe(0);
    expect(result.events.at(-1)).toMatchObject({ event: "job.completed", status: "skipped", reason: "s3_not_configured", level: "warn" });
  });

  it("images:cleanup-uploads with S3 configured (unreachable endpoint, nothing to clean) completes ok with its counters", async () => {
    const result = await runJob("scripts/cleanup-image-uploads.ts", {
      DATABASE_URL: goodDb(),
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_REGION: "us-east-1",
      S3_BUCKET: "synthetic",
      S3_ACCESS_KEY_ID: "synthetic-access",
      S3_SECRET_ACCESS_KEY: "synthetic-secret-JOBS3CRET",
    });
    expect(result.code).toBe(0);
    expect(result.events.at(-1)).toMatchObject({ event: "job.completed", status: "ok", found: 0, gaveUp: 0 });
    expect(result.raw).not.toContain("JOBS3CRET");
  });

  it.each(JOBS)("$job fails (database unreachable): exit code 1, a job.failed event with a category and duration, and NO connection string / password anywhere", async ({ job, script, tsx }) => {
    // S3 is configured (to a dead loopback port) so the cleanup job gets past its "S3 not configured" skip
    // and actually needs the database, like the other two.
    const result = await runJob(
      script,
      {
        DATABASE_URL: UNREACHABLE_DB,
        S3_ENDPOINT: "http://127.0.0.1:1",
        S3_REGION: "us-east-1",
        S3_BUCKET: "synthetic",
        S3_ACCESS_KEY_ID: "synthetic-access",
        S3_SECRET_ACCESS_KEY: "synthetic-secret",
      },
      tsx,
    );
    expect(result.code).toBe(1);
    const failed = result.events.find((e) => e.event === "job.failed");
    expect(failed).toMatchObject({ job, level: "error", status: "failed" });
    expect(String(failed!.errorCategory)).toMatch(/^database:|^unexpected$/);
    expect(typeof failed!.durationMs).toBe("number");
    expect(result.events.some((e) => e.event === "job.completed")).toBe(false);
    expect(result.events[0]).toMatchObject({ event: "job.started", runId: failed!.runId });
    expect(result.raw).not.toContain("JOBS3CRETPW");
    expect(result.raw).not.toContain("jobuser");
    expect(result.raw).not.toContain("postgresql://");
  }, 60_000);
});
