export interface MailProvider {
  sendMail(to: string, subject: string, html: string): Promise<{ providerRef: string }>;
}