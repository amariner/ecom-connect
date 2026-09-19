export type SupplierStockSnapshot = {
  code: string; name: string; slug: string; store_product_id: number | null;
  supplier_active: boolean; store_active: boolean | null;
  supplier_stock: number; reserved_units: number; reserved_orders_count: number;
  theoretical_available: number; store_stock: number | null; stock_difference: number | null;
  supplier_updated_at: string; store_synced_at: string | null;
  supplier_price_cents: number; supplier_pvp_cents: number | null;
  store_price_cents: number | null; store_pvp_cents: number | null;
};

/** Keeps each product's draft while only accepting the latest stock consultation. */
export class SupplierStockSelection {
  code = '';
  snapshot: SupplierStockSnapshot | undefined;
  loading = false;
  error = '';
  private drafts = new Map<string, string>();
  private revision = 0;
  private controller: AbortController | undefined;

  select(code: string) {
    if (code === this.code) return;
    this.controller?.abort();
    this.revision++;
    this.code = code;
    this.snapshot = undefined;
    this.loading = false;
    this.error = '';
  }

  edit(value: string) {
    if (this.code) this.drafts.set(this.code, value);
  }

  get draft(): string {
    return this.drafts.get(this.code) ?? (this.snapshot ? String(this.snapshot.supplier_stock) : '');
  }

  async load(fetchSnapshot: (code: string, signal: AbortSignal) => Promise<SupplierStockSnapshot>): Promise<boolean> {
    this.controller?.abort();
    const revision = ++this.revision;
    const code = this.code;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => revision === this.revision && code === this.code && !controller.signal.aborted;
    this.loading = true;
    this.error = '';
    this.snapshot = undefined;
    try {
      const snapshot = await fetchSnapshot(code, controller.signal);
      if (!current()) return false;
      if (snapshot.code !== code) throw new Error('La consulta no corresponde al producto seleccionado. Vuelve a intentarlo.');
      this.snapshot = snapshot;
    } catch (error) {
      if (!current()) return false;
      this.error = error instanceof Error ? error.message : 'No hemos podido consultar la disponibilidad de este producto.';
    } finally {
      if (current()) this.loading = false;
    }
    return current();
  }
}
