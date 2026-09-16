export const CODEX_MODELS = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'] as const;
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
export const isCodexModel = (id: string): boolean => (CODEX_MODELS as readonly string[]).includes(id.trim().toLowerCase().replace(/^models\//, ''));
export const isCodexRequest = (id: string): boolean => /^gpt-/i.test(id.trim().replace(/^models\//, ''));
