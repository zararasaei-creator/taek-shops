import { Container } from "@/components/ui/container";

export default function HomePage() {
  return (
    <Container className="py-16">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Uniforms, belts, and gear for every taekwondo journey
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-300">
        Taek Shops is under construction. This is the Phase&nbsp;1 application shell &mdash; the
        storefront, catalogue, cart, checkout, and admin tools are defined in the implementation
        roadmap and will be built in later phases.
      </p>
    </Container>
  );
}
