"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

interface PreviewRow {
  rowNumber: number;
  sku: string | null;
  action: "create" | "update" | "error";
  errors: { column: string | null; message: string }[];
  warnings: string[];
  summary: string;
}
interface Preview {
  importJobId: string;
  filename: string;
  totalRows: number;
  counts: { create: number; update: number; error: number };
  fileWarnings: string[];
  rows: PreviewRow[];
}
interface CommitResult {
  status: string;
  counts: { created: number; updated: number; skipped: number; failed: number };
  failedRows: { rowNumber: number; sku: string | null; errors: { message: string }[] }[];
}

async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

export function ImportRunner() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);

  async function onPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setCommitted(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/admin/import/products/preview", {
        method: "POST",
        headers: { "x-csrf-token": await csrfToken() },
        body,
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error?.message ?? "Preview failed.");
        setPreview(null);
        return;
      }
      setPreview(json as Preview);
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/import/products/commit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() },
        body: JSON.stringify({ importJobId: preview.importJobId }),
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error?.message ?? "Commit failed.");
        return;
      }
      setCommitted(json as CommitResult);
      setPreview(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <form onSubmit={onPreview} className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          required
          className="text-sm"
          aria-label="CSV file"
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : "Preview (dry-run)"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm">
            <strong>{preview.filename}</strong> — {preview.totalRows} rows ·{" "}
            <span className="text-green-700">{preview.counts.create} create</span> ·{" "}
            <span className="text-blue-700">{preview.counts.update} update</span> ·{" "}
            <span className="text-red-600">{preview.counts.error} error</span>
          </p>
          {preview.fileWarnings.map((warning) => (
            <p key={warning} className="mt-1 text-xs text-amber-700">
              {warning}
            </p>
          ))}
          <div className="mt-3 max-h-72 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="pr-3">Row</th>
                  <th className="pr-3">SKU</th>
                  <th className="pr-3">Action</th>
                  <th className="pr-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="pr-3 align-top">{row.rowNumber}</td>
                    <td className="pr-3 align-top font-mono">{row.sku ?? "—"}</td>
                    <td
                      className={`pr-3 align-top ${
                        row.action === "error" ? "text-red-600" : "text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {row.action}
                    </td>
                    <td className="pr-3 align-top">
                      {row.action === "error"
                        ? row.errors.map((e, i) => (
                            <div key={i}>
                              {e.column ? `${e.column}: ` : ""}
                              {e.message}
                            </div>
                          ))
                        : row.summary}
                      {row.warnings.map((w) => (
                        <div key={w} className="text-amber-700">
                          {w}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={onCommit}
              disabled={busy || preview.counts.create + preview.counts.update === 0}
            >
              Commit {preview.counts.create + preview.counts.update} row(s)
            </Button>
            <span className="text-xs text-zinc-500">Rows with errors are skipped.</span>
          </div>
        </div>
      ) : null}

      {committed ? (
        <div className="mt-5 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          Import {committed.status.toLowerCase()}: {committed.counts.created} created,{" "}
          {committed.counts.updated} updated, {committed.counts.skipped} unchanged,{" "}
          {committed.counts.failed} failed.
          {committed.failedRows.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {committed.failedRows.map((row) => (
                <li key={row.rowNumber}>
                  Row {row.rowNumber} ({row.sku ?? "—"}):{" "}
                  {row.errors.map((e) => e.message).join("; ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
