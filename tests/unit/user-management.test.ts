// @vitest-environment node
import { UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, SelfRoleChangeError, UnauthenticatedError } from "@/server/auth/errors";
import { changeUserRole, listUsers, setAccountStatus } from "@/server/users/user-management";
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
