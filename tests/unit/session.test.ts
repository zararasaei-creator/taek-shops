// @vitest-environment node
import { UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { issueSession, revokeSessionToken, validateSessionToken } from "@/server/auth/session";
import { hashToken } from "@/server/auth/tokens";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";
import { makeUser } from "./helpers/fixtures";

describe("session lifecycle", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.session.create.mockResolvedValue({ id: "sess_1" } as never);
    db.user.update.mockResolvedValue({} as never);
    db.session.deleteMany.mockResolvedValue({ count: 1 } as never);
  });

  it("issues an opaque token and stores only its hash", async () => {
    const issued = await issueSession("user_1", { ipAddress: "1.1.1.1" }, db);
    expect(issued.rawToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const created = db.session.create.mock.calls[0]![0].data;
    expect(created.tokenHash).toBe(hashToken(issued.rawToken));
    expect(created.tokenHash).not.toContain(issued.rawToken);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("validates an active session and returns the DB-sourced user", async () => {
    const user = makeUser({ id: "user_1", role: "ADMIN" });
    db.session.findUnique.mockResolvedValue({
      id: "sess_1",
      userId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user,
    } as never);

    const result = await validateSessionToken("raw-token", db);
    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.user.role).toBe("ADMIN");
    }
  });

  it("treats an unknown token as invalid", async () => {
    db.session.findUnique.mockResolvedValue(null);
    expect((await validateSessionToken("nope", db)).status).toBe("invalid");
    expect((await validateSessionToken(undefined, db)).status).toBe("invalid");
  });

  it("expires and deletes a past-due session", async () => {
    db.session.findUnique.mockResolvedValue({
      id: "sess_1",
      userId: "user_1",
      expiresAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
      user: makeUser({ id: "user_1" }),
    } as never);

    const result = await validateSessionToken("raw-token", db);
    expect(result.status).toBe("expired");
    expect(db.session.deleteMany).toHaveBeenCalled();
  });

  it("rejects a session whose owner is no longer ACTIVE", async () => {
    db.session.findUnique.mockResolvedValue({
      id: "sess_1",
      userId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user: makeUser({ id: "user_1", status: UserStatus.DEACTIVATED }),
    } as never);

    const result = await validateSessionToken("raw-token", db);
    expect(result.status).toBe("disabled");
  });

  it("revokes a session by deleting the row for its token hash", async () => {
    await revokeSessionToken("raw-token", db);
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken("raw-token") },
    });
  });
});
