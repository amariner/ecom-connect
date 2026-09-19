import type { Channel, FeedProduct, MarketplaceOrderUpdate } from '../lib/demo-types';

export interface MarketplaceHubAdapter {
  publish(products: readonly FeedProduct[]): Promise<{ published: number; date: string }>;
  incomingOrder(input: { channel: Exclude<Channel, 'WEB'>; slug: string; qty: number; reference: string }): Promise<{
    channel: Exclude<Channel, 'WEB'>; reference: string; lines: { slug: string; qty: number }[];
    customer: { name: string; email: string; street: string; city: string; postal_code: string };
  }>;
  /** Proyecta el pedido local al hub demo; el contrato HTTP real se adapta por separado. */
  syncOrder(reference: string): Promise<MarketplaceOrderUpdate | null>;
}
