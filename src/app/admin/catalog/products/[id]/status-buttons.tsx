"use client";

import { useState, useTransition } from "react";
import { ProductStatus } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { changeProductStatusAction } from "@/app/admin/catalog/actions";

const TARGETS: Record<ProductStatus, { label: string; to: ProductStatus }[]> = {
  DRAFT: [
    { label: "Publish", to: ProductStatus.ACTIVE },
    { label: "Archive", to: ProductStatus.ARCHIVED },
  ],
  ACTIVE: [
    { label: "Unpublish", to: ProductStatus.DRAFT },
    { label: "Archive", to: ProductStatus.ARCHIVED },
  ],
  ARCHIVED: [
    { label: "Restore to draft", to: ProductStatus.DRAFT },
    { label: "Publish", to: ProductStatus.ACTIVE },
  ],
};

export function StatusButtons({ productId, status }: { productId: string; status: ProductStatus }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {TARGETS[status].map((target) => (
          <Button
            key={target.to}
            variant="secondary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await changeProductStatusAction(productId, target.to);
                if (!result.ok) setError(result.error);
              })
            }
          >
            {target.label}
          </Button>
        ))}
      </div>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
