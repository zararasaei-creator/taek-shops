"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  createImageUploadSlotAction,
  finalizeImageUploadAction,
  removeImageAction,
  reorderImagesAction,
  updateImageAction,
} from "@/app/admin/catalog/actions";

export interface ImageRow {
  id: string;
  resolvedUrl: string;
  altText: string | null;
  isPrimary: boolean;
}

interface ImagePanelProps {
  productId: string;
  images: ImageRow[];
}

// Client-side hints only — never authoritative. The server always re-checks
// via `sniffImageFormat` against the real bytes before anything is stored.
const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,image/avif,image/gif";
const MAX_BYTES = 5_000_000;

/** Same double-submit CSRF pattern as `import-runner.tsx`'s hand-written fetch. */
async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

export function ImagePanel({ productId, images }: ImagePanelProps) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected() {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setError(null);

    if (file.size <= 0 || file.size > MAX_BYTES) {
      setError("Image must be between 1 byte and 5 MB.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setBusy(true);
    try {
      const slotResult = await createImageUploadSlotAction(productId, {
        contentType: file.type || "application/octet-stream",
        byteSize: file.size,
      });
      if (!slotResult.ok) {
        setError(slotResult.error);
        return;
      }

      const { slot } = slotResult;
      if (slot.signedUpload && slot.uploadId) {
        // S3-compatible backend: upload goes straight to storage, never
        // through this server. Staged/private until finalize verifies it.
        const putResponse = await fetch(slot.signedUpload.url, {
          method: slot.signedUpload.method,
          headers: slot.signedUpload.headers,
          body: file,
        });
        if (!putResponse.ok) {
          setError("Upload to storage failed. Please try again.");
          return;
        }
        const finalizeResult = await finalizeImageUploadAction(productId, slot.uploadId, {
          isPrimary: images.length === 0,
        });
        if (!finalizeResult.ok) {
          setError(finalizeResult.error);
          return;
        }
      } else {
        // Local-filesystem backend: single-step server-proxy upload — the
        // server validates the real bytes and stores + attaches in one call.
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(`/api/admin/catalog/products/${productId}/images`, {
          method: "POST",
          headers: { "x-csrf-token": await csrfToken() },
          body: form,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(body?.error?.message ?? "Upload failed.");
          return;
        }
      }

      router.refresh();
    } catch (err) {
      // Anything that THROWS rather than resolving to `{ ok: false }` —
      // a network failure, a CSP-blocked cross-origin request, or any
      // other unexpected error — must still end up visible here. Without
      // this catch, such an error becomes a silent unhandled promise
      // rejection: `finally` below still resets the busy/file-input state,
      // so the UI would quietly return to "No file chosen" with nothing
      // to explain why nothing happened (the actual failure mode behind a
      // real CSP gap found during the Phase 9 manual review — see
      // `src/proxy.ts`'s `connect-src`/`img-src` comment).
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleAltTextBlur(imageId: string, value: string) {
    const result = await updateImageAction(productId, imageId, { altText: value });
    if (!result.ok) setError(result.error);
    else router.refresh();
  }

  async function handleSetPrimary(imageId: string) {
    setBusy(true);
    const result = await updateImageAction(productId, imageId, { isPrimary: true });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else router.refresh();
  }

  async function handleRemove(imageId: string) {
    setBusy(true);
    const result = await removeImageAction(productId, imageId);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else router.refresh();
  }

  async function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    const reordered = [...images];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    setBusy(true);
    const result = await reorderImagesAction(
      productId,
      reordered.map((i) => i.id),
    );
    setBusy(false);
    if (!result.ok) setError(result.error);
    else router.refresh();
  }

  return (
    <div className="mt-2 flex flex-col gap-4">
      {images.length === 0 ? (
        <p className="text-sm text-zinc-500">No images yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-4">
          {images.map((image, index) => (
            <li
              key={image.id}
              className="flex w-40 flex-col gap-2 rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.resolvedUrl}
                alt={image.altText ?? ""}
                className="h-32 w-full rounded object-cover"
              />
              <input
                type="text"
                defaultValue={image.altText ?? ""}
                placeholder="Alt text"
                disabled={busy}
                onBlur={(e) => handleAltTextBlur(image.id, e.target.value)}
                className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
              <div className="flex items-center justify-between gap-1">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => handleMove(index, -1)}
                  className="rounded border border-zinc-300 px-1.5 py-0.5 disabled:opacity-30 dark:border-zinc-700"
                  aria-label="Move earlier"
                >
                  ←
                </button>
                {image.isPrimary ? (
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">primary</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSetPrimary(image.id)}
                    className="text-blue-600 disabled:opacity-30"
                  >
                    make primary
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || index === images.length - 1}
                  onClick={() => handleMove(index, 1)}
                  className="rounded border border-zinc-300 px-1.5 py-0.5 disabled:opacity-30 dark:border-zinc-700"
                  aria-label="Move later"
                >
                  →
                </button>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleRemove(image.id)}
                className="text-red-600 disabled:opacity-30"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_TYPES}
          disabled={busy}
          onChange={handleFileSelected}
          className="text-sm"
        />
        {busy ? <span className="text-xs text-zinc-500">Working…</span> : null}
      </div>
      <p className="text-xs text-zinc-500">JPEG, PNG, WebP, AVIF, or GIF — up to 5 MB. SVG is not accepted.</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
