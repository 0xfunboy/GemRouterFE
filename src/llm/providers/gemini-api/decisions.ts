import { GeminiApiProviderError } from './errors.js';

export const GEMINI_DECISION_MODEL = 'gemini-decision-1';

interface DecisionRequest {
  model: typeof GEMINI_DECISION_MODEL;
  input: string | Record<string, unknown> | unknown[];
  questions: Record<string, unknown>;
}

export interface GeminiDecisionResponse {
  answers: Record<string, unknown>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number };
}

export interface GeminiDecisionResult {
  body: GeminiDecisionResponse;
  keyId: string;
  quotaGroup: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new GeminiApiProviderError('gemini_api_invalid_request', message, { statusCode: 400 });
}

export function validateDecisionRequest(value: unknown): DecisionRequest {
  if (!object(value) || value.model !== GEMINI_DECISION_MODEL) {
    invalid(`The Decisions API requires model ${GEMINI_DECISION_MODEL}.`);
  }
  const { input, questions } = value;
  if (!(typeof input === 'string' && input.trim()) && !object(input) && !(Array.isArray(input) && input.length)) {
    invalid('Provide text or inline media as the decision input.');
  }
  if (!object(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 1000) {
    invalid('Provide between 1 and 1,000 questions keyed by question ID.');
  }
  for (const question of Object.values(questions)) {
    if (!object(question) || !['noul', 'choice', 'score'].includes(String(question.type))) {
      invalid('Each question must have type noul, choice, or score.');
    }
  }

  // Provider accounts are pooled across apps. A Google Files URI would be resolved
  // with the selected project's credential, which does not establish file ownership.
  const pending: unknown[] = [input, questions];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
    } else if (object(node)) {
      if (typeof node.uri === 'string' && (Object.hasOwn(node, 'type') || /^(?:[a-z][a-z0-9+.-]*:|\/?files\/)/i.test(node.uri))) {
        invalid('Use inline media data instead of a provider file URI.');
      }
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  return { model: GEMINI_DECISION_MODEL, input, questions };
}

/** Inline media is billed after decoding. Its base64 transport size can exceed
 * a full minute of text tokens even for a modest image. In that case reserve
 * the minute's ceiling until Google returns actual input usage. */
export function encodeDecisionRequest(request: DecisionRequest, tpmLimit?: number | null): { body: string; estimatedTokens: number } {
  let mediaBytes = 0;
  const body = JSON.stringify(request, (_key, value: unknown) => {
    if (object(value) && ['audio', 'document', 'image', 'video'].includes(String(value.type)) && typeof value.data === 'string') {
      mediaBytes += Buffer.byteLength(value.data);
    }
    return value;
  });
  const length = Buffer.byteLength(body);
  const estimate = (bytes: number) => Math.ceil(bytes / 4 * 1.15);
  const estimatedTokens = mediaBytes && tpmLimit
    ? Math.max(estimate(length - mediaBytes), Math.min(estimate(length), tpmLimit))
    : estimate(length);
  return { body, estimatedTokens };
}

export function isDecisionResponse(value: unknown, request: DecisionRequest): value is GeminiDecisionResponse {
  if (!object(value) || !object(value.answers)) return false;
  const answers = value.answers;
  return Object.entries(request.questions).every(([id, question]) =>
    Object.hasOwn(answers, id) && object(answers[id]) && object(question) && answers[id].type === question.type,
  );
}
