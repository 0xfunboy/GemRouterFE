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

function sanitizeActionField(value: string): string {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/^\(\s*([A-Za-z0-9_:-]+)\s*\)$/);
  return wrapped?.[1] ?? trimmed;
}

function sanitizeParsedJsonValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeParsedJsonValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeParsedJsonValue(entryValue, entryKey),
      ]),
    );
  }

  if (key === 'action' && typeof value === 'string') {
    return sanitizeActionField(value);
  }

  return value;
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

function tryNormalizeJsonPayload(text: string): string | null {
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
      return JSON.stringify(sanitizeParsedJsonValue(JSON.parse(candidate)));
    } catch {
      // keep trying
    }
  }

  return null;
}

function normalizeJsonPayload(text: string): string {
  const raw = stripAssistantPrefix(stripThinkBlocks(text)).trim();
  return tryNormalizeJsonPayload(text) ?? raw;
}

function looksLikeJsonPayload(text: string): boolean {
  const raw = stripAssistantPrefix(stripThinkBlocks(text)).trim();
  if (!raw) return false;
  const unfenced = unwrapSingleFence(raw).trim();
  if (!unfenced) return false;
  if (/^json\b/i.test(unfenced)) return true;
  if (unfenced.startsWith('{') || unfenced.startsWith('[')) return true;
  const extracted = extractBalancedJson(unfenced);
  return extracted !== null;
}

type TradeDirection = 'LONG' | 'SHORT';
type TradeMetric = {
  value: string;
  pct?: string;
  qualifier?: 'around' | 'near' | 'at' | 'below' | 'above';
};

const TRADE_NUMBER_PATTERN = '\\$?\\d[\\d,]*(?:\\.\\d+)?';
const TRADE_PERCENT_PATTERN = '\\(([+\\-−]?\\d+(?:\\.\\d+)?)%\\)';

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function extractTradeDirection(text: string): TradeDirection | null {
  const hasLong = /\bLONG\b/i.test(text);
  const hasShort = /\bSHORT\b/i.test(text);
  if (hasLong === hasShort) return null;
  return hasLong ? 'LONG' : 'SHORT';
}

function extractTradeMetric(
  text: string,
  patterns: RegExp[],
): TradeMetric | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const groups = match?.groups as
      | {
          value?: string;
          qualifier?: string;
          pct?: string;
        }
      | undefined;
    const value = (groups?.value ?? match?.[1])?.replace(/,+$/g, '');
    if (!value) continue;
    const qualifier = groups?.qualifier?.toLowerCase() as TradeMetric['qualifier'] | undefined;
    const pct = groups?.pct ? `${groups.pct.replace(/−/g, '-')}` : undefined;
    return {
      value,
      qualifier,
      pct,
    };
  }
  return null;
}

function normalizeTradePctForDirection(
  pct: string | undefined,
  positive: boolean,
): string | undefined {
  if (!pct) return undefined;
  const trimmed = pct.trim().replace(/−/g, '-');
  if (!trimmed) return undefined;
  const unsigned = trimmed.replace(/^[+\-]/, '');
  return `${positive ? '+' : '-'}${unsigned}`;
}

function formatPct(pct?: string): string {
  return pct ? ` (${pct}%)` : '';
}

function normalizeTradeActionParagraph(paragraph: string): string {
  if (!/ACTION STRATEGY:/i.test(paragraph) || /\bSTAY OUT\b/i.test(paragraph)) {
    return paragraph;
  }

  const alreadyCanonical =
    /\bENTRY\b/i.test(paragraph) &&
    /\bTAKE\s+PROFIT\b/i.test(paragraph) &&
    /\bSTOP\s+LOSS\b/i.test(paragraph);
  if (alreadyCanonical) return paragraph;

  const direction = extractTradeDirection(paragraph);
  if (!direction) return paragraph;

  const entry = extractTradeMetric(paragraph, [
    new RegExp(`\\bENTRY\\b[^\\d$]{0,32}(?<value>${TRADE_NUMBER_PATTERN})`, 'i'),
    new RegExp(`\\benter(?:ing)?\\b(?:\\s+(?:a|an))?(?:\\s+(?:LONG|SHORT))?(?:\\s+position)?[^\\d$]{0,24}(?<value>${TRADE_NUMBER_PATTERN})`, 'i'),
    new RegExp(`\\b(?:LONG|SHORT)\\b[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})`, 'i'),
  ]);
  const takeProfit = extractTradeMetric(paragraph, [
    new RegExp(`\\bTAKE\\s+PROFIT\\b(?:\\s+(?<qualifier>around|near|at))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
    new RegExp(`\\bTP\\b(?:\\s+(?<qualifier>around|near|at))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
    new RegExp(`\\btarget(?:ing)?\\b[^\\d$]{0,20}(?:TP|TAKE\\s+PROFIT)?(?:\\s+(?<qualifier>around|near|at))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
  ]);
  const stopLoss = extractTradeMetric(paragraph, [
    new RegExp(`\\bSTOP\\s+LOSS\\b(?:\\s+(?<qualifier>below|above|at|near))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
    new RegExp(`\\bSL\\b(?:\\s+(?<qualifier>below|above|at|near))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
    new RegExp(`\\b(?:place|set)\\b[^\\d$]{0,20}(?:STOP\\s+LOSS|SL)(?:\\s+(?<qualifier>below|above|at|near))?[^\\d$]{0,20}(?<value>${TRADE_NUMBER_PATTERN})(?:\\s*\\((?<pct>[+\\-−]?\\d+(?:\\.\\d+)?)%\\))?`, 'i'),
  ]);

  if (!entry || !takeProfit || !stopLoss) return paragraph;

  const prefix = paragraph.replace(/^(\s*🧭\s*)?ACTION STRATEGY:\s*/i, '').trim();
  const shortLead = prefix
    .replace(/\s+/g, ' ')
    .replace(/\b(?:I|We)\s+(?:would|will)\b[\s\S]*$/i, '')
    .replace(/\b(?:LONG|SHORT)\b[\s\S]*$/i, '')
    .replace(/[,:;.\s]+$/g, '')
    .trim();
  const qualifier = stopLoss.qualifier ?? (direction === 'LONG' ? 'below' : 'above');
  const lead = shortLead ? `${shortLead}. ` : `${direction} setup. `;

  return [
    '🧭 ACTION STRATEGY:',
    `${lead}I would look for an ENTRY around ${entry.value}, aim for a TAKE PROFIT ${takeProfit.qualifier ?? 'near'} ${takeProfit.value}${formatPct(normalizeTradePctForDirection(takeProfit.pct, direction === 'LONG'))}, and place the STOP LOSS ${qualifier} ${stopLoss.value}${formatPct(normalizeTradePctForDirection(stopLoss.pct, direction === 'SHORT'))} to manage risk.`,
  ].join(' ');
}

function normalizeTradeOutput(text: string): string {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return text;
  let changed = false;
  const next = paragraphs.map((paragraph) => {
    const normalized = normalizeTradeActionParagraph(paragraph);
    changed ||= normalized !== paragraph;
    return normalized;
  });
  return changed ? next.join('\n\n') : text;
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

  return partial ? normalized : normalizeTradeOutput(normalized);
}

export function normalizeSemanticOutput(
  text: string,
  profile?: SemanticProfile,
  options?: { partial?: boolean },
): string {
  const partial = options?.partial === true;
  if (!partial && (profile?.outputMode === 'json' || looksLikeJsonPayload(text))) {
    const normalizedJson = tryNormalizeJsonPayload(text);
    if (normalizedJson) return normalizedJson;
  }
  if (!profile) return normalizeTextPayload(text, undefined, partial);
  if (profile.outputMode === 'json' && !partial) {
    return normalizeJsonPayload(text);
  }
  return normalizeTextPayload(text, profile, partial);
}
