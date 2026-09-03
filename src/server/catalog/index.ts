/**
 * Public catalogue surface. Import from `@/server/catalog` rather than reaching
 * into individual service files.
 */
export * from "@/server/catalog/errors";
export * from "@/server/catalog/slug";
export { optionSignature } from "@/server/catalog/option-signature";

export * as brands from "@/server/catalog/brand-service";
export * as categories from "@/server/catalog/category-service";
export * as products from "@/server/catalog/product-service";
export * as variants from "@/server/catalog/variant-service";
export * as options from "@/server/catalog/option-service";
export * as images from "@/server/catalog/image-service";

export {
  listPublicProducts,
  getPublicProductBySlug,
  type PublicProduct,
  type PublicCatalogQuery,
} from "@/server/catalog/catalog-queries";
