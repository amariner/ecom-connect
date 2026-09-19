import { snapshotCheckoutQuote, type CheckoutAttempt, type CheckoutExpectedQuote } from './checkout-attempt';

export type CheckoutConfirmation = { url: string; order_id: number; order_number?: string };
export class CheckoutSubmissionError extends Error {
  constructor(message: string,public readonly definitive: boolean,
    public readonly code?: 'quote_changed', public readonly quote?: CheckoutExpectedQuote) { super(message); }
}

/** Retry the frozen purchase; availability of an already paid order is irrelevant. */
export async function submitCheckoutAttempt(attempt: CheckoutAttempt, fetcher: typeof fetch = fetch): Promise<CheckoutConfirmation> {
  let response: Response;
  try {
    response = await fetcher('/api/checkout/session',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...attempt.payload,idempotency_key:attempt.key}),signal:AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CheckoutSubmissionError('La conexión se ha interrumpido. Conservamos tu intento: reintenta la confirmación para comprobar el mismo pedido, sin duplicarlo.',false);
  }
  const result: unknown = await response.json().catch(() => null);
  const error = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : undefined;
  if (!response.ok) {
    // Rate limits and timeouts do not establish the outcome of an earlier attempt.
    const definitive = [400,409,413,415].includes(response.status) && error !== undefined;
    const changed = response.status === 409 && error !== undefined && result && typeof result === 'object'
      && 'code' in result && result.code === 'quote_changed';
    const quote = changed && 'quote' in result ? snapshotCheckoutQuote(result.quote) : null;
    throw new CheckoutSubmissionError(error ?? 'No hemos podido comprobar la confirmación. Reintenta el mismo pedido en unos instantes.',definitive,
      changed ? 'quote_changed' : undefined, quote ?? undefined);
  }
  if (!result || typeof result !== 'object' || !('url' in result) || typeof result.url !== 'string' ||
    !/^\/gracias\?session=demo_[a-f0-9]{64}$/.test(result.url) || !('order_id' in result) ||
    typeof result.order_id !== 'number' || !Number.isSafeInteger(result.order_id) || result.order_id < 1) {
    throw new CheckoutSubmissionError('El servidor no ha devuelto una confirmación válida. Conservamos tu intento para poder recuperarlo.',false);
  }
  return {url:result.url,order_id:result.order_id,
    ...('order_number' in result && typeof result.order_number === 'string' ? {order_number:result.order_number} : {})};
}
