/** Where a signed-in user lands when no explicit destination was requested. */
export function defaultLanding(role: string): string {
  return role === "CUSTOMER" ? "/account" : "/admin";
}
