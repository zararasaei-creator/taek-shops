// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const createImageUploadSlotAction = vi.fn();
const finalizeImageUploadAction = vi.fn();
vi.mock("@/app/admin/catalog/actions", () => ({
  createImageUploadSlotAction: (...args: unknown[]) => createImageUploadSlotAction(...args),
  finalizeImageUploadAction: (...args: unknown[]) => finalizeImageUploadAction(...args),
  removeImageAction: vi.fn(),
  reorderImagesAction: vi.fn(),
  updateImageAction: vi.fn(),
}));

import { ImagePanel } from "@/app/admin/catalog/products/[id]/image-panel";

/**
 * Regression for the actual failure behind the Phase 9 manual-review report
 * ("Images (0)", "No images yet.", "Choose File: No file chosen", no
 * visible error). The real bug was CSP blocking the presigned PUT (fixed in
 * `src/proxy.ts` — see `tests/unit/csp.test.ts`), but the reason it was
 * invisible in the UI is a separate, still-worth-fixing defect this test
 * targets directly: `handleFileSelected` had a `try/finally` with no
 * `catch`, so ANY thrown error — not just this one — became a silent
 * unhandled promise rejection while `finally` quietly reset the busy/file
 * state. This proves that class of bug is now closed, independent of what
 * causes the throw.
 */
function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ImagePanel — an upload failure is always visible, never a silent reset", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("shows an error when the presigned PUT throws (e.g. blocked by CSP) instead of silently resetting with no feedback", async () => {
    createImageUploadSlotAction.mockResolvedValue({
      ok: true,
      slot: {
        uploadId: "up1",
        signedUpload: {
          url: "http://minio.local/put",
          method: "PUT",
          headers: { "Content-Type": "image/png" },
        },
      },
    });
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const { container } = render(<ImagePanel productId="p1" images={[]} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" });

    selectFile(input, file);

    // The error is visible — this is the assertion that fails against the
    // pre-fix code (an unhandled rejection, no `role="alert"` ever renders).
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch");
    });

    // Finalize is never reached — the PUT never succeeded.
    expect(finalizeImageUploadAction).not.toHaveBeenCalled();
    // The busy/file-input state still resets cleanly (no stuck spinner).
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    expect(input.value).toBe("");
  });

  it("still shows the server-reported error for a normal {ok:false} rejection (unaffected by the new catch)", async () => {
    createImageUploadSlotAction.mockResolvedValue({
      ok: false,
      error: "Unsupported image type. Use JPEG, PNG, WebP, AVIF or GIF.",
    });

    const { container } = render(<ImagePanel productId="p1" images={[]} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" });

    selectFile(input, file);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unsupported image type. Use JPEG, PNG, WebP, AVIF or GIF.",
      );
    });
  });
});
