export interface PaymentIntent {
  id: string;
  clientSecret: string;
  amount: number;
  currency: string;
  status: string;
  metadata?: Record<string, string>;
}

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  failureMessage?: string;
}

export interface Refund {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export interface PaymentGateway {
  createPaymentIntent(amount: number, currency: string, metadata?: Record<string, string>): Promise<PaymentIntent>;
  capturePayment(paymentId: string, amount?: number): Promise<Charge>;
  refundPayment(paymentId: string, amount?: number): Promise<Refund>;
  verifyWebhookSignature(payload: Buffer, signature: string): boolean;
}