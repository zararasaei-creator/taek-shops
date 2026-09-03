-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "optionSignature" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_optionSignature_key" ON "ProductVariant"("productId", "optionSignature");

