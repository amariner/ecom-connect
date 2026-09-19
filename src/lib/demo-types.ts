export const CHANNELS = ['WEB', 'AMAZON', 'MIRAVIA', 'CARREFOUR', 'EBAY'] as const;
export type Channel = typeof CHANNELS[number];
export type SupplierStatus = 'PENDING_SUPPLIER' | 'SUPPLIER_ACCEPTED' | 'SUPPLIER_PROCESSING' | 'SUPPLIER_PARTIAL' | 'SUPPLIER_SHIPPED' | 'ERROR';
export type DispatchMode = 'immediate' | 'grouped';
export type Product = {
  id: number; slug: string; name: string; description: string; price_cents: number;
  compare_at_price_cents: number | null; stock: number; image: string; category: string;
  active: number; sku: string; supplier_sku: string; ean: string; brand: string;
  vat: number; last_synced_at: string | null;
};
export type DemoOrder = {
  id: number; order_number: string; channel: Channel; customer_name: string;
  total_cents: number; subtotal_cents: number; shipping_cents: number; status: string;
  supplier_status: SupplierStatus; supplier_order_id: string | null;
  supplier_dispatch_mode: DispatchMode | null;
  last_supplier_sync: string | null; tracking_number: string | null; tracking_carrier: string | null; created_at: string;
  supplier_stock_committed: number; stripe_session_id: string; request_hash: string | null;
};
export type SupplierProduct = {
  code: string; slug: string; description: string; name: string; price_cents: number;
  discount: number; pvp_cents: number | null; brand: string; vat: number;
  category: string; image: string; ean: string; sku: string; active: number;
  stock: number; backup_stock: number; available: boolean;
};
export type SupplierOrderStatus = 'pending' | 'processing' | 'partial' | 'shipped' | 'error';
export const SUPPLIER_ORDER_UPDATE_STATUSES = ['processing','partial','shipped','error'] as const;
export type SupplierOrderUpdateStatus = typeof SUPPLIER_ORDER_UPDATE_STATUSES[number];
export type SupplierOrderResult = {
  supplier_order_id: string; reference: string; status: SupplierOrderStatus;
  date: string; expedition_number: string | null; tracking: string | null;
};
export type SupplierShipment = {
  sequence: number; expedition_number: string; tracking: string; date: string;
  lines: { code: string; qty: number }[];
};
/** Cantidades pedidas y expedidas por referencia, y los paquetes que las contienen. */
export type OrderFulfillment = {
  lines: { supplier_sku: string; name: string; ordered: number; shipped: number; pending: number }[];
  shipments: {
    id: number; sequence: number; expedition_number: string; tracking_number: string; tracking_carrier: string;
    shipped_at: string; units: number; lines: { supplier_sku: string; name: string; qty: number }[];
    marketplace_synced_at: string | null;
  }[];
};
export const CANCELLATION_REASONS = ['customer_request','out_of_stock','duplicate','other'] as const;
export const CANCELLATION_SOURCES = ['panel','marketplace'] as const;
/** Quién pidió la cancelación, por qué y qué respondió el proveedor demo. */
export type OrderCancellation = {
  source: typeof CANCELLATION_SOURCES[number]; reason: typeof CANCELLATION_REASONS[number];
  supplier_outcome: 'pending' | 'not_required' | 'accepted' | 'rejected';
  requested_at: string; cancelled_at: string | null; marketplace_synced_at: string | null;
};
/** Acuse simulado: referencia interna, sin afirmar equivalencia con un lighthouseId real. */
export type MarketplaceOrderUpdate = {
  order_id: number; channel: Exclude<Channel, 'WEB'>; reference: string;
  supplier_status: SupplierStatus; tracking_number: string | null;
  tracking_carrier: string | null; synced_at: string;
};
export type FeedProduct = {
  id: string; title: string; description: string; link: string; image_link: string;
  price: string; availability: 'in_stock' | 'out_of_stock'; brand: string; gtin: string;
  sku: string; stock: number;
};
