import net from 'node:net';

import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type OutboundProxyStrategy = 'single' | 'round-robin' | 'random';

export interface OutboundProxyConfig {
  enabled: boolean;
  required: boolean;
  urls: string[];
  strategy: OutboundProxyStrategy;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  bypassHosts: string[];
  bypassPrivateIps: boolean;
}

export interface ProxiedFetch {
  fetch: typeof fetch;
  snapshot(): Record<string, unknown>;
}

export class OutboundProxyError extends Error {
  constructor(
    message: string,
    public readonly code: 'proxy_required' | 'proxy_missing' | 'proxy_request_failed',
    public readonly statusCode = 502,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OutboundProxyError';
  }
}

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: ProxyAgent;
};

function normalizeHost(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIp(hostname: string): boolean {
  const host = normalizeHost(hostname);
  const version = net.isIP(host);
  if (version === 4) {
    const parts = host.split('.').map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (version === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '[invalid-proxy-url]';
  }
}

function hostMatches(pattern: string, hostname: string): boolean {
  const cleanPattern = normalizeHost(pattern);
  const cleanHost = normalizeHost(hostname);
  if (!cleanPattern) return false;
  if (cleanPattern === cleanHost) return true;
  if (cleanPattern.startsWith('*.')) return cleanHost.endsWith(cleanPattern.slice(1));
  return false;
}

export function createProxiedFetch(config: OutboundProxyConfig): ProxiedFetch {
  const agents = config.urls.map((url) => ({
    url,
    redactedUrl: redactProxyUrl(url),
    agent: new ProxyAgent({
      uri: url,
      connect: {
        timeout: config.connectTimeoutMs,
      },
      requestTls: {},
      proxyTls: {},
    }),
  }));
  let roundRobinIndex = 0;

  function shouldBypass(target: URL): boolean {
    const hostname = normalizeHost(target.hostname);
    if (config.bypassHosts.some((host) => hostMatches(host, hostname))) return true;
    if (config.bypassPrivateIps && isPrivateIp(hostname)) return true;
    return false;
  }

  function selectAgent(): typeof agents[number] | null {
    if (agents.length === 0) return null;
    if (config.strategy === 'random') {
      return agents[Math.floor(Math.random() * agents.length)];
    }
    if (config.strategy === 'round-robin') {
      const selected = agents[roundRobinIndex % agents.length];
      roundRobinIndex += 1;
      return selected;
    }
    return agents[0];
  }

  const proxiedFetch: typeof fetch = async (input, init = {}) => {
    const target = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(String(input));
    if (!config.enabled) {
      return globalThis.fetch(input, init);
    }

    if (shouldBypass(target)) {
      return globalThis.fetch(input, {
        signal: init.signal ?? AbortSignal.timeout(config.requestTimeoutMs),
        ...init,
      });
    }

    const selected = selectAgent();
    if (!selected) {
      throw new OutboundProxyError(
        config.required
          ? 'Outbound proxy is required but no proxy URL is configured.'
          : 'Outbound proxy is enabled but no proxy URL is configured.',
        'proxy_missing',
        config.required ? 503 : 502,
      );
    }

    try {
      const undiciInput = input instanceof Request ? input.url : input;
      return await undiciFetch(undiciInput, {
        signal: init.signal ?? AbortSignal.timeout(config.requestTimeoutMs),
        ...init,
        dispatcher: selected.agent,
      } as Parameters<typeof undiciFetch>[1] & FetchInitWithDispatcher) as unknown as Response;
    } catch (error) {
      throw new OutboundProxyError(
        `Outbound proxy request failed via ${selected.redactedUrl}`,
        'proxy_request_failed',
        502,
        error,
      );
    }
  };

  return {
    fetch: proxiedFetch,
    snapshot(): Record<string, unknown> {
      return {
        enabled: config.enabled,
        required: config.required,
        strategy: config.strategy,
        configuredProxyCount: agents.length,
        proxies: agents.map((agent) => agent.redactedUrl),
        connectTimeoutMs: config.connectTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        bypassHosts: config.bypassHosts,
        bypassPrivateIps: config.bypassPrivateIps,
      };
    },
  };
}

export function redactOutboundProxyConfig(config: OutboundProxyConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    required: config.required,
    strategy: config.strategy,
    configuredProxyCount: config.urls.length,
    proxies: config.urls.map(redactProxyUrl),
    connectTimeoutMs: config.connectTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    bypassHosts: config.bypassHosts,
    bypassPrivateIps: config.bypassPrivateIps,
  };
}
