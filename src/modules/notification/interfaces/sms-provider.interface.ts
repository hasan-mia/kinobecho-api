/**
 * Outbound SMS transport.
 *
 * Implementations must be side-effect free apart from sending, and must throw on
 * failure so the caller can record a FAILED `NotificationLog` row — a provider
 * that swallows errors would make a failed send look delivered.
 */
export interface SmsProvider {
  sendSms(to: string, text: string): Promise<{ providerRef: string }>;
}
