/**
 * Identidad del comprador: reglas puras del área de cliente. No toca la base
 * de datos. El esquema heredado (0036-0044) impone la gramática de los
 * identificadores y las ventanas máximas de los secretos; aquí se declara una
 * sola vez para que las superficies no las reinventen.
 */

/** Identificadores del esquema heredado: minúsculas, con separador y sin acentos. */
const ID_PREFIXES = {
  profile: 'cus', identity: 'idn', family: 'fam', session: 'ses',
  challenge: 'chl', delivery: 'mail', address: 'adr', consent: 'cns',
} as const;
export type CustomerIdKind = keyof typeof ID_PREFIXES;

export function randomHex(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return [...values].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}
export const customerId = (kind: CustomerIdKind): string => `${ID_PREFIXES[kind]}_${randomHex()}`;
/** Claves de idempotencia del esquema heredado: opacas y sin relación con el secreto. */
export const operationKey = (operation: string): string => `auth:${operation}:${randomHex()}`;

/**
 * El secreto del enlace viaja en la URL y nunca se guarda: la base solo
 * conserva su huella. Quien lea la tabla no puede iniciar sesión con ella.
 */
export const accessSecret = (): string => randomHex(32);

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en');
}

/** El sujeto del throttling y la identidad comparten huella: nunca se guarda el correo en claro. */
export const emailIdentitySubject = (email: string): string => `farmahouse:customer:email:${email}`;

export function addMilliseconds(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * Márgenes por debajo del máximo que admite cada CHECK heredado (15 minutos,
 * 7 días y 30 días): la comparación usa `julianday`, y un valor exacto puede
 * quedar por encima del límite al convertirlo a coma flotante.
 */
export const ACCESS_LINK_TTL_MS = 10 * MINUTE;
export const SESSION_TTL_MS = 6 * DAY;
export const SESSION_FAMILY_TTL_MS = 28 * DAY;
export const THROTTLE_RETENTION_MS = 23 * 60 * MINUTE;

export type ThrottleCounts = { short: number; daily: number };
export type ThrottleDecision = {
  decision: 'accepted' | 'limited'; short_window_count: number; daily_window_count: number;
};
/**
 * Ventanas y máximos aceptados por el CHECK de `contact_start`. El esquema
 * heredado define también `challenge_failure`, pero abrir un enlace es un GET:
 * anotar cada fallo dejaría escribir en la base a quien solo pruebe URLs.
 */
export const THROTTLE_WINDOW = { short: 15 * MINUTE, daily: DAY, shortMax: 3, dailyMax: 10 } as const;

/**
 * Decide con los intentos ya contados, incluido el actual. El límite protege el
 * buzón simulado de un envío en bucle sin afectar a los demás compradores.
 */
export function decideThrottle(counts: ThrottleCounts): ThrottleDecision {
  const short = Math.max(1,counts.short);
  const daily = Math.max(short,counts.daily);
  const limited = short > THROTTLE_WINDOW.shortMax || daily > THROTTLE_WINDOW.dailyMax;
  return { decision: limited ? 'limited' : 'accepted', short_window_count: short, daily_window_count: daily };
}

export type AccountOrderStage = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
export type AccountOrderActions = {
  can_cancel: boolean;
  /** Por qué no puede cancelar ahora mismo. Se muestra tal cual al comprador. */
  cancel_note: string | null;
};
/**
 * Lo que el comprador puede hacer con su pedido. El servidor vuelve a decidir
 * al cancelar: esto solo evita ofrecer una acción que se va a rechazar.
 */
export function decideAccountOrderActions(order: { status: string; shipped_units: number }): AccountOrderActions {
  if (order.status === 'cancelled') return { can_cancel: false, cancel_note: null };
  if (order.status === 'shipped') {
    return { can_cancel: false, cancel_note: 'Tu pedido ya ha salido. Cuando conste entregado podrás pedir su devolución desde aquí.' };
  }
  if (order.status === 'delivered') {
    return { can_cancel: false, cancel_note: 'Este pedido está entregado. Si algo no va bien, pide su devolución aquí abajo.' };
  }
  if (order.shipped_units > 0) {
    return { can_cancel: false, cancel_note: 'Ya hay unidades expedidas de este pedido: pídenos ayuda para gestionarlo.' };
  }
  return { can_cancel: true, cancel_note: null };
}
