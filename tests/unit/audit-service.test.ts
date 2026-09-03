// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { sanitizeAuditMetadata } from "@/server/audit/sanitize";
import { recordAudit, type AuditDb } from "@/server/audit/audit-service";

describe("audit metadata sanitisation", () => {
  it("redacts sensitive keys anywhere in the object", () => {
    const result = sanitizeAuditMetadata({
      email: "a@b.com",
      password: "hunter2",
      nested: { tokenHash: "abc", sessionSecret: "xyz", ok: 1 },
      apiKey: "k",
    });
    expect(result).toEqual({
      email: "a@b.com",
      password: "[redacted]",
      nested: { tokenHash: "[redacted]", sessionSecret: "[redacted]", ok: 1 },
      apiKey: "[redacted]",
    });
  });

  it("drops functions/symbols and caps depth", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    const result = sanitizeAuditMetadata({ fn: () => 1, sym: Symbol("x"), deep });
    expect(result?.fn).toBeNull();
    expect(result?.sym).toBeNull();
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("wraps non-object metadata", () => {
    expect(sanitizeAuditMetadata("hello")).toEqual({ value: "hello" });
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
  });
});

describe("recordAudit", () => {
  function fakeDb() {
    const create = vi.fn().mockResolvedValue({ id: "audit_1" });
    return { db: { auditLog: { create } } as unknown as AuditDb, create };
  }

  it("writes a sanitised row", async () => {
    const { db, create } = fakeDb();
    await recordAudit(
      {
        action: "auth.login.succeeded",
        actorUserId: "user_1",
        entityType: "User",
        entityId: "user_1",
        metadata: { password: "secret", note: "ok" },
        ipAddress: "1.2.3.4",
        userAgent: "UA",
      },
      db,
    );
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0]![0].data;
    expect(data.action).toBe("auth.login.succeeded");
    expect(data.actorUserId).toBe("user_1");
    expect(data.metadata).toEqual({ password: "[redacted]", note: "ok" });
  });

  it("never throws when the write fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { auditLog: { create } } as unknown as AuditDb;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordAudit({ action: "auth.logout" }, db)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
