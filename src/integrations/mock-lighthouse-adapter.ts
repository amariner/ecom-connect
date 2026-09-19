import { CHANNELS, type Channel, type FeedProduct, type MarketplaceOrderUpdate } from '../lib/demo-types';
import type { MarketplaceHubAdapter } from './marketplace-hub-adapter';

/** Hub local: representa el contrato, sin credenciales ni tráfico a marketplaces. */
export class MockLighthouseAdapter implements MarketplaceHubAdapter {
  constructor(private readonly db: D1Database) {}
  async publish(products: readonly FeedProduct[]) {
    const date = new Date().toISOString();
    await this.db.batch(CHANNELS.filter((channel) => channel !== 'WEB').map((channel) =>
      this.db.prepare(`INSERT INTO marketplace_publications(channel,published,synced_at) VALUES (?,?,?)
        ON CONFLICT(channel) DO UPDATE SET published=excluded.published,synced_at=excluded.synced_at`)
        .bind(channel, products.length, date)));
    return { published: products.length, date };
  }
  async incomingOrder(input: { channel: Exclude<Channel, 'WEB'>; slug: string; qty: number; reference: string }) {
    return {
      channel: input.channel, reference: input.reference, lines: [{ slug: input.slug, qty: input.qty }],
      customer: { name: 'Laura Martínez (demo)', email: 'laura@example.test', street: 'Calle de la Demo, 18', city: 'Castellón', postal_code: '12001' },
    };
  }
  async syncOrder(reference: string) {
    // El estado se lee dentro del INSERT: un reintento lento nunca puede
    // sobrescribir el tracking vigente con una respuesta anterior del proveedor.
    await this.db.prepare(`INSERT INTO marketplace_order_updates
      (order_id,channel,reference,supplier_status,tracking_number,tracking_carrier,synced_at)
      SELECT id,channel,order_number,supplier_status,tracking_number,tracking_carrier,?
      FROM orders WHERE order_number=? AND channel<>'WEB'
      ON CONFLICT(order_id) DO UPDATE SET supplier_status=excluded.supplier_status,
        tracking_number=excluded.tracking_number,tracking_carrier=excluded.tracking_carrier,synced_at=excluded.synced_at
      WHERE marketplace_order_updates.supplier_status<>excluded.supplier_status
        OR marketplace_order_updates.tracking_number IS NOT excluded.tracking_number
        OR marketplace_order_updates.tracking_carrier IS NOT excluded.tracking_carrier`)
      .bind(new Date().toISOString(), reference).run();
    return this.db.prepare('SELECT * FROM marketplace_order_updates WHERE reference=?').bind(reference).first<MarketplaceOrderUpdate>();
  }
}
