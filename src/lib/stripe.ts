/**
 * Cliente Stripe para Cloudflare Workers.
 * Gotchas cubiertos (CLAUDE.md §7.1): fetch HTTP client y Web Crypto para
 * verificar firmas — el método síncrono de Node falla en el edge.
 */

import Stripe from 'stripe';

export function stripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();

/** Verifica la firma del webhook con Web Crypto. Lanza si no es válida. */
async function verifyWebhookEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  webhookSecret: string,
): Promise<Stripe.Event> {
  return await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret, undefined, cryptoProvider);
}

/**
 * Evento de checkout ya normalizado (R1.5). El adaptador HTTP no debe conocer
 * los tipos del SDK: aquí se traduce a un hecho del proveedor con solo lo que
 * el motor necesita, y `id` viaja como causación del evento de pedido.
 *
 * `paid` es explícito porque con métodos de pago diferido (SEPA, iDEAL con
 * captura asíncrona) `completed` puede llegar sin cobro cerrado; el kit asume
 * cobro inmediato y no cumple pedidos no pagados.
 */
export type CheckoutWebhookEvent =
  | Readonly<{
      kind: 'checkout_completed';
      id: string;
      session_id: string;
      paid: boolean;
      payment_intent: string | null;
      amendment_id: string | null;
    }>
  | Readonly<{
      kind: 'checkout_expired';
      id: string;
      session_id: string;
      amendment_id: string | null;
    }>
  | Readonly<{ kind: 'ignored'; id: string }>;

/** Verifica la firma y devuelve el hecho normalizado. Lanza si la firma no es válida. */
export async function verifyCheckoutWebhookEvent(
  secretKey: string,
  payload: string,
  signature: string,
  webhookSecret: string,
): Promise<CheckoutWebhookEvent> {
  const event = await verifyWebhookEvent(stripeClient(secretKey), payload, signature, webhookSecret);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    return {
      kind: 'checkout_completed',
      id: event.id,
      session_id: session.id,
      paid: session.payment_status === 'paid',
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      amendment_id: session.metadata?.amendment_id ?? null,
    };
  }
  if (event.type === 'checkout.session.expired') {
    return {
      kind: 'checkout_expired',
      id: event.id,
      session_id: event.data.object.id,
      amendment_id: event.data.object.metadata?.amendment_id ?? null,
    };
  }
  return { kind: 'ignored', id: event.id };
}
