import { createCompatibleCatalogReader, type CatalogReadMode } from './application/catalog-reader';
import { createProductAdminService } from './application/product-admin';
import { createD1CatalogRepository } from './infrastructure/d1-catalog-repository';
import { createD1LegacyCatalogReader } from './infrastructure/d1-legacy-catalog-reader';
import { createD1ProductAdminRepository } from './infrastructure/d1-product-admin';

export type {
  ProductAdminPage,
  ProductAdminQuery,
  ProductAdminRow,
  AttributeDefinitionAdminRow,
  AttributeValueType,
  ProductOptionAdminRow,
  ProductOptionSnapshot,
  ProductOptionValueAdminRow,
  ProductOptionValueSnapshot,
  ProductAttributeValueAdminRow,
  ProductMediaAdminRow,
  ProductPatch,
  ProductVariantAdminDetails,
  ProductVariantAdminRow,
} from './application/product-admin';

export {
  CatalogAdminError,
  validateOptionName,
  validateOptionValue,
  validateVariantWrite,
  type CatalogAdminErrorCode,
  type ProductOptionCreate,
  type ProductOptionPatch,
  type ProductOptionValueCreate,
  type ProductOptionValuePatch,
  type ProductVariantCreate,
  type ProductVariantWrite,
} from './application/product-variant-admin';

export {
  attributeValueStorage,
  normalizeAttributeDefinition,
  validateMediaWrite,
  type AttributeDefinitionWrite,
  type AttributeTypedValue,
  type AttributeValueStorage,
  type ProductMediaWrite,
} from './application/product-content-admin';

export {
  CATALOG_READ_MODES,
  CatalogReadConfigurationError,
  CatalogShadowReadMismatchError,
  escapeCatalogSearch,
  isCatalogSortOption,
  projectDefaultVariant,
  resolveCatalogReadMode,
  type CanonicalCatalogRepository,
  type CatalogQuery,
  type CatalogReader,
  type CatalogReadMode,
  type CatalogSortOption,
  type StorefrontProductRow,
} from './application/catalog-reader';

export {
  CatalogInvariantError,
  PRODUCT_VARIANT_STATUSES,
  createCatalogEntry,
  defaultProductVariant,
  optionSignature,
  type CatalogEntry,
  type Product,
  type ProductOptionSelection,
  type ProductVariant,
  type ProductVariantStatus,
} from './domain/product';

export { createD1CatalogRepository } from './infrastructure/d1-catalog-repository';
export {
  catalogAdminErrorResponse,
  catalogAdminMutationResponse,
} from './presentation/admin-http';

export const createCatalogReader = (db: D1Database, mode: CatalogReadMode) =>
  createCompatibleCatalogReader(
    createD1LegacyCatalogReader(db),
    createD1CatalogRepository(db),
    mode,
  );

export const createProductAdmin = (db: D1Database) =>
  createProductAdminService(createD1ProductAdminRepository(db));
