import type { Metadata } from "next";
import "./globals.css";
import { clientEnv } from "@/server/config/env";

export const metadata: Metadata = {
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: "Taek Shops",
    template: "%s | Taek Shops",
  },
  description:
    "Canadian online store for taekwondo uniforms, belts, protective gear, and training equipment.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
        {children}
      </body>
    </html>
  );
}
