import 'dotenv/config';

import {
  createProxiedFetch,
  OutboundProxyError,
  type OutboundProxyConfig,
  type OutboundProxyStrategy,
} from '../src/net/outboundProxy.js';

function pick(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function readBoolean(fallback: boolean, ...keys: string[]): boolean {
  const value = pick(...keys);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumber(fallback: number, ...keys: string[]): number {
  const parsed = Number(pick(...keys));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readList(fallback: string[], ...keys: string[]): string[] {
  const value = pick(...keys);
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function readStrategy(): OutboundProxyStrategy {
  const value = pick('LEAKROUTER_OUTBOUND_PROXY_STRATEGY')?.toLowerCase();
  if (value === 'round-robin' || value === 'random') return value;
  return 'single';
}

function readProxyConfig(): OutboundProxyConfig {
  const urls = readList([], 'LEAKROUTER_OUTBOUND_PROXY_URLS');
  const singleUrl = pick('LEAKROUTER_OUTBOUND_PROXY_URL');
  return {
    enabled: readBoolean(false, 'LEAKROUTER_OUTBOUND_PROXY_ENABLED'),
    required: readBoolean(true, 'LEAKROUTER_OUTBOUND_PROXY_REQUIRED'),
    urls: urls.length > 0 ? urls : singleUrl ? [singleUrl] : [],
    strategy: readStrategy(),
    connectTimeoutMs: readNumber(10_000, 'LEAKROUTER_PROXY_CONNECT_TIMEOUT_MS'),
    requestTimeoutMs: readNumber(120_000, 'LEAKROUTER_PROXY_REQUEST_TIMEOUT_MS'),
    bypassHosts: readList(['localhost', '127.0.0.1', '::1'], 'LEAKROUTER_OUTBOUND_PROXY_BYPASS_HOSTS'),
    bypassPrivateIps: readBoolean(true, 'LEAKROUTER_OUTBOUND_PROXY_BYPASS_PRIVATE_IPS'),
  };
}

const direct = process.argv.includes('--direct');
const testUrl = pick('LEAKROUTER_EGRESS_TEST_URL') ?? 'https://api.ipify.org?format=json';

if (direct) {
  const response = await fetch(testUrl, {
    signal: AbortSignal.timeout(readNumber(120_000, 'LEAKROUTER_PROXY_REQUEST_TIMEOUT_MS')),
  });
  console.log(await response.text());
  process.exit(response.ok ? 0 : 1);
}

const proxyConfig = readProxyConfig();
if (!proxyConfig.enabled) {
  console.error('Proxy test refused: LEAKROUTER_OUTBOUND_PROXY_ENABLED is not true. Use --direct only for explicit direct comparison.');
  process.exit(2);
}

const proxiedFetch = createProxiedFetch(proxyConfig);
try {
  const response = await proxiedFetch.fetch(testUrl);
  console.log(await response.text());
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  if (error instanceof OutboundProxyError) {
    console.error(`Proxy test failed closed: ${error.message} (${error.code})`);
    process.exit(error.statusCode >= 500 ? 1 : 2);
  }
  console.error(`Proxy test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
