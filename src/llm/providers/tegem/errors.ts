export class GeminiQuotaError extends Error {
  constructor(
    public readonly rawMessage: string,
  ) {
    super(`Quota Gemini esaurita: ${rawMessage}`);
    this.name = "GeminiQuotaError";
  }
}

export class GeminiTimeoutError extends Error {
  constructor(reason: string) {
    super(`Timeout Gemini: ${reason}`);
    this.name = "GeminiTimeoutError";
  }
}

export class GeminiNotReadyError extends Error {
  constructor(reason = "Esegui il login prima.") {
    super(`Gemini non è pronto. ${reason}`);
    this.name = "GeminiNotReadyError";
  }
}
