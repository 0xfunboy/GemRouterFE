import { LLMProviderError } from '../llm/errors.js';
import type { LLMBackendPreference, LLMOptions } from '../llm/types.js';
import type { ApiAppRecord } from '../store/appStore.js';
import { CODEX_REASONING_EFFORTS } from './models.js';

/** Derive trusted provider policy from the app record, never from the request body. */
export function codexRequestPolicy(body: unknown, header: unknown, app: ApiAppRecord, preference?: LLMBackendPreference): NonNullable<LLMOptions['codex']> {
  const invalid = (message: string): never => { throw new LLMProviderError('codex_invalid_input', 'codex', message, { statusCode: 400 }); };
  if (preference && preference !== 'auto' && preference !== 'codex') invalid('A GPT model must use the Codex provider.');
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const reasoning = raw.reasoning;
  if (reasoning !== undefined && (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning))) invalid('reasoning must be an object.');
  const values = [raw.reasoning_effort, (reasoning as Record<string, unknown> | undefined)?.effort, header].filter((v) => v !== undefined);
  if (values.some((v) => typeof v !== 'string' || !(CODEX_REASONING_EFFORTS as readonly string[]).includes(v))) invalid('Unsupported reasoning effort.');
  if (new Set(values).size > 1) invalid('Conflicting reasoning effort parameters.');
  if (Array.isArray(raw.tools) && raw.tools.length) invalid('Codex inference does not expose tools.');
  if (raw.tool_choice !== undefined && raw.tool_choice !== 'none') invalid('Codex inference does not expose tools.');
  return { enabled: app.codexEnabled === true, reasoningEffort: values[0] as string | undefined ?? app.codexReasoningEffort,
    fallbackEnabled: app.codexFallbackEnabled !== false };
}
