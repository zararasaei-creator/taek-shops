import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * - Server-only secrets live in `serverSchema` and are never bundled for the client.
 * - Browser-exposed values must be prefixed `NEXT_PUBLIC_` and referenced explicitly
 *   so Next.js can inline them at build time.
 * - Validation runs at module load. A misconfigured environment fails fast with a
 *   readable error instead of surfacing as an undefined value deep in a request.
 *
 * Most values are optional during early phases; tighten them (e.g. make
 * `DATABASE_URL` required) as each capability lands.
 */

const nodeEnv = z.enum(["development", "test", "production"]).default("development");

const serverSchema = z.object({
  NODE_ENV: nodeEnv,

  // Database (PostgreSQL) - required from the persistence phase onward.
  DATABASE_URL: z.url().optional(),
  DIRECT_DATABASE_URL: z.url().optional(),

  // Authentication (Auth.js).
  AUTH_SECRET: z.string().min(16).optional(),
  AUTH_URL: z.url().optional(),

  // Payment provider (Stripe) - kept behind a replaceable interface.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Object storage (S3-compatible) for product images.
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_PUBLIC_BASE_URL: z.url().optional(),

  // Spreadsheet import guard rails (safe defaults defined here, overridable via env).
  IMPORT_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(5_000_000),
  IMPORT_MAX_ROW_COUNT: z.coerce.number().int().positive().default(10_000),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function parseClientEnv(): ClientEnv {
  // Reference each variable explicitly so Next.js inlines it for the browser bundle.
  const result = clientSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  });

  if (!result.success) {
    throw new Error(`Invalid public environment configuration:\n${formatIssues(result.error)}`);
  }

  return result.data;
}

function parseServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv must not be imported into client-side code.");
  }

  const result = serverSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(`Invalid server environment configuration:\n${formatIssues(result.error)}`);
  }

  return result.data;
}

export const clientEnv: ClientEnv = parseClientEnv();

/**
 * Server-only configuration. Accessing this from a client component throws.
 */
export const serverEnv: ServerEnv =
  typeof window === "undefined"
    ? parseServerEnv()
    : (new Proxy(
        {},
        {
          get() {
            throw new Error("serverEnv is not available in client-side code.");
          },
        },
      ) as unknown as ServerEnv);
