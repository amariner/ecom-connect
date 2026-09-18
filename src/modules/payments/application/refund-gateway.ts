import type { PaymentProvider } from '../domain/payment-ledger';

export type RefundGatewayStatus = 'succeeded' | 'processing' | 'failed' | 'requires_review';

export type RefundGatewayRequest = Readonly<{
  paymentReference: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  existingRefundReference: string | null;
}>;

export type RefundGatewayResult = Readonly<{
  providerReference: string;
  status: RefundGatewayStatus;
}>;

/** Puerto PSP: el módulo decide el dinero; el adaptador solo ejecuta/reconcilia. */
export interface PaymentRefundGateway {
  readonly provider: Exclude<PaymentProvider, 'legacy'>;
  refund(request: RefundGatewayRequest): Promise<RefundGatewayResult>;
}

export type PaymentRefundGatewayResolver = (
  provider: PaymentProvider,
) => PaymentRefundGateway | null;
