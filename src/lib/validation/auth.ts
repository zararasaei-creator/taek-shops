import { UserRole, UserStatus } from "@prisma/client";
import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/server/auth/password-policy";

/**
 * Shared auth input schemas. The password *policy* (blocklist, personal-info
 * checks) lives in `password-policy.ts`; this only enforces the shape/length so
 * schemas stay usable on the client without pulling server logic.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((value) => z.email().safeParse(value).success, "Enter a valid email address.");

export const passwordShapeSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});

export const passwordResetCompleteSchema = z.object({
  token: z.string().min(10).max(256),
  password: passwordShapeSchema,
});
export type PasswordResetCompleteInput = z.infer<typeof passwordResetCompleteSchema>;

export const emailVerificationConfirmSchema = z.object({
  token: z.string().min(10).max(256),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordShapeSchema,
});

export const roleChangeSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(UserRole),
});
export type RoleChangeInput = z.infer<typeof roleChangeSchema>;

export const statusChangeSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(UserStatus),
});
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

export const listUsersQuerySchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(50),
  role: z.enum(UserRole).optional(),
  status: z.enum(UserStatus).optional(),
  search: z.string().trim().max(200).optional(),
});
