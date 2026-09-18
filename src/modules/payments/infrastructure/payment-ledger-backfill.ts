import { assertPaymentCurrency } from '../domain/payment-ledger.ts';

/**
 * SQL idempotente que congela la moneda configurada y materializa la historia
 * legacy después de aplicar 0011. El rehearsal valida la D1 antes de ejecutar
 * este bloque; aquí no se inventan importes, reembolsos ni referencias PSP.
 */
export function paymentLedgerBackfillSql(currency: string): string {
  assertPaymentCurrency(currency);
  return `
UPDATE orders SET currency = '${currency}' WHERE currency = '';

INSERT INTO payments (
  order_id, provider, provider_reference, currency, expected_amount_cents,
  status, version, idempotency_key, created_at, updated_at
)
SELECT
  o.id,
  CASE
    WHEN o.stripe_session_id LIKE 'sim_%' OR o.stripe_payment_intent LIKE 'sim_%'
      THEN 'simulated'
    WHEN o.stripe_session_id IS NOT NULL OR o.stripe_payment_intent IS NOT NULL
      THEN 'stripe'
    ELSE 'legacy'
  END,
  COALESCE(o.stripe_payment_intent, o.stripe_session_id),
  o.currency,
  o.total_cents,
  CASE
    WHEN o.status = 'pending' THEN 'pending'
    WHEN o.status IN ('paid', 'shipped', 'delivered') THEN 'captured'
    WHEN o.status = 'cancelled' AND EXISTS (
      SELECT 1 FROM order_events e
      WHERE e.order_id = o.id AND e.to_status = 'paid'
    ) THEN 'requires_review'
    ELSE 'cancelled'
  END,
  1,
  'r2:payment:order:' || o.id || ':primary',
  o.created_at,
  o.updated_at
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
ORDER BY o.id;

INSERT INTO payment_transactions (
  payment_id, type, amount_cents, currency, status, provider_reference,
  idempotency_key, occurred_at, created_at
)
SELECT
  p.id,
  'capture',
  p.expected_amount_cents,
  p.currency,
  'succeeded',
  COALESCE(o.stripe_payment_intent, o.stripe_session_id, 'legacy:order:' || o.id),
  'r2:payment:capture:order:' || o.id,
  COALESCE((
    SELECT e.created_at FROM order_events e
    WHERE e.order_id = o.id AND e.to_status = 'paid'
    ORDER BY e.id LIMIT 1
  ), o.updated_at),
  COALESCE((
    SELECT e.created_at FROM order_events e
    WHERE e.order_id = o.id AND e.to_status = 'paid'
    ORDER BY e.id LIMIT 1
  ), o.updated_at)
FROM payments p
JOIN orders o ON o.id = p.order_id
WHERE (
    o.status IN ('paid', 'shipped', 'delivered')
    OR (o.status = 'cancelled' AND EXISTS (
      SELECT 1 FROM order_events e
      WHERE e.order_id = o.id AND e.to_status = 'paid'
    ))
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_transactions t
    WHERE t.idempotency_key = 'r2:payment:capture:order:' || o.id
  )
ORDER BY o.id;
`.trim() + '\n';
}
