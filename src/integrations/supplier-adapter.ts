import type { SupplierOrderResult, SupplierOrderUpdateStatus, SupplierProduct, SupplierShipment } from '../lib/demo-types';

export class SupplierOrderError extends Error {
  constructor(public readonly code: 'invalid_input' | 'idempotency_conflict' | 'stock_unavailable' | 'shipment_rejected' | 'order_cancelled' | 'cancellation_rejected', message: string) {
    super(message);
    this.name = 'SupplierOrderError';
  }
}

/** Puerto sustituible por la API real; todos los importes siguen en céntimos. */
export type SupplierDelivery = {packing:'order'|'product';customer?:{name:string;street:string;city:string;postal_code:string}};
export interface SupplierAdapter {
  catalog(): Promise<SupplierProduct[]>;
  stock(): Promise<{ code: string; stock: number; backup_stock: number; available: boolean }[]>;
  createOrder(input: { reference: string; items: { code: string; qty: number }[]; delivery?:SupplierDelivery }): Promise<SupplierOrderResult>;
  orderStatus(reference: string): Promise<SupplierOrderResult | null>;
  advanceOrder(reference: string, status: SupplierOrderUpdateStatus): Promise<SupplierOrderResult>;
  /** Expide las líneas indicadas, o todas las unidades pendientes. La misma clave repite el resultado. */
  shipOrder(reference: string, input: { requestKey: string; lines: { code: string; qty: number }[] | 'remaining' }): Promise<SupplierShipment>;
  shipments(reference: string): Promise<SupplierShipment[]>;
  /** Anula un pedido sin expediciones y repone sus unidades. Repetirlo no repone dos veces. */
  cancelOrder(reference: string): Promise<{ cancelled: true }>;
}
