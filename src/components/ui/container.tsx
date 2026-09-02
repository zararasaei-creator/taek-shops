import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

interface ContainerProps {
  as?: ElementType;
  className?: string;
  children: ReactNode;
}

/**
 * Constrains content to a readable, responsive width with consistent gutters.
 */
export function Container({ as: Component = "div", className, children }: ContainerProps) {
  return (
    <Component className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)}>
      {children}
    </Component>
  );
}
