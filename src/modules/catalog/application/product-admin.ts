export type ProductAdminRow = Readonly<{
  id: number;
  slug: string;
  name: string;
  image: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  stock: number;
  category: string;
  collection: string;
  active: number;
  default_variant_id: number | null;
  default_sku: string | null;
  default_gtin: string | null;
  default_mpn: string | null;
  default_variant_title: string | null;
  default_variant_status: 'draft' | 'active' | 'archived' | null;
  default_variant_price_cents: number | null;
  default_variant_compare_at_price_cents: number | null;
  variant_count: number;
}>;

export type ProductAdminQuery = Readonly<{
  search?: string | undefined;
  category?: string | undefined;
  status?: 'active' | 'hidden' | undefined;
  limit: number;
  offset?: number | undefined;
}>;

export type ProductAdminPage = Readonly<{
  products: readonly ProductAdminRow[];
  total: number;
  categories: readonly string[];
}>;

export type ProductPatch = Readonly<{
  name?: string | undefined;
  price_cents?: number | undefined;
  stock?: number | undefined;
  active?: boolean | undefined;
  compare_at_price_cents?: number | null | undefined;
  sku?: string | undefined;
  gtin?: string | null | undefined;
  mpn?: string | null | undefined;
  variant_title?: string | undefined;
  variant_status?: 'draft' | 'active' | 'archived' | undefined;
}>;

export type ProductOptionValueAdminRow = Readonly<{
  id: number;
  option_id: number;
  value: string;
  position: number;
}>;

export type ProductOptionAdminRow = Readonly<{
  id: number;
  product_id: number;
  name: string;
  position: number;
  values: readonly ProductOptionValueAdminRow[];
}>;

export type ProductVariantAdminRow = Readonly<{
  id: number;
  product_id: number;
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: 'draft' | 'active' | 'archived';
  is_default: boolean;
  option_signature: string | null;
  option_value_ids: readonly number[];
  order_item_count: number;
  inventory_on_hand: number;
  inventory_reserved: number;
  inventory_available: number;
  inventory_version: number;
  created_at: string;
  updated_at: string;
}>;

export type ProductVariantAdminDetails = Readonly<{
  product: ProductAdminRow;
  options: readonly ProductOptionAdminRow[];
  variants: readonly ProductVariantAdminRow[];
  media: readonly ProductMediaAdminRow[];
  attribute_definitions: readonly AttributeDefinitionAdminRow[];
  attribute_values: readonly ProductAttributeValueAdminRow[];
}>;

export type ProductMediaAdminRow = Readonly<{
  id: number;
  product_id: number;
  kind: 'image' | 'video';
  source: string;
  alt_text: string;
  focal_x_bps: number;
  focal_y_bps: number;
  position: number;
  variant_ids: readonly number[];
  created_at: string;
  updated_at: string;
}>;

export type AttributeValueType = 'text' | 'number' | 'boolean' | 'reference' | 'list';

export type AttributeDefinitionAdminRow = Readonly<{
  id: number;
  collection: string;
  category: string;
  code: string;
  label: string;
  value_type: AttributeValueType;
  unit: string | null;
  constraints_json: string;
  position: number;
  active: number;
  value_count: number;
  created_at: string;
  updated_at: string;
}>;

export type ProductAttributeValueAdminRow = Readonly<{
  id: number;
  product_id: number;
  variant_id: number | null;
  attribute_definition_id: number;
  value_text: string | null;
  value_number: number | null;
  value_boolean: number | null;
  value_reference: string | null;
  value_list_json: string | null;
  created_at: string;
  updated_at: string;
}>;

export type ProductOptionSnapshot = Readonly<{
  id: number;
  product_id: number;
  product_slug: string;
  name: string;
  position: number;
  value_count: number;
  variant_count: number;
}>;

export type ProductOptionValueSnapshot = Readonly<{
  id: number;
  option_id: number;
  product_id: number;
  product_slug: string;
  value: string;
  position: number;
  variant_count: number;
}>;

export interface ProductAdminRepository {
  list(): Promise<readonly ProductAdminRow[]>;
  search(query: ProductAdminQuery): Promise<ProductAdminPage>;
  find(id: number): Promise<ProductAdminRow | null>;
  details(id: number): Promise<ProductVariantAdminDetails | null>;
  findOption(id: number): Promise<ProductOptionSnapshot | null>;
  findOptionValue(id: number): Promise<ProductOptionValueSnapshot | null>;
  findVariant(id: number): Promise<ProductVariantAdminRow | null>;
  findMedia(id: number): Promise<ProductMediaAdminRow | null>;
  findAttributeDefinition(id: number): Promise<AttributeDefinitionAdminRow | null>;
  findAttributeValue(id: number): Promise<ProductAttributeValueAdminRow | null>;
}

export function createProductAdminService(repository: ProductAdminRepository) {
  return Object.freeze({
    list: () => repository.list(),
    search: (query: ProductAdminQuery) => repository.search(query),
    find: (id: number) => repository.find(id),
    details: (id: number) => repository.details(id),
    findOption: (id: number) => repository.findOption(id),
    findOptionValue: (id: number) => repository.findOptionValue(id),
    findVariant: (id: number) => repository.findVariant(id),
    findMedia: (id: number) => repository.findMedia(id),
    findAttributeDefinition: (id: number) => repository.findAttributeDefinition(id),
    findAttributeValue: (id: number) => repository.findAttributeValue(id),
  });
}
