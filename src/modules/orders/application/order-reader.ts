export const ORDER_LIST_SORTS = ['created-desc', 'created-asc', 'total-desc', 'total-asc'] as const;
export type OrderListSort = (typeof ORDER_LIST_SORTS)[number];

export const ORDER_LIST_DEFAULT_SORT: OrderListSort = 'created-desc';
export const ORDER_LIST_MAX_LIMIT = 100;

export type OrderListRow = Readonly<{
  id: number;
  order_number: string;
  customer_name: string;
  email: string;
  total_cents: number;
  status: string;
  created_at: string;
  active_hold_count: number;
  breached_hold_count: number;
}>;

export type OrderStatusCount = Readonly<{ status: string; n: number }>;

export type OrderListFilters = Readonly<{
  status?: string | undefined;
  search?: string | undefined;
  createdFrom?: string | undefined;
  createdBefore?: string | undefined;
  minTotalCents?: number | undefined;
  maxTotalCents?: number | undefined;
  tag?: string | undefined;
  hold?: 'active' | 'breached' | undefined;
}>;

export type OrderListQuery = OrderListFilters & Readonly<{
  limit: number;
  sort?: OrderListSort | undefined;
  cursor?: string | undefined;
}>;

export type OrderCursorDirection = 'next' | 'previous';

export type OrderListCursor = Readonly<{
  sort: OrderListSort;
  direction: OrderCursorDirection;
  value: string | number;
  id: number;
  scope: string;
}>;

export type OrderListReadQuery = OrderListFilters & Readonly<{
  limit: number;
  sort: OrderListSort;
  cursor?: OrderListCursor | undefined;
}>;

export type OrderListPage = Readonly<{
  orders: readonly OrderListRow[];
  counts: readonly OrderStatusCount[];
  total: number;
  nextCursor: string | null;
  previousCursor: string | null;
  invalidCursor: boolean;
  limit: number;
  sort: OrderListSort;
}>;

export type OrderDetail = Readonly<{
  id: number;
  order_number: string;
  email: string;
  customer_name: string;
  address_json: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  status: string;
  tracking_carrier: string | null;
  tracking_number: string | null;
  created_at: string;
}>;

export type OrderItem = Readonly<{
  order_item_id: number;
  name_snapshot: string;
  unit_price_cents: number;
  qty: number;
}>;
export type OrderEvent = Readonly<{
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}>;
export type OrderNote = Readonly<{
  id: string;
  visibility: 'internal' | 'customer';
  body: string;
  version: number;
  actor_kind: string;
  actor_label: string | null;
  created_at: string;
  updated_at: string;
}>;
export type OrderTag = Readonly<{
  id: number;
  slug: string;
  label: string;
  active: number;
  usage_count: number;
}>;
export type OrderHoldRead = Readonly<{
  id: string;
  status: 'active' | 'resolved';
  source: 'manual' | 'automatic';
  reason_code: string;
  owner_kind: 'admin' | 'system';
  owner_id: string;
  owner_label: string;
  due_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_code: string | null;
}>;
export type OrderTimelineItem = Readonly<{
  id: string;
  kind: 'status' | 'note' | 'tag' | 'hold';
  title: string;
  detail: string | null;
  visibility: 'internal' | 'customer';
  actor_kind: string;
  actor_label: string | null;
  occurred_at: string;
}>;

export interface OrderReader {
  list(query: OrderListReadQuery): Promise<readonly OrderListRow[]>;
  matchingCount(filters: OrderListFilters): Promise<number>;
  counts(): Promise<readonly OrderStatusCount[]>;
  detail(id: number): Promise<OrderDetail | null>;
  items(id: number): Promise<readonly OrderItem[]>;
  events(id: number): Promise<readonly OrderEvent[]>;
  notes(id: number): Promise<readonly OrderNote[]>;
  tags(orderId?: number): Promise<readonly OrderTag[]>;
  holds(orderId: number): Promise<readonly OrderHoldRead[]>;
  timeline(id: number): Promise<readonly OrderTimelineItem[]>;
}

type CursorPayload = Readonly<{
  v: 1;
  s: OrderListSort;
  d: OrderCursorDirection;
  k: string | number;
  i: number;
  f: string;
}>;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function isOrderListSort(value: unknown): value is OrderListSort {
  return typeof value === 'string' && (ORDER_LIST_SORTS as readonly string[]).includes(value);
}

function isCursorValue(sort: OrderListSort, value: unknown): value is string | number {
  if (sort.startsWith('created-')) return typeof value === 'string' && value.length > 0 && value.length <= 64;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function encodeOrderListCursor(cursor: OrderListCursor): string {
  const payload: CursorPayload = {
    v: 1,
    s: cursor.sort,
    d: cursor.direction,
    k: cursor.value,
    i: cursor.id,
    f: cursor.scope,
  };
  return encodeBase64Url(JSON.stringify(payload));
}

export function decodeOrderListCursor(token: string): OrderListCursor | null {
  if (!token || token.length > 2_048) return null;
  try {
    const value = JSON.parse(decodeBase64Url(token)) as Partial<CursorPayload>;
    const id = value.i;
    if (
      value.v !== 1 ||
      !isOrderListSort(value.s) ||
      (value.d !== 'next' && value.d !== 'previous') ||
      !isCursorValue(value.s, value.k) ||
      !Number.isSafeInteger(id) ||
      (id ?? 0) <= 0 ||
      typeof value.f !== 'string' ||
      value.f.length > 1_024
    ) return null;
    return Object.freeze({ sort: value.s, direction: value.d, value: value.k, id: id as number, scope: value.f });
  } catch {
    return null;
  }
}

function normalizedFilters(query: OrderListQuery): OrderListFilters {
  const search = query.search?.trim().slice(0, 120);
  const status = query.status?.trim().slice(0, 32);
  const tag = query.tag?.trim().slice(0, 64);
  const hold = query.hold === 'active' || query.hold === 'breached' ? query.hold : undefined;
  return Object.freeze({
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(tag ? { tag } : {}),
    ...(hold ? { hold } : {}),
    ...(query.createdFrom ? { createdFrom: query.createdFrom } : {}),
    ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
    ...(Number.isSafeInteger(query.minTotalCents) && (query.minTotalCents ?? -1) >= 0
      ? { minTotalCents: query.minTotalCents }
      : {}),
    ...(Number.isSafeInteger(query.maxTotalCents) && (query.maxTotalCents ?? -1) >= 0
      ? { maxTotalCents: query.maxTotalCents }
      : {}),
  });
}

function cursorScope(filters: OrderListFilters): string {
  return JSON.stringify([
    filters.status ?? '',
    filters.search ?? '',
    filters.createdFrom ?? '',
    filters.createdBefore ?? '',
    filters.minTotalCents ?? '',
    filters.maxTotalCents ?? '',
    filters.tag ?? '',
    filters.hold ?? '',
  ]);
}

function cursorFor(
  order: OrderListRow,
  sort: OrderListSort,
  direction: OrderCursorDirection,
  scope: string,
): string {
  const value = sort.startsWith('created-') ? order.created_at : order.total_cents;
  return encodeOrderListCursor({ sort, direction, value, id: order.id, scope });
}

export function createOrderReaderService(reader: OrderReader) {
  return Object.freeze({
    async list(query: OrderListQuery): Promise<OrderListPage> {
      const filters = normalizedFilters(query);
      const sort = query.sort && isOrderListSort(query.sort) ? query.sort : ORDER_LIST_DEFAULT_SORT;
      const limit = Math.max(1, Math.min(ORDER_LIST_MAX_LIMIT, Math.trunc(query.limit) || 1));
      const scope = cursorScope(filters);
      const decodedCursor = query.cursor ? decodeOrderListCursor(query.cursor) : null;
      const cursor = decodedCursor?.sort === sort && decodedCursor.scope === scope ? decodedCursor : undefined;
      const invalidCursor = Boolean(query.cursor && !cursor);
      const readQuery: OrderListReadQuery = { ...filters, sort, limit: limit + 1, ...(cursor ? { cursor } : {}) };
      const [readOrders, counts, total] = await Promise.all([
        reader.list(readQuery),
        reader.counts(),
        reader.matchingCount(filters),
      ]);
      const hasMoreInDirection = readOrders.length > limit;
      const selected = readOrders.slice(0, limit);
      const orders = cursor?.direction === 'previous' ? [...selected].reverse() : selected;
      const first = orders[0];
      const last = orders.at(-1);
      const hasPrevious = cursor?.direction === 'previous' ? hasMoreInDirection : Boolean(cursor);
      const hasNext = cursor?.direction === 'previous' ? Boolean(cursor) : hasMoreInDirection;
      return Object.freeze({
        orders,
        counts,
        total,
        previousCursor: hasPrevious && first ? cursorFor(first, sort, 'previous', scope) : null,
        nextCursor: hasNext && last ? cursorFor(last, sort, 'next', scope) : null,
        invalidCursor,
        limit,
        sort,
      });
    },
    async detail(id: number) {
      const order = await reader.detail(id);
      if (!order) return null;
      const [items, events, notes, tags, availableTags, holds, timeline] = await Promise.all([
        reader.items(id), reader.events(id), reader.notes(id), reader.tags(id), reader.tags(), reader.holds(id), reader.timeline(id),
      ]);
      return Object.freeze({ order, items, events, notes, tags, availableTags, holds, timeline });
    },
    tags: () => reader.tags(),
  });
}
