import { Container } from "@/components/ui/container";

/** Shown to a signed-in user without `settings.write` (the service enforces it too). */
export function AccessDenied({ what }: { what: string }) {
  return (
    <Container className="py-16">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-300">
        Only administrators can view or change the {what}.
      </p>
    </Container>
  );
}
