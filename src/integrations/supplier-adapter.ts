import type { SupplierOrderResult, SupplierOrderStatus, SupplierProduct } from '../lib/demo-types';

export class SupplierOrderError extends Error {
  constructor(public readonly code: 'invalid_input' | 'idempotency_conflict' | 'stock_unavailable', message: string) {
    super(message);
    this.name = 'SupplierOrderError';
  }
}

/** Puerto sustituible por la API real; todos los importes siguen en céntimos. */
export interface SupplierAdapter {
  catalog(): Promise<SupplierProduct[]>;
  stock(): Promise<{ code: string; stock: number; backup_stock: number; available: boolean }[]>;
  createOrder(input: { reference: string; items: { code: string; qty: number }[] }): Promise<SupplierOrderResult>;
  orderStatus(reference: string): Promise<SupplierOrderResult | null>;
  advanceOrder(reference: string, status?: SupplierOrderStatus): Promise<SupplierOrderResult>;
}
