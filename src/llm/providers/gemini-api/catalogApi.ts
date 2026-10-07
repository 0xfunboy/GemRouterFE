import type { GeminiApiProviderConfig } from './types.js';

export interface GeminiCatalogModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/** A partial/failed page is never evidence that a model has disappeared. */
export async function fetchGeminiCatalog(config: Pick<GeminiApiProviderConfig, 'baseUrl' | 'version'>, key: string): Promise<GeminiCatalogModel[]> {
  const signal = AbortSignal.timeout(20_000);
  const models = new Map<string, GeminiCatalogModel>();
  const seen = new Set<string>();
  let token = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/${config.version}/models`);
    url.searchParams.set('pageSize', '1000');
    if (token) url.searchParams.set('pageToken', token);
    const response = await fetch(url, { headers: { 'x-goog-api-key': key }, signal, redirect: 'error' });
    if (!response.ok) throw new Error(`gemini_catalog_http_${response.status}`);
    const body = await response.json() as { models?: GeminiCatalogModel[]; nextPageToken?: unknown };
    if (!Array.isArray(body.models) || body.models.some((model) => !model || typeof model.name !== 'string' || !model.name.startsWith('models/'))
      || (body.nextPageToken != null && typeof body.nextPageToken !== 'string')) throw new Error('gemini_catalog_invalid_response');
    for (const model of body.models) models.set(model.name, model);
    token = body.nextPageToken as string || '';
    if (!token) return [...models.values()];
    if (seen.has(token)) throw new Error('gemini_catalog_repeated_page');
    seen.add(token);
  }
  throw new Error('gemini_catalog_page_limit');
}

export type GeminiAccessDenial = 'model_not_found' | 'quota_limit_zero';

/** Exhausted nonzero quota, auth errors and transient failures are NOT lost access. */
export function geminiAccessDenial(status: number, payload: unknown): GeminiAccessDenial | null {
  const error = (payload as { error?: { status?: unknown; message?: unknown } } | null)?.error;
  if (status === 404 && error?.status === 'NOT_FOUND') return 'model_not_found';
  if (status === 429 && error?.status === 'RESOURCE_EXHAUSTED' && typeof error.message === 'string'
    && /(?:^|\n)\* Quota exceeded for metric:\s*generativelanguage\.googleapis\.com\/generate_content[^\n]*,\s*limit:\s*0(?:\s*,|\s*$)/u.test(error.message)) return 'quota_limit_zero';
  return null;
}
