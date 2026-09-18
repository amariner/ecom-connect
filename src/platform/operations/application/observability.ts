/** Contrato de observabilidad base, sin I/O ni campos arbitrarios (R1.9). */

export const OBSERVABILITY_SCHEMA = 'logic2b.observability.v1';

export const OPERATIONAL_ERROR_CODES = [
  'checkout.persistence_failed',
  'checkout.provider_failed',
  'checkout.unexpected_failure',
  'webhook.processing_failed',
  'outbox.invalid_entity',
  'outbox.order_not_found',
  'outbox.unknown_consumer',
  'outbox.consumer_failed',
  'email.delivery_failed',
] as const;

export type OperationalErrorCode = (typeof OPERATIONAL_ERROR_CODES)[number];
export type ObservedOperation = 'checkout' | 'webhook' | 'outbox' | 'email';

/** El mensaje es deliberadamente fijo y seguro; la causa nunca se serializa. */
export class OperationalError extends Error {
  readonly code: OperationalErrorCode;
  readonly retryable: boolean;

  constructor(code: OperationalErrorCode, retryable: boolean) {
    super('La operación no pudo completarse; consulta el código y la correlación.');
    this.name = 'OperationalError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function asOperationalError(
  error: unknown,
  fallback: OperationalErrorCode,
  retryable = true,
): OperationalError {
  return error instanceof OperationalError ? error : new OperationalError(fallback, retryable);
}

export type ObservationContext = Readonly<{
  operation: ObservedOperation;
  operationId: string;
  correlationId?: string | null;
  causationId?: string | null;
  durationMs?: number;
}>;

export type CheckoutMetric = Readonly<{
  name: 'checkout.completed';
  operationId: string;
  correlationId: string;
  paymentMode: 'stripe' | 'simulated';
  paymentOutcome: 'pending' | 'confirmed' | 'conflict';
  durationMs: number;
}>;

export type WebhookMetric = Readonly<{
  name: 'webhook.processed';
  operationId: string;
  causationId: string;
  eventKind: 'checkout_completed' | 'checkout_expired' | 'ignored';
  outcome: 'applied' | 'duplicate' | 'unpaid' | 'ignored';
  durationMs: number;
}>;

export type OutboxMetric = Readonly<{
  name: 'outbox.dispatch';
  operationId: string;
  claimed: number;
  delivered: number;
  failed: number;
  durationMs: number;
}>;

export type EmailMetric = Readonly<{
  name: 'email.delivery';
  operationId: string;
  claimed: number;
  delivered: number;
  failed: number;
  durationMs: number;
}>;

export type PlatformMetric = CheckoutMetric | WebhookMetric | OutboxMetric | EmailMetric;

export interface PlatformObservability {
  metric(metric: PlatformMetric): void;
  failure(error: OperationalError, context: ObservationContext): void;
}

export const silentObservability: PlatformObservability = Object.freeze({
  metric: () => undefined,
  failure: () => undefined,
});
