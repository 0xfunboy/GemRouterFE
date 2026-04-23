import type { ApiSurface } from './compatibility.js';
import type { LLMMessage } from '../llm/types.js';

export type SemanticChannel = 'chat' | 'responses' | 'generate' | 'admin';
export type SemanticOutputMode = 'text' | 'json';

export interface SemanticProfile {
  surface: ApiSurface;
  channel: SemanticChannel;
  outputMode: SemanticOutputMode;
  jsonSchema?: unknown;
}

function buildBaseInstruction(profile: SemanticProfile): string {
  const common = [
    'You are producing the final user-visible assistant payload for a compatibility router.',
    'Return only the payload content that the target API client should receive.',
    'Do not mention Gemini, Playwright, routing, translation, simulation, or provider internals.',
    'Do not prepend role labels such as "assistant:" or "response:".',
    'If the user asks for an exact literal reply, output that literal and nothing else.',
    'Never expose hidden reasoning, chain-of-thought, or <think> blocks in the final answer.',
  ];

  switch (profile.surface) {
    case 'deepseek':
      common.unshift(
        'Simulate the final assistant content of a DeepSeek chat model.',
        'Behave like a DeepSeek-compatible assistant message, not like an OpenAI wrapper.',
      );
      break;
    case 'ollama':
      if (profile.channel === 'generate') {
        common.unshift(
          'Simulate the final completion text of an Ollama /api/generate response.',
          'Return only the generated completion string, as if produced by a local Ollama model.',
        );
      } else {
        common.unshift(
          'Simulate the final assistant message content of an Ollama /api/chat response.',
          'Behave like an Ollama-compatible assistant message, not like an OpenAI chat wrapper.',
        );
      }
      break;
    default:
      common.unshift('Simulate the final assistant content of an OpenAI-compatible chat model.');
      break;
  }

  if (profile.outputMode === 'json') {
    common.push('JSON mode is active.');
    common.push('Return only valid JSON with no markdown fences, prose, labels, or trailing text.');
    if (profile.jsonSchema !== undefined) {
      common.push(`Match this schema as closely as possible: ${JSON.stringify(profile.jsonSchema)}`);
    }
  } else if (profile.channel === 'generate') {
    common.push('This is completion mode. Return the completion only, without commentary about how you generated it.');
  }

  return common.join('\n');
}

export function applySemanticPrompt(messages: LLMMessage[], profile?: SemanticProfile): LLMMessage[] {
  if (!profile) return messages;
  return [{ role: 'system', content: buildBaseInstruction(profile) }, ...messages];
}

function stripThinkBlocks(text: string, partial = false): string {
  if (!text) return '';
  if (partial) {
    return text.replace(/<\/?think>/gi, '');
  }
  let normalized = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  normalized = normalized.replace(/<\/?think>/gi, '');
  return normalized;
}

function stripAssistantPrefix(text: string): string {
  return text.replace(/^\s*(?:assistant|response|answer)\s*:\s*/i, '');
}

function unwrapSingleFence(text: string): string {
  const match = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  return match?.[1]?.trim() ?? text;
}

function extractBalancedJson(text: string): string | null {
  const candidates = ['{', '[']
    .map((token) => ({ token, index: text.indexOf(token) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);

  if (candidates.length === 0) return null;

  const start = candidates[0]?.index ?? -1;
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const last = stack.at(-1);
      if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
        stack.pop();
        if (stack.length === 0) {
          return text.slice(start, index + 1).trim();
        }
      }
    }
  }

  return null;
}

function normalizeLooseJson(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/^json\s*/i, '');
  normalized = unwrapSingleFence(normalized).trim();
  normalized = normalized.replace(/^[^{\[]*([{\[])/s, '$1');
  normalized = normalized.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/g, '$1"$2":');
  normalized = normalized.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value: string) => `"${value.replace(/"/g, '\\"')}"`);
  normalized = normalized.replace(/,(\s*[}\]])/g, '$1');
  return normalized.trim();
}

function normalizeJsonPayload(text: string): string {
  const raw = stripAssistantPrefix(stripThinkBlocks(text)).trim();
  const fenced = unwrapSingleFence(raw).trim();
  const candidates = [
    fenced,
    extractBalancedJson(fenced) ?? '',
    normalizeLooseJson(fenced),
    normalizeLooseJson(extractBalancedJson(fenced) ?? fenced),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.stringify(JSON.parse(candidate));
    } catch {
      // keep trying
    }
  }

  return raw;
}

function normalizeTextPayload(text: string, profile?: SemanticProfile, partial = false): string {
  let normalized = stripThinkBlocks(text, partial);
  normalized = stripAssistantPrefix(normalized);
  if (!partial) {
    normalized = unwrapSingleFence(normalized);
  }
  normalized = normalized.trim();

  if (!partial && profile?.surface === 'ollama' && profile.channel === 'generate') {
    const quoted = normalized.match(/^"([^"\n]+)"$/s);
    if (quoted?.[1]) return quoted[1];
  }

  return normalized;
}

export function normalizeSemanticOutput(
  text: string,
  profile?: SemanticProfile,
  options?: { partial?: boolean },
): string {
  if (!profile) return normalizeTextPayload(text, undefined, options?.partial === true);
  if (profile.outputMode === 'json' && options?.partial !== true) {
    return normalizeJsonPayload(text);
  }
  return normalizeTextPayload(text, profile, options?.partial === true);
}
