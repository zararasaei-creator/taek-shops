-- AlterTable
ALTER TABLE "ProductImageUpload" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "finalKey" TEXT;

-- CreateIndex
CREATE INDEX "ProductImageUpload_claimedAt_idx" ON "ProductImageUpload"("claimedAt");
