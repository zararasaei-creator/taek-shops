import type { Prisma } from "@prisma/client";

/** Prisma interactive-transaction client, shared by catalogue services. */
export type CatalogTxClient = Prisma.TransactionClient;
