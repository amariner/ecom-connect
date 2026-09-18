/** Adaptador a Workers Logs: una línea JSON segura por señal útil (R1.9). */

import {
  OBSERVABILITY_SCHEMA,
  type ObservationContext,
  type OperationalError,
  type PlatformMetric,
  type PlatformObservability,
} from '../application/observability';

export type ObservabilitySink = Readonly<{
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}>;

export type ObservabilityClock = Readonly<{ now(): Date }>;

const OPERATION_ID = /^op_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID = /^order:[A-Z0-9-]{1,120}$/;
const CAUSATION_ID = /^evt_[A-Za-z0-9_-]{1,150}$/;

function safeId(value: string | null | undefined, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function safeCount(value: number): number {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000) : 0;
}

function safeDuration(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 60_000)
    : 0;
}

function metricRecord(metric: PlatformMetric): Readonly<Record<string, unknown>> {
  const base = {
    schema: OBSERVABILITY_SCHEMA,
    kind: 'metric',
    metric: metric.name,
    operation_id: safeId(metric.operationId, OPERATION_ID),
    duration_ms: safeDuration(metric.durationMs),
  } as const;
  switch (metric.name) {
    case 'checkout.completed':
      return {
        ...base,
        correlation_id: safeId(metric.correlationId, CORRELATION_ID),
        payment_mode: metric.paymentMode,
        payment_outcome: metric.paymentOutcome,
        value: 1,
      };
    case 'webhook.processed':
      return {
        ...base,
        causation_id: safeId(metric.causationId, CAUSATION_ID),
        event_kind: metric.eventKind,
        outcome: metric.outcome,
        value: 1,
      };
    case 'outbox.dispatch':
    case 'email.delivery':
      return {
        ...base,
        claimed: safeCount(metric.claimed),
        delivered: safeCount(metric.delivered),
        failed: safeCount(metric.failed),
      };
  }
}

function emit(sink: ObservabilitySink, level: 'info' | 'warn' | 'error', value: Record<string, unknown>): void {
  try {
    sink[level](JSON.stringify(value));
  } catch {
    // La observabilidad nunca puede romper la operación observada.
  }
}

export function createConsoleObservability(
  options: Readonly<{
    sink?: ObservabilitySink;
    clock?: ObservabilityClock;
  }> = {},
): PlatformObservability {
  const sink = options.sink ?? console;
  const clock = options.clock ?? { now: () => new Date() };
  return Object.freeze({
    metric(metric: PlatformMetric) {
      const hasFailures = 'failed' in metric && metric.failed > 0;
      const level = hasFailures ? 'warn' : 'info';
      const record = { ...metricRecord(metric), level, emitted_at: clock.now().toISOString() };
      emit(sink, level, record);
    },
    failure(error: OperationalError, context: ObservationContext) {
      emit(sink, 'error', {
        schema: OBSERVABILITY_SCHEMA,
        kind: 'error',
        level: 'error',
        emitted_at: clock.now().toISOString(),
        operation: context.operation,
        operation_id: safeId(context.operationId, OPERATION_ID),
        correlation_id: safeId(context.correlationId, CORRELATION_ID),
        causation_id: safeId(context.causationId, CAUSATION_ID),
        duration_ms: safeDuration(context.durationMs),
        code: error.code,
        retryable: error.retryable,
      });
    },
  });
}

/** Id interno no derivado de IP, URL, body ni cabeceras del usuario. */
export function createOperationId(): string {
  return `op_${crypto.randomUUID()}`;
}
