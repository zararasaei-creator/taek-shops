/**
 * The dedicated e2e server's origin (see playwright.config.ts's `E2E_PORT`).
 * Legacy specs that hand-construct a raw `request.post(...)` need an explicit
 * `Origin` header for the same-origin CSRF check (`src/lib/http/csrf.ts`) —
 * a real browser (`page`) sends this automatically, but Playwright's `request`
 * fixture does not. This used to be hardcoded to `http://localhost:3000` in
 * three specs; wrong now that the suite runs on its own dedicated port.
 */
export const E2E_ORIGIN = "http://localhost:3100";
