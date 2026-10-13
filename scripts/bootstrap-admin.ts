/**
 * First-ADMIN bootstrap (operator-only CLI) — see `src/server/auth/bootstrap-admin.ts`
 * for the guarantees and `docs/deployment.md` § "First administrator".
 *
 * Run it ONCE on a freshly migrated database, from the production image, in an
 * interactive terminal:
 *
 *   docker run -it --rm --env-file <prod.env> taek-shops:<tag> \
 *     node_modules/.bin/tsx scripts/bootstrap-admin.ts --email <you@your-domain>
 *
 * The password is read from a HIDDEN interactive prompt (asked twice) — there is
 * deliberately no `--password` flag, no environment variable, and no way to pipe it
 * in: a non-interactive stdin is refused. Nothing secret is ever printed or logged.
 * Optional, non-secret flags: --first-name, --last-name.
 *
 * It creates one ACTIVE, not-yet-email-verified ADMIN user and one audit row. It
 * creates no business data, sends no email, and is separate from web startup,
 * `prisma migrate deploy` and `prisma db seed`. Re-running is safe: it refuses (and
 * changes nothing) once any ADMIN exists, or if the email belongs to any account.
 *
 * Exit codes: 0 created · 2 refused (expected: ADMIN exists / email in use / invalid
 * input / weak password) · 1 unexpected error.
 *
 * Runs under `tsx` (needs the `@/` path alias), like `orders:expire-abandoned`.
 */

import { WeakPasswordError } from "@/server/auth/errors";
import { BootstrapRefusedError, bootstrapFirstAdmin } from "@/server/auth/bootstrap-admin";
import { prisma } from "@/server/db/client";

const MAX_PASSWORD_ATTEMPTS = 3;

function parseArgs(argv: string[]): { email?: string; firstName?: string; lastName?: string; help: boolean } {
  const out: { email?: string; firstName?: string; lastName?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new BootstrapRefusedError("usage", `${arg} needs a value.`);
      return v;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--email") out.email = value();
    else if (arg === "--first-name") out.firstName = value();
    else if (arg === "--last-name") out.lastName = value();
    else if (arg === "--password" || arg.startsWith("--password=")) {
      throw new BootstrapRefusedError(
        "usage",
        "There is no --password option: the password is only ever entered at the hidden prompt.",
      );
    } else throw new BootstrapRefusedError("usage", `Unknown option: ${arg}`);
  }
  return out;
}

/** Read one line from the terminal without echoing it. Requires an interactive TTY. */
function promptHidden(label: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buffer = "";
    const finish = (fn: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(buffer));
        if (ch === "\u0003") return finish(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
        else if (ch >= " ") buffer += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.email) {
    console.info(
      "Usage: tsx scripts/bootstrap-admin.ts --email <address> [--first-name <n>] [--last-name <n>]\n" +
        "The password is entered at a hidden interactive prompt (run with a TTY, e.g. docker run -it).",
    );
    return args.help ? 0 : 2;
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.error(
      "[admin:bootstrap] refused: stdin is not an interactive terminal. The password can only be " +
        "entered at a hidden prompt (use `docker run -it ...`); it cannot be piped or passed as an argument.",
    );
    return 2;
  }

  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
    const password = await promptHidden("Password (hidden): ");
    const confirm = await promptHidden("Repeat password:   ");
    if (password !== confirm) {
      console.error("[admin:bootstrap] the two entries did not match.");
      continue;
    }
    try {
      const admin = await bootstrapFirstAdmin({
        email: args.email,
        password,
        firstName: args.firstName,
        lastName: args.lastName,
      });
      console.info(
        `[admin:bootstrap] created ADMIN ${admin.email} (status ${admin.status}; email NOT verified). ` +
          "Sign in at /login. Nothing else was created and no email was sent.",
      );
      return 0;
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        console.error("[admin:bootstrap] that password does not meet the policy:");
        for (const reason of error.reasons) console.error(`  - ${reason}`);
        continue;
      }
      throw error;
    }
  }
  console.error(`[admin:bootstrap] refused: no acceptable password after ${MAX_PASSWORD_ATTEMPTS} attempts.`);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof BootstrapRefusedError) {
      console.error(`[admin:bootstrap] refused (${error.code}): ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error("[admin:bootstrap] failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
