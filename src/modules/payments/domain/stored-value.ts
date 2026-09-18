export const STORED_VALUE_KINDS = ['gift_card', 'store_credit'] as const;
export const STORED_VALUE_STATES = ['active', 'disabled', 'closed'] as const;
export type StoredValueKind = (typeof STORED_VALUE_KINDS)[number];
export type StoredValueState = (typeof STORED_VALUE_STATES)[number];

export type StoredValueAccount = Readonly<{
  id: string;
  kind: StoredValueKind;
  state: StoredValueState;
  currency: string;
  label: string;
  balance_cents: number;
  reserved_cents: number;
  version: number;
  expires_at: string | null;
}>;

export type StoredValueAuthorization = Readonly<{
  accountId: string;
  accountVersion: number;
  kind: StoredValueKind;
  currency: string;
  amountCents: number;
  availableBeforeCents: number;
  snapshot: Readonly<{
    schema: 1;
    account_id: string;
    account_kind: StoredValueKind;
    account_version: number;
    amount_cents: number;
    balance_before_cents: number;
    refund_policy: 'original_tender_stored_value_first';
  }>;
}>;

const ISO_CURRENCY = /^[A-Z]{3}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function money(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} inválido.`);
}

export function normalizeGiftCardCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z2-9]{20,80}$/.test(normalized)) throw new RangeError('Código de tarjeta regalo inválido.');
  return normalized;
}

export async function storedValueSecretHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function giftCardCodeHash(value: string): Promise<string> {
  return storedValueSecretHash(`logic2b:gift-card:v1:${normalizeGiftCardCode(value)}`);
}

export function generateGiftCardCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const raw = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `L2B-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}-${raw.slice(18)}`;
}

export function authorizeStoredValue(input: Readonly<{
  account: StoredValueAccount;
  requestedCents: number;
  orderTotalCents: number;
  currency: string;
  at: string;
}>): StoredValueAuthorization {
  const { account } = input;
  money(input.requestedCents, 'requestedCents');
  money(input.orderTotalCents, 'orderTotalCents');
  money(account.balance_cents, 'account.balance_cents');
  money(account.reserved_cents, 'account.reserved_cents');
  if (!ISO_CURRENCY.test(input.currency) || account.currency !== input.currency) {
    throw new RangeError('La moneda del saldo no coincide con el pedido.');
  }
  if (!ISO_TIMESTAMP.test(input.at)) throw new RangeError('at inválido.');
  if (account.state !== 'active') throw new RangeError('El saldo no está activo.');
  if (account.expires_at !== null && account.expires_at <= input.at) {
    throw new RangeError('El saldo ha caducado.');
  }
  if (!Number.isSafeInteger(account.version) || account.version < 1 ||
      account.reserved_cents > account.balance_cents) {
    throw new RangeError('El estado del saldo es inválido.');
  }
  const available = account.balance_cents - account.reserved_cents;
  const requested = input.requestedCents === 0 ? input.orderTotalCents : input.requestedCents;
  const amount = Math.min(requested, input.orderTotalCents, available);
  if (amount < 1) throw new RangeError('El saldo disponible es insuficiente.');
  return Object.freeze({
    accountId: account.id,
    accountVersion: account.version,
    kind: account.kind,
    currency: account.currency,
    amountCents: amount,
    availableBeforeCents: available,
    snapshot: Object.freeze({
      schema: 1 as const,
      account_id: account.id,
      account_kind: account.kind,
      account_version: account.version,
      amount_cents: amount,
      balance_before_cents: available,
      refund_policy: 'original_tender_stored_value_first' as const,
    }),
  });
}

export type StoredValueRefundPlan = Readonly<{
  storedValueCents: number;
  externalCents: number;
}>;

/** Devuelve primero al medio de valor almacenado para impedir convertirlo en efectivo. */
export function planStoredValueRefund(
  refundCents: number,
  refundableStoredValueCents: number,
): StoredValueRefundPlan {
  money(refundCents, 'refundCents');
  money(refundableStoredValueCents, 'refundableStoredValueCents');
  if (refundCents < 1) throw new RangeError('refundCents inválido.');
  const storedValueCents = Math.min(refundCents, refundableStoredValueCents);
  return Object.freeze({ storedValueCents, externalCents: refundCents - storedValueCents });
}
