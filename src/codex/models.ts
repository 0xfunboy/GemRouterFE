// Historical bootstrap IDs only. Newly released models enter via live discovery,
// so they can be identified as new and granted only to opted-in apps.
export const CODEX_MODELS = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'] as const;
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
// Syntax, not entitlement. The account's actual catalog and the app allowlist
// must both authorize every request; new catalog IDs need no code deployment.
export const isCodexModel = (id: string): boolean => /^gpt-[a-z0-9][a-z0-9.-]{0,95}$/.test(id.trim().toLowerCase().replace(/^models\//, ''));
export const isCodexReasoningEffort = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
export const isCodexRequest = (id: string): boolean => /^gpt-/i.test(id.trim().replace(/^models\//, ''));
