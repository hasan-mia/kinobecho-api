export class PermanentRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentRecipientError';
  }
}

export function isPermanentRecipientError(error: unknown): boolean {
  return error instanceof PermanentRecipientError;
}
