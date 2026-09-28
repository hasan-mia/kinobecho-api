export interface PushProvider {
  sendToTokens(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; failedTokens: string[] }>;
}