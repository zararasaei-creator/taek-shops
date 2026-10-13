import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads the actual `.local/email-previews/` directory the e2e server's
 * `LocalPreviewMailer`/`LocalPreviewOrderMailer` write to — real files on
 * the same filesystem the Playwright test runner and the spawned e2e
 * server both share (two processes, one machine, one `process.cwd()`), so
 * this is a genuine white-box check of what the backend actually did, not
 * an inference from the UI's own (deliberately optimistic, for
 * no-enumeration reasons — see `request-form.tsx`) response handling. A
 * generic "we've sent a link" message in the UI proves nothing about
 * whether a real delivery attempt happened; this does.
 */
const PREVIEW_DIR = join(process.cwd(), ".local", "email-previews");

export async function listEmailPreviewFiles(): Promise<Set<string>> {
  try {
    return new Set(await readdir(PREVIEW_DIR));
  } catch {
    return new Set(); // directory doesn't exist yet if no preview has ever been written
  }
}

/** Filenames present in `after` but not `before`, matching `typeSuffix` (e.g. "password-reset"). */
export function newPreviewFilesOfType(
  before: Set<string>,
  after: Set<string>,
  typeSuffix: string,
): string[] {
  return [...after].filter((name) => !before.has(name) && name.includes(typeSuffix));
}
