"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  computeCartesianProduct,
  suggestSku,
  type MatrixCombo,
  type MatrixOptionGroup,
} from "@/lib/catalog/variant-matrix";
import { optionSignature } from "@/server/catalog/option-signature";

interface OptionForMatrix {
  id: string;
  name: string;
  values: { id: string; value: string }[];
}

interface VariantMatrixGeneratorProps {
  productId: string;
  productSlug: string;
  options: OptionForMatrix[];
  /** `optionSignature` of every variant the product already has. */
  existingSignatures: string[];
}

interface EditableCell {
  combo: MatrixCombo;
  key: string;
  alreadyExists: boolean;
  sku: string;
  priceCents: string;
  /** True once the admin has hand-edited this row's price — re-previewing then keeps it. */
  priceEdited: boolean;
  active: boolean;
  initialQuantity: string;
}

async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

function centsFromDollars(text: string): number {
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function VariantMatrixGenerator({
  productId,
  productSlug,
  options,
  existingSignatures,
}: VariantMatrixGeneratorProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [basePrice, setBasePrice] = useState("");
  const [cells, setCells] = useState<EditableCell[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const existing = useMemo(() => new Set(existingSignatures), [existingSignatures]);
  const basePriceCents = centsFromDollars(basePrice);
  const hasValidBasePrice = basePriceCents > 0;
  const hasEveryOptionSelected =
    options.length > 0 && options.every((o) => (selected[o.id]?.size ?? 0) > 0);
  // Gate preview on a valid base price too: previewing without one would silently
  // produce rows with an empty Price field and no indication why.
  const canGenerate = hasEveryOptionSelected && hasValidBasePrice;

  function toggleValue(optionId: string, valueId: string) {
    setSelected((prev) => {
      const next = new Set(prev[optionId] ?? []);
      if (next.has(valueId)) next.delete(valueId);
      else next.add(valueId);
      return { ...prev, [optionId]: next };
    });
  }

  function onPreview() {
    setError(null);
    setResult(null);
    const groups: MatrixOptionGroup[] = options.map((o) => ({
      optionId: o.id,
      optionName: o.name,
      values: o.values.filter((v) => selected[o.id]?.has(v.id)),
    }));
    const combos = computeCartesianProduct(groups);
    const priorByKey = new Map((cells ?? []).map((c) => [c.key, c]));
    const baseDollars = basePriceCents ? String(basePriceCents / 100) : "";
    setCells(
      combos.map((combo) => {
        const signature = optionSignature(combo.selections.map((s) => s.valueId));
        const prior = priorByKey.get(signature);
        // Keep a row's price only if the admin hand-edited it; every other row
        // (untouched, or brand-new this preview) takes the current base price.
        const keepPrice = prior?.priceEdited ?? false;
        return {
          combo,
          key: signature,
          alreadyExists: existing.has(signature),
          sku: suggestSku(productSlug, combo.selections),
          priceCents: keepPrice ? prior!.priceCents : baseDollars,
          priceEdited: keepPrice,
          active: true,
          initialQuantity: "0",
        };
      }),
    );
  }

  function updateCell(key: string, patch: Partial<EditableCell>) {
    setCells((prev) =>
      prev
        ? prev.map((c) =>
            c.key === key
              ? { ...c, ...patch, ...("priceCents" in patch ? { priceEdited: true } : {}) }
              : c,
          )
        : prev,
    );
  }

  const pendingCells = (cells ?? []).filter((c) => !c.alreadyExists);
  const skuCounts = new Map<string, number>();
  for (const cell of pendingCells) skuCounts.set(cell.sku, (skuCounts.get(cell.sku) ?? 0) + 1);
  const hasDupeSku = pendingCells.some((c) => (skuCounts.get(c.sku) ?? 0) > 1);
  const hasEmptySku = pendingCells.some((c) => !c.sku.trim());
  const hasInvalidPrice = pendingCells.some((c) => !c.priceCents || Number(c.priceCents) <= 0);

  async function onGenerate() {
    if (pendingCells.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        cells: pendingCells.map((c) => ({
          sku: c.sku.trim(),
          priceCents: centsFromDollars(c.priceCents),
          active: c.active,
          trackInventory: true,
          initialQuantity: Number(c.initialQuantity) || 0,
          position: 0,
          optionSelections: c.combo.selections.map((s) => ({
            option: s.optionName,
            value: s.value,
          })),
        })),
      };
      const response = await fetch(`/api/admin/catalog/products/${productId}/variants/matrix`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": await csrfToken() },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error?.message ?? "Generation failed.");
        return;
      }
      setResult(`Created ${(json.variants as unknown[]).length} variant(s).`);
      setCells(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (options.length === 0) {
    return (
      <p className="mt-3 text-sm text-zinc-500">
        Add at least one option before generating a matrix.
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {options.map((option) => (
          <div key={option.id}>
            <p className="text-sm font-medium">{option.name}</p>
            <div className="mt-1 flex flex-wrap gap-3">
              {option.values.map((value) => (
                <label key={value.id} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={selected[option.id]?.has(value.id) ?? false}
                    onChange={() => toggleValue(option.id, value.id)}
                  />
                  {value.value}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span className="font-medium">Base price (CAD)</span>
        <input
          value={basePrice}
          onChange={(event) => setBasePrice(event.target.value)}
          placeholder="39.99"
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <span className="text-xs text-zinc-500">
          Applied to every generated row; edit rows below.
        </span>
      </label>

      <div>
        <Button type="button" onClick={onPreview} disabled={!canGenerate}>
          Preview matrix
        </Button>
        {!canGenerate ? (
          <span className="ml-3 text-xs text-zinc-500">
            {!hasEveryOptionSelected && !hasValidBasePrice
              ? "Select at least one value for every option above and enter a base price."
              : !hasEveryOptionSelected
                ? "Select at least one value for every option above."
                : "Enter a base price above."}
          </span>
        ) : null}
      </div>

      {cells && cells.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-3">Combination</th>
                <th className="py-1 pr-3">SKU</th>
                <th className="py-1 pr-3">Price (CAD)</th>
                <th className="py-1 pr-3">Initial stock</th>
                <th className="py-1 pr-3">Active</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell) => (
                <tr
                  key={cell.key}
                  className={`border-t border-zinc-100 dark:border-zinc-900 ${cell.alreadyExists ? "opacity-50" : ""}`}
                >
                  <td className="py-1 pr-3">
                    {cell.combo.selections.map((s) => s.value).join(" / ")}
                    {cell.alreadyExists ? (
                      <span className="ml-2 text-amber-700">already exists</span>
                    ) : null}
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      value={cell.sku}
                      disabled={cell.alreadyExists}
                      onChange={(event) => updateCell(cell.key, { sku: event.target.value })}
                      className="w-36 rounded border border-zinc-300 px-1 py-0.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      value={cell.priceCents}
                      disabled={cell.alreadyExists}
                      onChange={(event) => updateCell(cell.key, { priceCents: event.target.value })}
                      className="w-20 rounded border border-zinc-300 px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      value={cell.initialQuantity}
                      disabled={cell.alreadyExists}
                      onChange={(event) =>
                        updateCell(cell.key, { initialQuantity: event.target.value })
                      }
                      className="w-16 rounded border border-zinc-300 px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      checked={cell.active}
                      disabled={cell.alreadyExists}
                      onChange={(event) => updateCell(cell.key, { active: event.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex items-center gap-3">
            <Button
              type="button"
              onClick={onGenerate}
              disabled={
                busy || pendingCells.length === 0 || hasDupeSku || hasEmptySku || hasInvalidPrice
              }
            >
              {busy ? "Working…" : `Create ${pendingCells.length} variant(s)`}
            </Button>
            {hasDupeSku ? <span className="text-red-600">Duplicate SKUs below.</span> : null}
            {hasEmptySku ? <span className="text-red-600">Every row needs a SKU.</span> : null}
            {hasInvalidPrice ? (
              <span className="text-red-600">Every row needs a price.</span>
            ) : null}
          </div>
        </div>
      ) : cells ? (
        <p className="text-sm text-zinc-500">
          Every combination of the selected values already exists as a variant.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-sm text-green-700">
          {result}
        </p>
      ) : null}
    </div>
  );
}
