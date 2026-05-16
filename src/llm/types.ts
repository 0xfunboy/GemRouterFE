import type { SemanticProfile } from '../lib/semantics.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMBackendId = 'gemini-api';
export type LLMBackendPreference = 'auto' | LLMBackendId;

/** 'small' = classificazione/routing rapido | 'medium' = drafting | 'large' = reasoning complesso */
export type ModelTier = 'small' | 'medium' | 'large';

export interface LLMFallbackAttempt {
  model: string;
  backend?: LLMBackendId;
  provider?: string;
  keyId?: string | null;
  quotaGroup?: string | null;
  reason: string;
  statusCode?: number | null;
  availableAfter?: string | null;
  availableAfterSource?: 'retry-after' | null;
}

export interface LLMOptions {
  model?: string;
  allowedModelIds?: string[];
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  semanticProfile?: SemanticProfile;
  backendPreference?: LLMBackendPreference;
  thinking?: {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  };
  imageConfig?: {
    aspectRatio?: string;
    imageSize?: string;
    responseModalities?: Array<'TEXT' | 'IMAGE'>;
  };
}

export interface LLMResponse {
  content: string;
  images?: Array<{
    mimeType: string;
    data: string;
  }>;
  provider: string;
  model: string;
  tokensUsed?: number;
  backend?: LLMBackendId;
  backendModel?: string;
  apiKeyId?: string;
  quotaGroup?: string;
  quotaSource?: 'static-config' | 'local-ledger' | 'aistudio-scrape' | 'upstream-error';
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  fallbackFrom?: LLMBackendId;
  fallbackReason?: string;
  fallbackAttempts?: LLMFallbackAttempt[];
  latencyMs?: number;
}

export interface LLMStreamChunk {
  content: string;
}

export interface LLMClient {
  chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse>;
  streamChat?(
    messages: LLMMessage[],
    opts?: LLMOptions,
  ): AsyncGenerator<LLMStreamChunk, LLMResponse, void>;
  prewarmSessions?(sessions: LLMOptions[]): Promise<void>;
  getDiagnostics?(): Record<string, unknown>;
  readonly provider: string;
  readonly model: string;
}
