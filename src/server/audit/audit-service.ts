import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { sanitizeAuditMetadata } from "@/server/audit/sanitize";
import type { AuditAction } from "@/server/audit/actions";

/** Minimum DB surface the audit service needs (eases testing / transactions). */
export type AuditDb = Pick<PrismaClient, "auditLog">;

export interface AuditContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RecordAuditInput extends AuditContext {
  action: AuditAction | (string & {});
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: unknown;
}

/**
 * Write one audit row. Metadata is always sanitised. Failure to write an audit
 * record is logged but never propagated — losing an audit line must not break
 * the user-facing operation it describes.
 */
export async function recordAudit(input: RecordAuditInput, db: AuditDb = prisma): Promise<void> {
  const sanitized = sanitizeAuditMetadata(input.metadata);

  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: input.action,
    actorUserId: input.actorUserId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    ipAddress: truncate(input.ipAddress, 100),
    userAgent: truncate(input.userAgent, 400),
    metadata: sanitized ? (sanitized as Prisma.InputJsonValue) : Prisma.JsonNull,
  };

  try {
    await db.auditLog.create({ data });
  } catch (error) {
    console.error("[audit] failed to record %s: %s", input.action, describeError(error));
  }
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
