-- CreateTable
CREATE TABLE "ProductImageUpload" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "storageKey" TEXT NOT NULL,
    "claimedContentType" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImageUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductImageUpload_storageKey_key" ON "ProductImageUpload"("storageKey");

-- CreateIndex
CREATE INDEX "ProductImageUpload_productId_idx" ON "ProductImageUpload"("productId");

-- CreateIndex
CREATE INDEX "ProductImageUpload_createdAt_idx" ON "ProductImageUpload"("createdAt");

-- AddForeignKey
ALTER TABLE "ProductImageUpload" ADD CONSTRAINT "ProductImageUpload_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageUpload" ADD CONSTRAINT "ProductImageUpload_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageUpload" ADD CONSTRAINT "ProductImageUpload_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
