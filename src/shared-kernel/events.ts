/**
 * Sobre de evento del motor (R1.5).
 *
 * Contrato ÚNICO y versionado con el que viaja cualquier hecho de negocio. No
 * hay bus, ni cola, ni tabla todavía: el sobre solo fija la forma para que el
 * outbox (R1.6/R1.7), el audit log (R1.8) y la observabilidad (R1.9) no tengan
 * que inventarse una cada uno ni renegociar los identificadores después.
 *
 * Invariantes que este módulo hace cumplir:
 *
 * 1. **Sin PII.** El sobre identifica y correlaciona; no transporta nombre,
 *    email ni dirección. Quien necesite esos datos los lee del propietario
 *    (hoy: el snapshot del pedido que pasa el composition root). Así el sobre
 *    puede persistirse o registrarse en logs sin abrir una superficie de datos
 *    personales nueva.
 * 2. **`idempotency_key` obligatoria y estable.** Es la clave con la que un
 *    consumidor reconoce que ya procesó ese hecho. Dos entregas del mismo hecho
 *    producen la misma clave; dos hechos distintos, nunca la misma.
 * 3. **`correlation_id` agrupa el flujo completo** (todo lo que le pasa a un
 *    pedido) y **`causation_id` apunta al hecho concreto que lo provocó** —el
 *    `event_id` de otro sobre o el id del evento del proveedor—, o `null` si el
 *    hecho es raíz.
 * 4. **Fail-fast.** La fábrica valida lo que produce: un sobre inválido no sale
 *    del proceso que lo creó.
 *
 * Sin I/O y sin configuración: el reloj y la fuente de ids se inyectan (el
 * composition root elige los ambientales).
 */

export const EVENT_ACTOR_KINDS = ['system', 'customer', 'admin', 'provider'] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

/** Quién provoca el hecho. `id` es un identificador estable y NO personal. */
export type EventActor = Readonly<{ kind: EventActorKind; id: string; label?: string }>;

/** Sobre qué recae el hecho. `reference` es la referencia legible (nº de pedido). */
export type EventEntity = Readonly<{ type: string; id: string; reference?: string }>;

export type EventEnvelope<TType extends string = string, TPayload = unknown> = Readonly<{
  event_id: string;
  type: TType;
  /** Versión del contrato de `payload`, entero ≥ 1. Sube cuando el payload rompe. */
  version: number;
  /** ISO-8601 UTC con milisegundos. */
  occurred_at: string;
  actor: EventActor;
  entity: EventEntity;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  payload: TPayload;
}>;

/** Lo que declara el productor; la fábrica añade id, instante y correlación raíz. */
export type EventDraft<TType extends string, TPayload> = Readonly<{
  type: TType;
  version: number;
  actor: EventActor;
  entity: EventEntity;
  idempotency_key: string;
  /** Ausente = el hecho abre su propio flujo y se correlaciona consigo mismo. */
  correlation_id?: string;
  causation_id?: string | null;
  payload: TPayload;
}>;

export interface EventClock {
  now(): Date;
}

export interface EventIdSource {
  next(): string;
}

/** Identidad reservable antes de que una transacción conozca todos sus datos. */
export type EventIdentity = Readonly<{ event_id: string; occurred_at: string }>;
export type ReserveEventIdentity = () => EventIdentity;

export type EmitEvent = <TType extends string, TPayload>(
  draft: EventDraft<TType, TPayload>,
) => EventEnvelope<TType, TPayload>;

export type EventEnvelopeIssue = Readonly<{ path: string; message: string }>;

const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const actorKinds = new Set<string>(EVENT_ACTOR_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function actorIssues(value: unknown): EventEnvelopeIssue[] {
  if (!isRecord(value)) return [{ path: 'actor', message: 'El actor debe ser un objeto.' }];
  const issues: EventEnvelopeIssue[] = [];
  if (typeof value.kind !== 'string' || !actorKinds.has(value.kind)) {
    issues.push({ path: 'actor.kind', message: `Tipo de actor desconocido: ${String(value.kind)}.` });
  }
  if (!nonEmptyString(value.id)) issues.push({ path: 'actor.id', message: 'El actor necesita un id no vacío.' });
  if (value.label !== undefined && !nonEmptyString(value.label)) {
    issues.push({ path: 'actor.label', message: 'La etiqueta del actor no puede ser vacía.' });
  }
  return issues;
}

function entityIssues(value: unknown): EventEnvelopeIssue[] {
  if (!isRecord(value)) return [{ path: 'entity', message: 'La entidad debe ser un objeto.' }];
  const issues: EventEnvelopeIssue[] = [];
  if (!nonEmptyString(value.type)) issues.push({ path: 'entity.type', message: 'La entidad necesita un tipo.' });
  if (!nonEmptyString(value.id)) issues.push({ path: 'entity.id', message: 'La entidad necesita un id.' });
  if (value.reference !== undefined && !nonEmptyString(value.reference)) {
    issues.push({ path: 'entity.reference', message: 'La referencia no puede ser vacía.' });
  }
  return issues;
}

export function validateEventEnvelope(value: unknown): readonly EventEnvelopeIssue[] {
  if (!isRecord(value)) return [{ path: 'event', message: 'El sobre debe ser un objeto.' }];
  const issues: EventEnvelopeIssue[] = [];

  if (!nonEmptyString(value.event_id)) issues.push({ path: 'event_id', message: 'Falta el identificador del evento.' });
  if (typeof value.type !== 'string' || !TYPE_PATTERN.test(value.type)) {
    issues.push({ path: 'type', message: 'El tipo debe seguir el patrón `modulo.hecho` en minúsculas.' });
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    issues.push({ path: 'version', message: 'La versión debe ser un entero mayor o igual que 1.' });
  }
  if (typeof value.occurred_at !== 'string' || !TIMESTAMP_PATTERN.test(value.occurred_at)) {
    issues.push({ path: 'occurred_at', message: 'El instante debe ser ISO-8601 UTC con milisegundos.' });
  }
  issues.push(...actorIssues(value.actor));
  issues.push(...entityIssues(value.entity));
  if (!nonEmptyString(value.correlation_id)) {
    issues.push({ path: 'correlation_id', message: 'Falta el identificador de correlación.' });
  }
  if (value.causation_id !== null && !nonEmptyString(value.causation_id)) {
    issues.push({ path: 'causation_id', message: 'La causación debe ser un id no vacío o null explícito.' });
  }
  if (!nonEmptyString(value.idempotency_key)) {
    issues.push({ path: 'idempotency_key', message: 'Todo hecho necesita clave de idempotencia.' });
  }
  if (!('payload' in value)) issues.push({ path: 'payload', message: 'Falta el payload.' });

  return issues;
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return validateEventEnvelope(value).length === 0;
}

export class EventEnvelopeError extends Error {
  readonly issues: readonly EventEnvelopeIssue[];

  constructor(issues: readonly EventEnvelopeIssue[]) {
    super(`Sobre de evento inválido:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'EventEnvelopeError';
    this.issues = issues;
  }
}

/**
 * Devuelve la correlación de un hecho provocado por otro: mismo flujo, y la
 * causación apunta al sobre padre.
 */
export function causedBy(parent: EventEnvelope): Readonly<{ correlation_id: string; causation_id: string }> {
  return Object.freeze({ correlation_id: parent.correlation_id, causation_id: parent.event_id });
}

/** Reserva id e instante sin I/O; permite preparar una única batch D1. */
export function createEventIdentityFactory(
  deps: Readonly<{ clock: EventClock; ids: EventIdSource }>,
): ReserveEventIdentity {
  return () => Object.freeze({
    event_id: deps.ids.next(),
    occurred_at: deps.clock.now().toISOString(),
  });
}

/** Completa y valida un sobre con una identidad ya reservada. */
export function createEventFromIdentity<TType extends string, TPayload>(
  identity: EventIdentity,
  draft: EventDraft<TType, TPayload>,
): EventEnvelope<TType, TPayload> {
  const envelope: EventEnvelope<TType, TPayload> = Object.freeze({
    ...identity,
    type: draft.type,
    version: draft.version,
    actor: Object.freeze({ ...draft.actor }),
    entity: Object.freeze({ ...draft.entity }),
    correlation_id: draft.correlation_id ?? identity.event_id,
    causation_id: draft.causation_id ?? null,
    idempotency_key: draft.idempotency_key,
    payload: draft.payload,
  });
  const issues = validateEventEnvelope(envelope);
  if (issues.length > 0) throw new EventEnvelopeError(issues);
  return envelope;
}

/**
 * Fábrica de sobres. El reloj y la fuente de ids se inyectan para que los tests
 * sean deterministas y para que el dominio no toque nada ambiental.
 */
export function createEventFactory(deps: Readonly<{ clock: EventClock; ids: EventIdSource }>): EmitEvent {
  const reserve = createEventIdentityFactory(deps);
  return <TType extends string, TPayload>(draft: EventDraft<TType, TPayload>): EventEnvelope<TType, TPayload> => {
    return createEventFromIdentity(reserve(), draft);
  };
}
