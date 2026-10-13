// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { route, toErrorResponse } from "@/lib/http/api-response";
import { CsrfError } from "@/lib/http/csrf";
import { InvalidCredentialsError, RateLimitedError, WeakPasswordError } from "@/server/auth/errors";
import { ConflictError, NotFoundError } from "@/server/catalog/errors";
import { ImportFileError } from "@/server/import/errors";
import { __setLogSink, type LogLevel } from "@/server/observability/logger";

let logs: { level: LogLevel; line: string; record: Record<string, unknown> }[] = [];
beforeEach(() => {
  logs = [];
  __setLogSink((level, line) => logs.push({ level, line, record: JSON.parse(line) as Record<string, unknown> }));
});
afterEach(() => {
  __setLogSink(null);
  vi.restoreAllMocks();
});

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

describe("existing API responses are unchanged", () => {
  const cases: [string, () => unknown, number, unknown, Record<string, string>?][] = [
    ["auth error", () => new InvalidCredentialsError(), 401, { error: { code: "invalid_credentials", message: "Invalid email or password." } }],
    [
      "rate limited (+ retry-after header)",
      () => new RateLimitedError(42),
      429,
      { error: { code: "rate_limited", message: "Too many attempts. Please try again later." } },
      { "retry-after": "42" },
    ],
    [
      "weak password (reasons as details)",
      () => new WeakPasswordError(["Must be at least 10 characters."]),
      422,
      { error: { code: "weak_password", message: "Password does not meet the requirements.", details: ["Must be at least 10 characters."] } },
    ],
    ["catalog not found", () => new NotFoundError("Brand", "b1"), 404, { error: { code: "not_found", message: "Brand not found." } }],
    ["catalog conflict", () => new ConflictError("Already exists."), 409, { error: { code: "conflict", message: "Already exists." } }],
    ["import file error", () => new ImportFileError("file_too_large", "The file is too large.", 413), 413, { error: { code: "file_too_large", message: "The file is too large." } }],
    ["csrf", () => new CsrfError("Cross-origin request rejected."), 403, { error: { code: "csrf", message: "Request rejected for security reasons." } }],
    [
      "zod validation",
      () => z.object({ email: z.string() }).safeParse({}).error,
      422,
      { error: { code: "validation", message: "Invalid request.", details: { formErrors: [], fieldErrors: { email: ["Invalid input: expected string, received undefined"] } } } },
    ],
    ["unexpected error → generic 500", () => new Error("boom"), 500, { error: { code: "internal", message: "Something went wrong." } }],
    ["a thrown non-Error → generic 500", () => "just a string", 500, { error: { code: "internal", message: "Something went wrong." } }],
  ];

  it.each(cases)("%s", async (_label, make, status, body, headers) => {
    const res = toErrorResponse(make());
    expect(res.status).toBe(status);
    expect(await bodyOf(res)).toEqual(body);
    for (const [name, value] of Object.entries(headers ?? {})) expect(res.headers.get(name)).toBe(value);
  });

  it("expected (typed) errors are not logged at all — no new noise", () => {
    for (const [, make] of cases.slice(0, 8)) toErrorResponse(make());
    expect(logs).toHaveLength(0);
  });

  it("route() still passes success responses through untouched and converts a thrown error exactly as before", async () => {
    const ok = route(async () => new Response("fine", { status: 201 }));
    expect((await ok()).status).toBe(201);
    const bad = route(async () => {
      throw new ConflictError("Nope.");
    });
    const res = await bad();
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: { code: "conflict", message: "Nope." } });
  });
});

// Representative secrets / customer data that an unexpected failure's message, properties or cause may carry.
const LEAKS = [
  "sk_live_51HabcdefghijklmnopQRSTUV",
  "whsec_abcdef1234567890ABCDEF",
  "jane.doe@example.com",
  "123 Main Street Toronto",
  "M5V2T6",
  "postgresql://appuser:s3cr3tPW@db.internal:5432/prod",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123def456ghi",
];

describe("unexpected failures: one useful, safe structured event", () => {
  function leakyError(): Error {
    const error = new Error(`Query failed for ${LEAKS.join(" | ")}`);
    Object.assign(error, {
      config: { headers: { Authorization: `Bearer ${LEAKS[6]}` }, url: LEAKS[5] },
      customer: { email: LEAKS[2], address: LEAKS[3] },
    });
    error.cause = new Error(LEAKS[0]);
    return error;
  }

  it("logs api.unhandled_error with method, path, request id and a category — and nothing from the error itself", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = route(async (_request: Request) => {
      throw leakyError();
    });
    const res = await handler(
      new Request("https://shop.example.test/api/admin/users/cl123abc?token=SECRETQUERYTOKEN&email=jane.doe@example.com", {
        method: "POST",
        headers: { "x-request-id": "req-1234abcd", cookie: "session=SESSIONSECRET", authorization: "Bearer SECRETAUTH" },
        body: JSON.stringify({ password: "hunter2-body-secret", address: LEAKS[3] }),
      }),
    );

    // Client sees only the generic body — no exception details.
    expect(res.status).toBe(500);
    const bodyText = JSON.stringify(await bodyOf(res));
    expect(JSON.parse(bodyText)).toEqual({ error: { code: "internal", message: "Something went wrong." } });

    // Exactly one structured event, with the useful facts.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("error");
    expect(logs[0]!.record).toMatchObject({
      event: "api.unhandled_error",
      service: "taek-shops",
      method: "POST",
      path: "/api/admin/users/cl123abc", // no query string
      requestId: "req-1234abcd",
      errorName: "Error",
      errorCategory: "unexpected",
    });

    // …and no secret or personal data anywhere: not in the log line, not in the response, not on console.
    const everything = logs.map((l) => l.line).join("\n") + bodyText + consoleError.mock.calls.flat().map(String).join(" ");
    for (const leak of LEAKS) expect(everything, `leaked ${leak}`).not.toContain(leak);
    for (const leak of ["SECRETQUERYTOKEN", "SESSIONSECRET", "SECRETAUTH", "hunter2-body-secret", "Query failed", "at "]) {
      expect(everything, `leaked ${leak}`).not.toContain(leak);
    }
    expect(consoleError).not.toHaveBeenCalled(); // the raw console.error is gone
  });

  it("ignores a malformed x-request-id (never logs attacker-controlled free text) and works without a Request", () => {
    toErrorResponse(new Error("x"), { method: "GET", path: "/api/x" });
    expect(logs[0]!.record).toMatchObject({ method: "GET", path: "/api/x", errorCategory: "unexpected" });
    expect("requestId" in logs[0]!.record).toBe(false);

    logs = [];
    const handler = route(async (_r: Request) => {
      throw new Error("x");
    });
    return handler(new Request("https://shop.example.test/api/y", { headers: { "x-request-id": "bad id with spaces <script>" } })).then(() => {
      expect("requestId" in logs[0]!.record).toBe(false);
      expect(logs[0]!.line).not.toContain("script");
    });
  });

  it("classifies known infrastructure failures into stable categories", () => {
    class PrismaClientKnownRequestError extends Error {
      code = "P2003";
      constructor() {
        super(`Foreign key constraint failed on ${LEAKS[2]}`);
        this.name = "PrismaClientKnownRequestError";
      }
    }
    toErrorResponse(new PrismaClientKnownRequestError(), { method: "DELETE", path: "/api/admin/z" });
    expect(logs[0]!.record).toMatchObject({ errorName: "PrismaClientKnownRequestError", errorCategory: "database:P2003" });
    expect(logs[0]!.line).not.toContain("jane.doe");
  });
});
