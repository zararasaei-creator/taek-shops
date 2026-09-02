import { Container } from "@/components/ui/container";

export default function AdminDashboardPage() {
  return (
    <Container className="py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-300">
        Placeholder admin dashboard. Catalogue management, inventory, orders, and the spreadsheet
        import workflow are specified in <code>docs/product-import-specification.md</code> and
        scheduled in the implementation roadmap.
      </p>
    </Container>
  );
}
