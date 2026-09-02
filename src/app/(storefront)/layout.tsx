import Link from "next/link";
import { Container } from "@/components/ui/container";

export default function StorefrontLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <Container as="nav" className="flex h-16 items-center justify-between">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Taek Shops
          </Link>
          <span className="text-sm text-zinc-500">Canadian taekwondo outfitters</span>
        </Container>
      </header>
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-zinc-200 py-6 text-sm text-zinc-500 dark:border-zinc-800">
        <Container>
          &copy; {new Date().getFullYear()} Taek Shops. All prices in Canadian dollars.
        </Container>
      </footer>
    </div>
  );
}
