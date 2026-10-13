import type { Page } from "@playwright/test";

/**
 * Sign in through the real `/login` form — never fabricates a session.
 * `next` is the path to land on after sign-in (defaults to `/admin`, the
 * login page's own default when no `next` query param is given).
 */
export async function loginAs(page: Page, email: string, password: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(next ? new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /\/admin/);
}
