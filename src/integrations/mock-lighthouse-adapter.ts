import { CHANNELS, type Channel, type FeedProduct } from '../lib/demo-types';
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
}
