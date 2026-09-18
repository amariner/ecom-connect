/**
 * Contexto ambiental de los eventos (R1.5). El sobre se define sin I/O ni
 * relojes, así que alguien tiene que elegir de dónde salen el instante y el
 * identificador: es trabajo del composition root, igual que elegir adaptadores.
 *
 * Los tests inyectan sus propias fuentes y obtienen sobres deterministas.
 */

import {
  createEventFactory,
  createEventIdentityFactory,
  type EventClock,
  type EventIdSource,
} from '../shared-kernel/events';

export const systemEventClock: EventClock = { now: () => new Date() };

/** `crypto.randomUUID` existe en Workers y en Node ≥ 19: no añade dependencia. */
export const randomEventIdSource: EventIdSource = { next: () => crypto.randomUUID() };

/** Fábrica que usa el runtime real. */
export const emitPlatformEvent = createEventFactory({
  clock: systemEventClock,
  ids: randomEventIdSource,
});

/** Reserva la misma identidad que usa la fábrica, para altas con id D1 autogenerado. */
export const reservePlatformEventIdentity = createEventIdentityFactory({
  clock: systemEventClock,
  ids: randomEventIdSource,
});
