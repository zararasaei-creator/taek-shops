// @vitest-environment node
import { UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ForbiddenError,
  SelfRoleChangeError,
  UnauthenticatedError,
  WeakPasswordError,
} from "@/server/auth/errors";
import { verifyPassword } from "@/server/auth/password";
import {
  adminCreateUser,
  changeUserRole,
  listUsers,
  setAccountStatus,
} from "@/server/users/user-management";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";
import { makeUser } from "./helpers/fixtures";

const admin = { id: "admin_1", role: UserRole.ADMIN };
const manager = { id: "manager_1", role: UserRole.MANAGER };
const staff = { id: "staff_1", role: UserRole.STAFF };

describe("user management authorization", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
    db.session.deleteMany.mockResolvedValue({ count: 0 } as never);
  });

  it("listUsers requires the user.read permission", async () => {
    db.user.findMany.mockResolvedValue([] as never);
    db.user.count.mockResolvedValue(0 as never);

    await expect(listUsers(null, {}, db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(listUsers(staff, {}, db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listUsers(manager, {}, db)).resolves.toEqual({ users: [], total: 0 });
  });

  it("only ADMIN can change roles", async () => {
    db.user.findUnique.mockResolvedValue(makeUser({ id: "target" }) as never);
    await expect(
      changeUserRole(manager, { userId: "target", role: UserRole.STAFF }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("nobody can change their own role", async () => {
    await expect(
      changeUserRole(admin, { userId: admin.id, role: UserRole.MANAGER }, db),
    ).rejects.toBeInstanceOf(SelfRoleChangeError);
  });

  it("an ADMIN can promote another user and it is audited", async () => {
    db.user.findUnique.mockResolvedValue(makeUser({ id: "target", role: UserRole.STAFF }) as never);
    db.user.update.mockResolvedValue(makeUser({ id: "target", role: UserRole.MANAGER }) as never);

    const updated = await changeUserRole(admin, { userId: "target", role: UserRole.MANAGER }, db);
    expect(updated.role).toBe(UserRole.MANAGER);
    const actions = db.auditLog.create.mock.calls.map((c) => c[0]?.data?.action);
    expect(actions).toContain("user.role.changed");
  });

  it("an ADMIN promoting someone to ADMIN is allowed (admins appoint admins)", async () => {
    db.user.findUnique.mockResolvedValue(
      makeUser({ id: "target", role: UserRole.MANAGER }) as never,
    );
    db.user.update.mockResolvedValue(makeUser({ id: "target", role: UserRole.ADMIN }) as never);
    await expect(
      changeUserRole(admin, { userId: "target", role: UserRole.ADMIN }, db),
    ).resolves.toMatchObject({ role: UserRole.ADMIN });
  });

  it("deactivating a user revokes their sessions and is audited", async () => {
    db.user.findUnique.mockResolvedValue(
      makeUser({ id: "target", status: UserStatus.ACTIVE }) as never,
    );
    db.user.update.mockResolvedValue(
      makeUser({ id: "target", status: UserStatus.DEACTIVATED }) as never,
    );
    db.session.deleteMany.mockResolvedValue({ count: 3 } as never);

    const updated = await setAccountStatus(
      admin,
      { userId: "target", status: UserStatus.DEACTIVATED },
      db,
    );
    expect(updated.status).toBe(UserStatus.DEACTIVATED);
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "target" } });
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("user.status.changed");
    expect(audit?.metadata).toMatchObject({ sessionsRevoked: 3 });
  });

  it("an admin cannot change their own account status", async () => {
    await expect(
      setAccountStatus(admin, { userId: admin.id, status: UserStatus.DEACTIVATED }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("adminCreateUser", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("requires an authenticated ADMIN (401 / 403)", async () => {
    await expect(
      adminCreateUser(null, { email: "new@example.com", role: UserRole.STAFF }, db),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    for (const actor of [staff, manager]) {
      await expect(
        adminCreateUser(actor, { email: "new@example.com", role: UserRole.STAFF }, db),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("hashes the temporary password (never stores plaintext) and starts INVITED", async () => {
    db.user.create.mockResolvedValue(
      makeUser({
        id: "new_1",
        email: "new@example.com",
        role: UserRole.STAFF,
        status: UserStatus.INVITED,
      }) as never,
    );

    const created = await adminCreateUser(
      admin,
      { email: "new@example.com", role: UserRole.STAFF, temporaryPassword: "temp-strong-pass-1" },
      db,
    );

    expect(created.status).toBe(UserStatus.INVITED);
    expect("passwordHash" in created).toBe(false);

    const data = db.user.create.mock.calls[0]![0].data as { passwordHash: string; status: string };
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data.passwordHash).not.toContain("temp-strong-pass-1");
    expect(await verifyPassword(data.passwordHash, "temp-strong-pass-1")).toBe(true);
    expect(data.status).toBe(UserStatus.INVITED);
  });

  it("records a user.created audit event with no secrets", async () => {
    db.user.create.mockResolvedValue(
      makeUser({ id: "new_2", role: UserRole.MANAGER, status: UserStatus.INVITED }) as never,
    );

    await adminCreateUser(
      admin,
      { email: "mgr@example.com", role: UserRole.MANAGER, temporaryPassword: "temp-strong-pass-2" },
      db,
    );

    const audit = db.auditLog.create.mock.calls.at(-1)![0].data as {
      action: string;
      actorUserId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("user.created");
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata).toEqual({ role: UserRole.MANAGER, status: "INVITED" });
    expect(JSON.stringify(audit)).not.toContain("temp-strong-pass-2");
    expect(JSON.stringify(audit)).not.toMatch(/\$argon2id\$/);
  });

  it("allows creation without a temporary password (passwordHash null)", async () => {
    db.user.create.mockResolvedValue(makeUser({ id: "new_3" }) as never);
    await adminCreateUser(admin, { email: "invite@example.com", role: UserRole.STAFF }, db);
    const data = db.user.create.mock.calls[0]![0].data as { passwordHash: string | null };
    expect(data.passwordHash).toBeNull();
  });

  it("rejects a weak temporary password", async () => {
    await expect(
      adminCreateUser(
        admin,
        { email: "weak@example.com", role: UserRole.STAFF, temporaryPassword: "password123" },
        db,
      ),
    ).rejects.toBeInstanceOf(WeakPasswordError);
  });
});
