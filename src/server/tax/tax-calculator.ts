import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { applyRate } from "@/server/domain/money";

/**
 * Tax boundary (Phase 6).
 *
 * The platform ships **no tax rates**. Rates are operator data in `TaxRegion` /
 * `TaxRate` (seeded with an example Ontario/HST row; production values are
 * entered by the operator — Phase 11 admin UI). `taxCents = round(taxableCents *
 * rate)`, quoted at checkout and frozen onto the order.
 */

export interface TaxableLine {
  /** Stable key echoed back on the result line (e.g. variantId). */
  ref: string;
  /** Amount this line is taxed on (line subtotal − line discount), integer cents. */
  taxableCents: number;
  /** `Product.taxCategory`; `null` / `""` means "standard / everything". */
  taxCategory: string | null;
}

export interface TaxDestination {
  country: string;
  province: string;
}

export interface TaxRateApplied {
  name: string;
  /** The exact fractional rate as a string, e.g. "0.130000". */
  rate: string;
  amountCents: number;
}

export interface TaxLineResult {
  ref: string;
  taxCents: number;
  rates: TaxRateApplied[];
}

export interface TaxQuote {
  /** null when no tax region is configured for the destination. */
  regionName: string | null;
  lines: TaxLineResult[];
  totalCents: number;
}

export interface TaxCalculator {
  quote(lines: TaxableLine[], shipTo: TaxDestination, at?: Date): Promise<TaxQuote>;
}

type Db = Pick<PrismaClient, "taxRegion">;

/**
 * Reads `TaxRegion` (matched on country + province, falling back to a
 * country-wide row with `province = ""`) and its active `TaxRate` rows. Rates
 * apply in `priority` order; a `compound` rate is charged on the running total
 * (base + earlier taxes) rather than the base alone.
 */
export class ConfiguredRateTaxCalculator implements TaxCalculator {
  constructor(private readonly db: Db = prisma) {}

  async quote(
    lines: TaxableLine[],
    shipTo: TaxDestination,
    at: Date = new Date(),
  ): Promise<TaxQuote> {
    const region = await this.db.taxRegion.findFirst({
      where: {
        active: true,
        country: shipTo.country,
        province: { in: [shipTo.province, ""] },
      },
      // Prefer an exact province match over the country-wide fallback.
      orderBy: { province: "desc" },
      select: {
        name: true,
        rates: {
          where: {
            active: true,
            AND: [
              { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }] },
              { OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
            ],
          },
          orderBy: [{ priority: "asc" }, { name: "asc" }],
          select: { name: true, rate: true, taxCategory: true, compound: true },
        },
      },
    });

    if (!region || region.rates.length === 0) {
      return {
        regionName: region?.name ?? null,
        lines: lines.map((l) => ({ ref: l.ref, taxCents: 0, rates: [] })),
        totalCents: 0,
      };
    }

    const resultLines: TaxLineResult[] = lines.map((line) => {
      const applicable = region.rates.filter(
        (r) => r.taxCategory === "" || r.taxCategory === (line.taxCategory ?? ""),
      );

      let running = line.taxableCents;
      let lineTax = 0;
      const applied: TaxRateApplied[] = [];

      for (const r of applicable) {
        const base = r.compound ? running : line.taxableCents;
        const rateNum = Number(r.rate);
        const amount = applyRate(base, rateNum);
        if (amount === 0) continue;
        applied.push({ name: r.name, rate: r.rate.toString(), amountCents: amount });
        lineTax += amount;
        running += amount;
      }

      return { ref: line.ref, taxCents: lineTax, rates: applied };
    });

    return {
      regionName: region.name,
      lines: resultLines,
      totalCents: resultLines.reduce((sum, l) => sum + l.taxCents, 0),
    };
  }
}

/** The active tax calculator. A third-party adapter can be swapped in here. */
export function getTaxCalculator(db: Db = prisma): TaxCalculator {
  return new ConfiguredRateTaxCalculator(db);
}
