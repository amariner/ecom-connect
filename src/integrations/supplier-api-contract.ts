/**
 * Offline normalization of the supplied "Documentacion API.pdf" (8 pages).
 * No transport, credentials, dispatch or store price policy belongs here.
 * The supplier has not confirmed currency, tax inclusion or remote idempotency.
 */
export class SupplierContractError extends Error {
  constructor(public readonly field: string, reason: string) {
    // Do not echo a remote response: it can contain credentials or personal data.
    super(`Contrato del proveedor inválido en ${field}: ${reason}.`);
    this.name = 'SupplierContractError';
  }
}

type JsonObject = Record<string, unknown>;
const own = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SupplierContractError(field, 'se esperaba un objeto');
  }
  return value as JsonObject;
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new SupplierContractError(field, 'se esperaba texto válido');
  }
  return value.trim();
}

function optionalText(value: JsonObject, key: string): string | null {
  return own(value, key) ? text(value[key], key, true) : null;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new SupplierContractError(field, 'se esperaba una lista');
  return value as unknown[];
}

function envelope(value: unknown): JsonObject {
  const result = object(value, 'respuesta');
  if (result['status'] !== 'OK') {
    throw new SupplierContractError('status', 'la respuesta no confirma éxito');
  }
  text(result['message'], 'message', true);
  return result;
}

function decimalText(value: unknown, field: string, signed = false): string {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  const pattern = signed ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(candidate)) {
    throw new SupplierContractError(field, 'se esperaba un decimal sin separador de miles');
  }
  return candidate;
}

/** Exact decimal conversion; unknown rounding policies are never guessed. */
export function supplierAmountToCents(value: unknown, field = 'importe'): number {
  const decimal = decimalText(value, field);
  const [whole = '', fraction = ''] = decimal.split('.');
  if (fraction.length > 2) {
    throw new SupplierContractError(field, 'más de dos decimales sin política de redondeo confirmada');
  }
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SupplierContractError(field, 'importe fuera del rango entero seguro');
  }
  return Number(cents);
}

function quantity(value: unknown, field: string): number {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(candidate)) {
    throw new SupplierContractError(field, 'se esperaba una cantidad entera no negativa');
  }
  const result = Number(candidate);
  if (!Number.isSafeInteger(result)) {
    throw new SupplierContractError(field, 'cantidad fuera del rango entero seguro');
  }
  return result;
}

function unique<T>(values: T[], key: (value: T) => string, field: string): T[] {
  if (new Set(values.map(key)).size !== values.length) {
    throw new SupplierContractError(field, 'identificadores duplicados');
  }
  return values;
}

/** Preserve supplied identifiers. This does not select, repair or certify a GTIN. */
export function splitSupplierBarcodes(value: unknown): string[] {
  return [...new Set(text(value, 'codigobarra', true).split(',').map((code) => code.trim()).filter(Boolean))];
}

export type SupplierCatalogRecord = {
  code: string;
  description: string;
  supplierPriceCents: number;
  supplierPvpCents: number;
  discount: string | null;
  vat: string | null;
  brand: string | null;
  categories: (string | null)[];
  madeToOrder: string | null;
  indications: string | null;
  dosage: string | null;
  composition: string | null;
  contraindications: string | null;
  image: string | null;
  laboratoryStockout: string | null;
  obsoleteCode: string | null;
  barcodes: string[] | null;
};

/** The external prices remain supplier data, never an automatic store selling price. */
export function normalizeSupplierCatalogResponse(value: unknown): {
  records: SupplierCatalogRecord[];
  totalArticles: number;
} {
  const response = envelope(value);
  const records = unique(list(response['articulos'], 'articulos').map((raw) => {
    const item = object(raw, 'articulos[]');
    return {
      code: text(item['codigo'], 'codigo'),
      description: text(item['descripcion'], 'descripcion'),
      supplierPriceCents: supplierAmountToCents(item['precio'], 'precio'),
      supplierPvpCents: supplierAmountToCents(item['pvp'], 'pvp'),
      discount: own(item, 'descuento') ? decimalText(item['descuento'], 'descuento', true) : null,
      vat: own(item, 'iva') ? decimalText(item['iva'], 'iva') : null,
      brand: optionalText(item, 'marca'),
      categories: ['categoria1', 'categoria2', 'categoria3'].map((key) => optionalText(item, key)),
      madeToOrder: optionalText(item, 'encargo'),
      indications: optionalText(item, 'indicaciones'),
      dosage: optionalText(item, 'posologia'),
      composition: optionalText(item, 'composicion'),
      contraindications: optionalText(item, 'contraindicaciones'),
      image: optionalText(item, 'imagen'),
      laboratoryStockout: optionalText(item, 'roturastocklab'),
      obsoleteCode: optionalText(item, 'codigoobsoleto'),
      barcodes: own(item, 'codigobarra') ? splitSupplierBarcodes(item['codigobarra']) : null,
    };
  }), (item) => item.code, 'articulos.codigo');
  const totalArticles = quantity(response['numtotalarticulos'], 'numtotalarticulos');
  if (records.length > totalArticles) {
    throw new SupplierContractError('numtotalarticulos', 'total inferior al número de registros del bloque');
  }
  return { records, totalArticles };
}

export type SupplierStockRecord = {
  code: string;
  stock: number;
  backupStock: number | null;
  stockLabel: string | null;
  backupStockLabel: string | null;
  laboratoryStockout: string | null;
  estimatedWorkingDays: number | null;
};

/**
 * Missing codes are reported separately; only a verified complete snapshot may
 * justify zeroing them. A transport failure must never be passed as an empty OK.
 */
export function normalizeSupplierStockResponse(value: unknown, options: {
  scope: 'available-only' | 'requested';
  expectedCodes?: readonly string[];
}): { records: SupplierStockRecord[]; missingCodes: string[]; scope: 'available-only' | 'requested' } {
  const response = envelope(value);
  const expectedCodes = options.expectedCodes === undefined
    ? undefined
    : unique(options.expectedCodes.map((code) => text(code, 'expectedCodes[]')), (code) => code, 'expectedCodes');
  const records = unique(list(response['articulos'], 'articulos').map((raw) => {
    const item = object(raw, 'articulos[]');
    const code = text(item['codigo'], 'codigo');
    const hasStock = own(item, 'stocknum');
    const hasAlias = own(item, 'stockum');
    if (!hasStock && !hasAlias) throw new SupplierContractError('stocknum', 'cantidad principal ausente');
    const stock = quantity(hasStock ? item['stocknum'] : item['stockum'], hasStock ? 'stocknum' : 'stockum');
    if (hasStock && hasAlias && stock !== quantity(item['stockum'], 'stockum')) {
      throw new SupplierContractError('stockum', 'el alias contradice stocknum');
    }
    if (options.scope === 'requested' && expectedCodes !== undefined && !expectedCodes.includes(code)) {
      throw new SupplierContractError('codigo', 'respuesta fuera del conjunto solicitado');
    }
    return {
      code,
      stock,
      backupStock: own(item, 'stockbackupnum') ? quantity(item['stockbackupnum'], 'stockbackupnum') : null,
      stockLabel: optionalText(item, 'stock'),
      backupStockLabel: optionalText(item, 'stockbackup'),
      laboratoryStockout: optionalText(item, 'roturastocklab'),
      estimatedWorkingDays: own(item, 'diaslaboentest') ? quantity(item['diaslaboentest'], 'diaslaboentest') : null,
    };
  }), (item) => item.code, 'articulos.codigo');
  const presentCodes = new Set(records.map((item) => item.code));
  return { records, missingCodes: (expectedCodes ?? []).filter((code) => !presentCodes.has(code)), scope: options.scope };
}

const ORDER_SUFFIXES = ['', '2', '3'] as const;

function orderGroups(response: JsonObject, fields: readonly string[]): string[] {
  // The PDF illustrates three groups but does not guarantee a maximum.
  // Reject unsupported groups explicitly instead of silently losing an order.
  for (const key of Object.keys(response)) {
    for (const field of fields) {
      if (key.startsWith(field) && /^\d+$/.test(key.slice(field.length)) &&
        !ORDER_SUFFIXES.some((suffix) => key === `${field}${suffix}`)) {
        throw new SupplierContractError(field, 'grupo ERP adicional sin contrato confirmado');
      }
    }
  }
  const suffixes = ORDER_SUFFIXES.filter((suffix) => fields.some((field) => own(response, `${field}${suffix}`)));
  if (suffixes.length === 0 || suffixes[0] !== '') {
    throw new SupplierContractError('pedidoerp', 'falta el primer pedido ERP');
  }
  return [...suffixes];
}

export function normalizeSupplierOrderCreation(value: unknown): {
  orders: { erpOrderId: string; lineCount: number }[];
} {
  const response = envelope(value);
  const orders = orderGroups(response, ['pedidoerp', 'numlineas']).map((suffix) => ({
    erpOrderId: text(response[`pedidoerp${suffix}`], `pedidoerp${suffix}`),
    lineCount: quantity(response[`numlineas${suffix}`], `numlineas${suffix}`),
  }));
  return { orders: unique(orders, (order) => order.erpOrderId, 'pedidoerp') };
}

export type SupplierProductionState = 'V' | 'S' | 'P' | 'E';
export type SupplierProductionStatus = 'pending' | 'complete' | 'partial' | 'error';
const PRODUCTION_STATUSES: Record<SupplierProductionState, SupplierProductionStatus> = {
  V: 'pending', S: 'complete', P: 'partial', E: 'error',
};

function productionState(value: unknown, field: string): SupplierProductionState {
  if (value !== 'V' && value !== 'S' && value !== 'P' && value !== 'E') {
    throw new SupplierContractError(field, 'estado de producción no documentado');
  }
  return value;
}

export type SupplierProductionLine = {
  code: string;
  description: string;
  state: SupplierProductionState;
  productionStatus: SupplierProductionStatus;
  requestedQuantity: number;
  producedQuantity: number;
  deliveryNote: string | null;
  expeditionNumber: string | null;
};
export type SupplierProductionOrder = {
  reference: string;
  erpOrderId: string;
  state: SupplierProductionState;
  productionStatus: SupplierProductionStatus;
  lines: SupplierProductionLine[];
};

/** `S` means produced. This contract supplies no shipped/delivered state. */
export function normalizeSupplierOrderStatus(value: unknown, expectedReference?: string): {
  orders: SupplierProductionOrder[];
} {
  const response = envelope(value);
  const orders = orderGroups(response, ['pedidocliente', 'pedidoerp', 'estado', 'lineas']).map((suffix) => {
    const reference = text(response[`pedidocliente${suffix}`], `pedidocliente${suffix}`);
    if (expectedReference !== undefined && reference !== expectedReference) {
      throw new SupplierContractError('pedidocliente', 'referencia distinta de la solicitada');
    }
    const state = productionState(response[`estado${suffix}`], `estado${suffix}`);
    const lines = list(response[`lineas${suffix}`], `lineas${suffix}`).map((raw) => {
      const item = object(raw, 'lineas[]');
      const lineState = productionState(item['estado'], 'lineas.estado');
      const requestedQuantity = quantity(item['canped'], 'canped');
      const producedQuantity = quantity(item['canser'], 'canser');
      if (producedQuantity > requestedQuantity) {
        throw new SupplierContractError('canser', 'cantidad producida superior a la pedida');
      }
      return {
        code: text(item['codigo'], 'codigo'),
        description: text(item['descripcion'], 'descripcion'),
        state: lineState,
        productionStatus: PRODUCTION_STATUSES[lineState],
        requestedQuantity,
        producedQuantity,
        deliveryNote: optionalText(item, 'albaran') || null,
        expeditionNumber: optionalText(item, 'numexp') || null,
      };
    });
    return {
      reference,
      erpOrderId: text(response[`pedidoerp${suffix}`], `pedidoerp${suffix}`),
      state,
      productionStatus: PRODUCTION_STATUSES[state],
      lines,
    };
  });
  if (new Set(orders.map((order) => order.reference)).size !== 1) {
    throw new SupplierContractError('pedidocliente', 'los grupos mezclan referencias de cliente');
  }
  return { orders: unique(orders, (order) => order.erpOrderId, 'pedidoerp') };
}
