/**
 * Offline payload builder for CustomDevProduct in Lighthouse's public OpenAPI 1.0.
 * Source: https://app.lighthousefeed.com/api/help/versions/1.0/document.json
 * No HTTP client or connection to the demo composition is enabled here.
 */
export type LighthouseExtraInfoInput = {
  gId: string;
  stock: number;
  cmsId?: number;
  cmsVariantId?: number;
  priceCents?: number;
  salePriceCents?: number;
  costPriceCents?: number;
  vatPercent?: number;
};

export type LighthouseProductExtraInfo = {
  id: string;
  stock: number;
  cmsID?: number;
  cmsSubID?: number;
  price?: number;
  salePrice?: number;
  costPrice?: number;
  taxRate?: number;
};

export class LighthouseContractError extends Error {
  constructor(public readonly field: string, reason: string) {
    super(`Contrato de Lighthouse inválido en ${field}: ${reason}.`);
    this.name = 'LighthouseContractError';
  }
}

const MAX_BATCH_SIZE = 1000;
const MAX_STOCK = 2147483647;
const INPUT_FIELDS = new Set(['gId', 'stock', 'cmsId', 'cmsVariantId', 'priceCents', 'salePriceCents', 'costPriceCents', 'vatPercent']);

function safeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new LighthouseContractError(field, 'se esperaba un entero no negativo dentro del rango permitido');
  }
  return value;
}

function centsToWireNumber(value: unknown, field: string): number {
  const cents = BigInt(safeInteger(value, field));
  const decimal = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  const wireNumber = Number(decimal);
  // OpenAPI requires a JSON number (double), not a quoted monetary amount.
  // Check the serialized decimal, because large doubles can lose a cent.
  const serialized = JSON.stringify(wireNumber);
  const [whole = '', fraction = ''] = serialized.split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction) ||
      BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) !== cents) {
    throw new LighthouseContractError(field, 'el importe pierde céntimos al serializarse como número JSON');
  }
  return wireNumber;
}

/**
 * Build the documented array body from local data already validated commercially.
 * Stock is always required: Lighthouse defaults an omitted stock to zero.
 * Optional fields are omitted to preserve remote values; null semantics are not
 * inferred. gId must be the feed's existing gID, never a supplier or database ID.
 */
export function buildLighthouseProductsExtraInfo(input: unknown): LighthouseProductExtraInfo[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_BATCH_SIZE) {
    throw new LighthouseContractError('productos', 'se requiere un lote de 1 a 1000 productos');
  }
  const identifiers = new Set<string>();
  return (input as unknown[]).map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new LighthouseContractError('producto', 'se esperaba un objeto');
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !INPUT_FIELDS.has(key))) {
      throw new LighthouseContractError('producto', 'contiene campos locales no reconocidos');
    }
    const id = item['gId'];
    if (typeof id !== 'string' || id.length === 0 || id !== id.trim()) {
      throw new LighthouseContractError('gId', 'se requiere el identificador textual exacto del feed');
    }
    if (identifiers.has(id)) throw new LighthouseContractError('gId', 'identificador repetido en el lote');
    identifiers.add(id);
    const payload: LighthouseProductExtraInfo = { id, stock: safeInteger(item['stock'], 'stock', MAX_STOCK) };
    if (item['cmsId'] !== undefined) payload.cmsID = safeInteger(item['cmsId'], 'cmsId');
    if (item['cmsVariantId'] !== undefined) payload.cmsSubID = safeInteger(item['cmsVariantId'], 'cmsVariantId');
    if (item['priceCents'] !== undefined) payload.price = centsToWireNumber(item['priceCents'], 'priceCents');
    if (item['costPriceCents'] !== undefined) payload.costPrice = centsToWireNumber(item['costPriceCents'], 'costPriceCents');
    if (item['salePriceCents'] !== undefined) {
      if (item['priceCents'] === undefined) {
        throw new LighthouseContractError('salePriceCents', 'Lighthouse solo considera la oferta cuando se envía el precio');
      }
      payload.salePrice = centsToWireNumber(item['salePriceCents'], 'salePriceCents');
    }
    if (item['vatPercent'] !== undefined) {
      const percent = safeInteger(item['vatPercent'], 'vatPercent', 100);
      payload.taxRate = percent / 100;
    }
    return payload;
  });
}
