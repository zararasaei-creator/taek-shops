import { cn } from "@/lib/utils/cn";

/**
 * A neutral placeholder for a product with no images yet — never a broken
 * image icon or empty space, and never invents a stand-in photo (Phase 9).
 */
export function ImageWithFallback({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="No image available"
      className={cn(
        "flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-xs text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600",
        className,
      )}
    >
      No image
    </div>
  );
}
