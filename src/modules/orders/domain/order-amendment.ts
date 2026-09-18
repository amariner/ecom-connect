export type OrderAmendmentStatus =
  | 'pending_payment'
  | 'pending_refund'
  | 'ready'
  | 'applied'
  | 'expired'
  | 'cancelled'
  | 'requires_review';

export type EditableOrderSnapshot = Readonly<{
  id: number;
  order_number: string;
  email: string;
  status: string;
  edit_version: number;
  address_json: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  currency: string;
}>;

export type EditableOrderLineSnapshot = Readonly<{
  order_item_id: number;
  product_id: number;
  variant_id: number;
  name_snapshot: string;
  sku_snapshot: string;
  variant_name_snapshot: string | null;
  unit_price_cents: number;
  current_quantity: number;
  fulfilled_quantity: number;
  cancelled_quantity: number;
}>;

export type OrderAmendmentVariant = Readonly<{
  product_id: number;
  variant_id: number;
  name: string;
  sku: string;
  variant_name: string | null;
  unit_price_cents: number;
  available_quantity: number;
  active: boolean;
}>;

export type OrderAmendmentLineRequest =
  | Readonly<{ order_item_id: number; quantity: number }>
  | Readonly<{ variant_id: number; quantity: number }>;

export type PlannedOrderAmendmentLine = Readonly<{
  order_item_id: number | null;
  product_id: number;
  variant_id: number;
  name_snapshot: string;
  sku_snapshot: string;
  variant_name_snapshot: string | null;
  unit_price_cents: number;
  quantity_before: number;
  quantity_after: number;
  quantity_delta: number;
  amount_delta_cents: number;
}>;

export type PlannedOrderAmendment = Readonly<{
  order_id: number;
  order_number: string;
  expected_order_version: number;
  currency: string;
  address_before_json: string;
  address_after_json: string;
  address_changed: boolean;
  subtotal_before_cents: number;
  shipping_before_cents: number;
  total_before_cents: number;
  subtotal_after_cents: number;
  shipping_after_cents: number;
  total_after_cents: number;
  delta_cents: number;
  status: Extract<OrderAmendmentStatus, 'pending_payment' | 'pending_refund' | 'ready'>;
  lines: readonly PlannedOrderAmendmentLine[];
  final_lines: readonly Readonly<{
    order_item_id: number | null;
    variant_id: number;
    quantity: number;
  }>[];
  stock_increments: readonly Readonly<{
    product_id: number;
    variant_id: number;
    quantity: number;
  }>[];
  stock_restock: readonly Readonly<{
    product_id: number;
    variant_id: number;
    quantity: number;
  }>[];
}>;

function assertInteger(value: number, field: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${field} debe ser un entero seguro >= ${min}.`);
  }
}

function assertMoney(value: number, field: string): void {
  assertInteger(value, field, 0);
}

function lineRequestKey(line: OrderAmendmentLineRequest): string {
  return 'order_item_id' in line ? `item:${line.order_item_id}` : `variant:${line.variant_id}`;
}

/**
 * Planea una edición exclusivamente desde snapshots servidor. El navegador
 * solo expresa cantidades objetivo y una dirección ya validada por la API.
 */
export function planOrderAmendment(input: Readonly<{
  order: EditableOrderSnapshot;
  lines: readonly EditableOrderLineSnapshot[];
  variants: readonly OrderAmendmentVariant[];
  requestedLines: readonly OrderAmendmentLineRequest[];
  addressAfterJson: string;
  shippingAfterCents: number;
  hasActiveFulfillment: boolean;
  hasActiveAmendment: boolean;
}>): PlannedOrderAmendment {
  const { order } = input;
  if (order.status !== 'paid') throw new RangeError('solo un pedido pagado admite edición.');
  assertInteger(order.edit_version, 'order.edit_version', 1);
  assertMoney(order.subtotal_cents, 'order.subtotal_cents');
  assertMoney(order.shipping_cents, 'order.shipping_cents');
  assertMoney(order.total_cents, 'order.total_cents');
  assertMoney(input.shippingAfterCents, 'shipping_after_cents');
  if (order.total_cents !== order.subtotal_cents + order.shipping_cents) {
    throw new RangeError('los totales actuales del pedido son incoherentes.');
  }
  if (!/^[A-Z]{3}$/.test(order.currency)) throw new RangeError('moneda de pedido inválida.');
  if (input.hasActiveAmendment) throw new RangeError('el pedido ya tiene una edición activa.');

  const existingById = new Map<number, EditableOrderLineSnapshot>();
  const existingByVariant = new Map<number, EditableOrderLineSnapshot>();
  for (const line of input.lines) {
    assertInteger(line.order_item_id, 'line.order_item_id', 1);
    assertInteger(line.product_id, 'line.product_id', 1);
    assertInteger(line.variant_id, 'line.variant_id', 1);
    assertMoney(line.unit_price_cents, 'line.unit_price_cents');
    assertInteger(line.current_quantity, 'line.current_quantity', 0);
    assertInteger(line.fulfilled_quantity, 'line.fulfilled_quantity', 0);
    assertInteger(line.cancelled_quantity, 'line.cancelled_quantity', 0);
    if (line.fulfilled_quantity + line.cancelled_quantity > line.current_quantity) {
      throw new RangeError('una línea tiene más unidades comprometidas que vigentes.');
    }
    if (existingById.has(line.order_item_id) || existingByVariant.has(line.variant_id)) {
      throw new RangeError('las líneas actuales contienen duplicados.');
    }
    existingById.set(line.order_item_id, line);
    existingByVariant.set(line.variant_id, line);
  }

  const variantsById = new Map(input.variants.map((variant) => [variant.variant_id, variant] as const));
  const seen = new Set<string>();
  const targetByItem = new Map<number, number>();
  const targetNewByVariant = new Map<number, number>();
  for (const requested of input.requestedLines) {
    const key = lineRequestKey(requested);
    if (seen.has(key)) throw new RangeError('una línea no puede repetirse.');
    seen.add(key);
    assertInteger(requested.quantity, 'quantity', 0);
    if ('order_item_id' in requested) {
      assertInteger(requested.order_item_id, 'order_item_id', 1);
      if (!existingById.has(requested.order_item_id)) {
        throw new RangeError('la línea no pertenece al pedido.');
      }
      targetByItem.set(requested.order_item_id, requested.quantity);
    } else {
      assertInteger(requested.variant_id, 'variant_id', 1);
      if (existingByVariant.has(requested.variant_id)) {
        throw new RangeError('usa order_item_id para una variante ya presente.');
      }
      const variant = variantsById.get(requested.variant_id);
      if (!variant || !variant.active) throw new RangeError('la variante no está disponible.');
      if (requested.quantity === 0) throw new RangeError('una línea nueva debe tener cantidad positiva.');
      targetNewByVariant.set(requested.variant_id, requested.quantity);
    }
  }

  const changes: PlannedOrderAmendmentLine[] = [];
  const finalLines: PlannedOrderAmendment['final_lines'][number][] = [];
  let subtotalAfter = 0;
  let totalQuantity = 0;

  for (const line of input.lines) {
    const after = targetByItem.get(line.order_item_id) ?? line.current_quantity;
    const committed = line.fulfilled_quantity + line.cancelled_quantity;
    if (after < committed) {
      throw new RangeError('la cantidad no puede bajar de lo enviado y cancelado.');
    }
    const delta = after - line.current_quantity;
    if (delta > 0) {
      const variant = variantsById.get(line.variant_id);
      if (!variant || !variant.active || delta > variant.available_quantity) {
        throw new RangeError('inventario insuficiente para aumentar la línea.');
      }
    }
    const lineTotal = line.unit_price_cents * after;
    assertMoney(lineTotal, 'line_total_cents');
    subtotalAfter += lineTotal;
    assertMoney(subtotalAfter, 'subtotal_after_cents');
    totalQuantity += after;
    assertInteger(totalQuantity, 'total_quantity', 0);
    finalLines.push(Object.freeze({
      order_item_id: line.order_item_id,
      variant_id: line.variant_id,
      quantity: after,
    }));
    if (delta !== 0) {
      changes.push(Object.freeze({
        order_item_id: line.order_item_id,
        product_id: line.product_id,
        variant_id: line.variant_id,
        name_snapshot: line.name_snapshot,
        sku_snapshot: line.sku_snapshot,
        variant_name_snapshot: line.variant_name_snapshot,
        unit_price_cents: line.unit_price_cents,
        quantity_before: line.current_quantity,
        quantity_after: after,
        quantity_delta: delta,
        amount_delta_cents: line.unit_price_cents * delta,
      }));
    }
  }

  for (const [variantId, quantity] of targetNewByVariant) {
    const variant = variantsById.get(variantId)!;
    if (quantity > variant.available_quantity) {
      throw new RangeError('inventario insuficiente para añadir la variante.');
    }
    const lineTotal = variant.unit_price_cents * quantity;
    assertMoney(lineTotal, 'line_total_cents');
    subtotalAfter += lineTotal;
    assertMoney(subtotalAfter, 'subtotal_after_cents');
    totalQuantity += quantity;
    finalLines.push(Object.freeze({ order_item_id: null, variant_id: variantId, quantity }));
    changes.push(Object.freeze({
      order_item_id: null,
      product_id: variant.product_id,
      variant_id: variant.variant_id,
      name_snapshot: variant.name,
      sku_snapshot: variant.sku,
      variant_name_snapshot: variant.variant_name,
      unit_price_cents: variant.unit_price_cents,
      quantity_before: 0,
      quantity_after: quantity,
      quantity_delta: quantity,
      amount_delta_cents: lineTotal,
    }));
  }

  if (totalQuantity < 1) throw new RangeError('el pedido debe conservar al menos una unidad.');
  const addressChanged = order.address_json !== input.addressAfterJson;
  if (addressChanged && input.hasActiveFulfillment) {
    throw new RangeError('la dirección no puede cambiar después de iniciar un envío.');
  }
  if (changes.length === 0 && !addressChanged && input.shippingAfterCents === order.shipping_cents) {
    throw new RangeError('la edición no contiene cambios.');
  }
  const totalAfter = subtotalAfter + input.shippingAfterCents;
  assertMoney(totalAfter, 'total_after_cents');
  const delta = totalAfter - order.total_cents;
  if (!Number.isSafeInteger(delta)) throw new RangeError('delta_cents no es un entero seguro.');

  const stockIncrements = changes
    .filter((line) => line.quantity_delta > 0)
    .map((line) => Object.freeze({
      product_id: line.product_id,
      variant_id: line.variant_id,
      quantity: line.quantity_delta,
    }));
  const stockRestock = changes
    .filter((line) => line.quantity_delta < 0)
    .map((line) => Object.freeze({
      product_id: line.product_id,
      variant_id: line.variant_id,
      quantity: -line.quantity_delta,
    }));

  return Object.freeze({
    order_id: order.id,
    order_number: order.order_number,
    expected_order_version: order.edit_version,
    currency: order.currency,
    address_before_json: order.address_json,
    address_after_json: input.addressAfterJson,
    address_changed: addressChanged,
    subtotal_before_cents: order.subtotal_cents,
    shipping_before_cents: order.shipping_cents,
    total_before_cents: order.total_cents,
    subtotal_after_cents: subtotalAfter,
    shipping_after_cents: input.shippingAfterCents,
    total_after_cents: totalAfter,
    delta_cents: delta,
    status: delta > 0 ? 'pending_payment' : delta < 0 ? 'pending_refund' : 'ready',
    lines: Object.freeze(changes),
    final_lines: Object.freeze(finalLines),
    stock_increments: Object.freeze(stockIncrements),
    stock_restock: Object.freeze(stockRestock),
  });
}
