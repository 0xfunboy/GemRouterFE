export interface AiStudioQuotaScraperSnapshot {
  enabled: false;
  observedFromUi: false;
  lastRefreshAt: null;
  lastError: null;
}

export function getAiStudioQuotaScraperSnapshot(): AiStudioQuotaScraperSnapshot {
  return {
    enabled: false,
    observedFromUi: false,
    lastRefreshAt: null,
    lastError: null,
  };
}

