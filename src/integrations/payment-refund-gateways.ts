import { stripeClient } from '../lib/stripe';
import type {
  PaymentRefundGateway,
  PaymentRefundGatewayResolver,
  RefundGatewayRequest,
  RefundGatewayResult,
} from '../modules/payments';

type StripeRefundProjection = Readonly<{
  id: string;
  status: string | null;
  amount: number;
  currency: string;
  payment_intent: string | Readonly<{ id: string }> | null;
}>;

function stripeRefundResult(
  refund: StripeRefundProjection,
  request: RefundGatewayRequest,
): RefundGatewayResult {
  const paymentIntent = typeof refund.payment_intent === 'string'
    ? refund.payment_intent
    : refund.payment_intent?.id ?? null;
  if (
    refund.amount !== request.amountCents ||
    refund.currency.toUpperCase() !== request.currency ||
    paymentIntent !== request.paymentReference
  ) {
    return Object.freeze({ providerReference: refund.id, status: 'requires_review' });
  }
  switch (refund.status) {
    case 'succeeded':
      return Object.freeze({ providerReference: refund.id, status: 'succeeded' });
    case 'pending':
      return Object.freeze({ providerReference: refund.id, status: 'processing' });
    case 'failed':
    case 'canceled':
      return Object.freeze({ providerReference: refund.id, status: 'failed' });
    default:
      return Object.freeze({ providerReference: refund.id, status: 'requires_review' });
  }
}

export function createStripeRefundGateway(secretKey: string): PaymentRefundGateway {
  const stripe = stripeClient(secretKey);
  return Object.freeze({
    provider: 'stripe' as const,
    async refund(request: RefundGatewayRequest) {
      const refund = request.existingRefundReference
        ? await stripe.refunds.retrieve(request.existingRefundReference)
        : await stripe.refunds.create(
            {
              payment_intent: request.paymentReference,
              amount: request.amountCents,
              reason: 'requested_by_customer',
            },
            { idempotencyKey: request.idempotencyKey },
          );
      return stripeRefundResult(refund, request);
    },
  });
}

export function createSimulatedRefundGateway(): PaymentRefundGateway {
  return Object.freeze({
    provider: 'simulated' as const,
    async refund(request: RefundGatewayRequest) {
      const providerReference = request.existingRefundReference ??
        `sim_refund_${request.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '_')}`;
      return Object.freeze({ providerReference, status: 'succeeded' as const });
    },
  });
}

export function createPaymentRefundGatewayResolver(
  stripeSecretKey: string | undefined,
): PaymentRefundGatewayResolver {
  const simulated = createSimulatedRefundGateway();
  const stripe = stripeSecretKey?.trim() ? createStripeRefundGateway(stripeSecretKey) : null;
  return (provider) => {
    if (provider === 'simulated') return simulated;
    if (provider === 'stripe') return stripe;
    return null;
  };
}
