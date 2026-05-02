import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

import { OAuth2Client, type Credentials } from 'google-auth-library';

import type {
  GeminiAvailableCredit,
  GeminiCliHealthSnapshot,
  GeminiCliProviderConfig,
  GeminiQuotaBucket,
} from '../llm/providers/gemini-cli/types.js';

interface GeminiCliAuthFiles {
  settingsPath: string;
  oauthCredsPath: string;
  googleAccountsPath: string;
}

export interface GeminiCliRuntimeState {
  authReady?: boolean | null;
  authVerifiedAt?: string | null;
  lastError?: string | null;
  lastSuccessAt?: string | null;
  lastLatencyMs?: number | null;
  lastResolvedModel?: string | null;
  projectId?: string | null;
  userTier?: string | null;
  userTierName?: string | null;
  availableCredits?: GeminiAvailableCredit[];
  quotaBuckets?: GeminiQuotaBucket[];
  quotaUpdatedAt?: string | null;
  quotaLastError?: string | null;
}

interface CachedAccounts {
  active: string | null;
  old: string[];
}

export interface GeminiCliAuthState {
  dotGeminiDir: string;
  settingsExists: boolean;
  authCacheDetected: boolean;
  authCacheFiles: string[];
  selectedAuthType: string | null;
  activeAccount: string | null;
}

const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const SIGN_IN_SUCCESS_HTML = '<html><body><h1>GemRouterFE login complete</h1><p>You can close this tab.</p></body></html>';
const SIGN_IN_FAILURE_HTML = '<html><body><h1>GemRouterFE login failed</h1><p>You can close this tab and retry.</p></body></html>';

function requireOAuthClientConfig(config: GeminiCliProviderConfig): { clientId: string; clientSecret: string } {
  const clientId = config.authClientId?.trim();
  const clientSecret = config.authClientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Gemini OAuth client is not configured. Set GEMINI_AUTH_CLIENT_ID and GEMINI_AUTH_CLIENT_SECRET in .env before using direct auth or pnpm login:gemini-cli.',
    );
  }
  return { clientId, clientSecret };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, payload: unknown, mode?: number): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), mode ? { mode } : undefined);
}

function parseCachedAccounts(input: unknown): CachedAccounts {
  if (!input || typeof input !== 'object') {
    return { active: null, old: [] };
  }
  const typed = input as { active?: unknown; old?: unknown };
  return {
    active: typeof typed.active === 'string' && typed.active.trim() ? typed.active.trim() : null,
    old: Array.isArray(typed.old) ? typed.old.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [],
  };
}

function readAuthFiles(config: GeminiCliProviderConfig): GeminiCliAuthFiles {
  const dotDir = resolveGeminiCliDotDir(config);
  return {
    settingsPath: path.join(dotDir, 'settings.json'),
    oauthCredsPath: path.join(dotDir, 'oauth_creds.json'),
    googleAccountsPath: path.join(dotDir, 'google_accounts.json'),
  };
}

function readSettingsSelectedAuthType(settingsPath: string): string | null {
  const settings = readJson<Record<string, unknown>>(settingsPath);
  if (!settings || typeof settings !== 'object') return null;
  const security = settings.security;
  if (!security || typeof security !== 'object') return null;
  const auth = (security as Record<string, unknown>).auth;
  if (!auth || typeof auth !== 'object') return null;
  const selectedType = (auth as Record<string, unknown>).selectedType;
  return typeof selectedType === 'string' && selectedType.trim() ? selectedType.trim() : null;
}

async function setSettingsSelectedAuthType(settingsPath: string, selectedType: string): Promise<void> {
  const current = readJson<Record<string, unknown>>(settingsPath) ?? {};
  const security = current.security && typeof current.security === 'object'
    ? { ...(current.security as Record<string, unknown>) }
    : {};
  const auth = security.auth && typeof security.auth === 'object'
    ? { ...(security.auth as Record<string, unknown>) }
    : {};
  auth.selectedType = selectedType;
  security.auth = auth;
  current.security = security;
  await writeJson(settingsPath, current);
}

function readCachedCredentials(config: GeminiCliProviderConfig): Credentials | null {
  const files = readAuthFiles(config);
  const parsed = readJson<Record<string, unknown>>(files.oauthCredsPath);
  if (!parsed) return null;
  return parsed as unknown as Credentials;
}

async function cacheCredentials(config: GeminiCliProviderConfig, credentials: Credentials): Promise<void> {
  const files = readAuthFiles(config);
  await writeJson(files.oauthCredsPath, credentials, 0o600);
}

async function cacheGoogleAccount(config: GeminiCliProviderConfig, email: string): Promise<void> {
  const files = readAuthFiles(config);
  const current = parseCachedAccounts(readJson(files.googleAccountsPath));
  if (current.active && current.active !== email && !current.old.includes(current.active)) {
    current.old.push(current.active);
  }
  current.old = current.old.filter((value) => value !== email);
  current.active = email;
  await writeJson(files.googleAccountsPath, current);
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };
  const child = spawn(command.cmd, command.args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function fetchAndCacheUserInfo(client: OAuth2Client, config: GeminiCliProviderConfig): Promise<string | null> {
  const token = await client.getAccessToken();
  if (!token?.token) return null;
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${token.token}`,
    },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { email?: unknown };
  if (typeof payload.email !== 'string' || !payload.email.trim()) return null;
  const email = payload.email.trim();
  await cacheGoogleAccount(config, email);
  return email;
}

async function verifyCachedClient(client: OAuth2Client, config: GeminiCliProviderConfig): Promise<void> {
  const token = await client.getAccessToken();
  if (!token?.token) throw new Error('Cached Gemini credentials did not produce an access token.');
  await client.getTokenInfo(token.token);
  await fetchAndCacheUserInfo(client, config).catch(() => null);
}

export function resolveGeminiCliUserHome(config: GeminiCliProviderConfig): string | null {
  if (config.userHome?.trim()) return path.resolve(config.userHome);
  if (config.dotGeminiDir?.trim()) {
    const explicit = path.resolve(config.dotGeminiDir);
    if (path.basename(explicit) === '.gemini') return path.dirname(explicit);
  }
  const home = process.env.HOME?.trim();
  return home ? path.resolve(home) : null;
}

export function resolveGeminiCliDotDir(config: GeminiCliProviderConfig): string {
  if (config.dotGeminiDir?.trim()) return path.resolve(config.dotGeminiDir);
  const home = resolveGeminiCliUserHome(config);
  return path.join(home ?? config.rootDir, '.gemini');
}

export function detectGeminiCliAuth(config: GeminiCliProviderConfig): GeminiCliAuthState {
  const dotGeminiDir = resolveGeminiCliDotDir(config);
  const authFiles = readAuthFiles(config);
  const authCacheFiles = [authFiles.oauthCredsPath, authFiles.googleAccountsPath].filter((file) => existsSync(file));
  const accounts = parseCachedAccounts(readJson(authFiles.googleAccountsPath));
  return {
    dotGeminiDir,
    settingsExists: existsSync(authFiles.settingsPath),
    authCacheDetected: authCacheFiles.length > 0 && existsSync(authFiles.oauthCredsPath),
    authCacheFiles,
    selectedAuthType: readSettingsSelectedAuthType(authFiles.settingsPath),
    activeAccount: accounts.active,
  };
}

export function buildGeminiCliLoginHint(_config: GeminiCliProviderConfig): string {
  return 'pnpm login:gemini-cli';
}

export async function loadGeminiCachedOAuthClient(
  config: GeminiCliProviderConfig,
): Promise<{ client: OAuth2Client; activeAccount: string | null } | null> {
  const credentials = readCachedCredentials(config);
  if (!credentials) return null;
  const oauth = requireOAuthClientConfig(config);

  const client = new OAuth2Client({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
  });
  client.setCredentials(credentials);
  await verifyCachedClient(client, config);
  const authState = detectGeminiCliAuth(config);
  return {
    client,
    activeAccount: authState.activeAccount,
  };
}

export async function getAvailableCallbackPort(explicitPort?: number): Promise<number> {
  if (explicitPort && explicitPort > 0) return explicitPort;
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Unable to determine local OAuth callback port.'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function runGeminiBrowserLogin(
  config: GeminiCliProviderConfig,
): Promise<{ accountEmail: string | null; callbackPort: number }> {
  const oauth = requireOAuthClientConfig(config);
  const client = new OAuth2Client({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
  });
  const callbackPort = await getAvailableCallbackPort(config.callbackPort);
  const redirectUri = `http://${config.callbackHost}:${callbackPort}/oauth2callback`;
  const state = randomBytes(24).toString('hex');
  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: OAUTH_SCOPE,
    state,
    prompt: 'consent',
  });

  const completion = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/oauth2callback') {
          response.statusCode = 404;
          response.end(SIGN_IN_FAILURE_HTML);
          reject(new Error(`Unexpected OAuth callback path: ${requestUrl.pathname}`));
          return;
        }

        const error = requestUrl.searchParams.get('error');
        if (error) {
          response.statusCode = 400;
          response.end(SIGN_IN_FAILURE_HTML);
          reject(new Error(`Google OAuth returned ${error}.`));
          return;
        }

        if (requestUrl.searchParams.get('state') !== state) {
          response.statusCode = 400;
          response.end(SIGN_IN_FAILURE_HTML);
          reject(new Error('Gemini OAuth state mismatch.'));
          return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          response.statusCode = 400;
          response.end(SIGN_IN_FAILURE_HTML);
          reject(new Error('No authorization code received from Google.'));
          return;
        }

        const tokenResponse = await client.getToken({
          code,
          redirect_uri: redirectUri,
        });
        client.setCredentials(tokenResponse.tokens);
        await cacheCredentials(config, tokenResponse.tokens);
        await setSettingsSelectedAuthType(readAuthFiles(config).settingsPath, 'oauth-personal');
        await fetchAndCacheUserInfo(client, config).catch(() => null);
        response.statusCode = 200;
        response.end(SIGN_IN_SUCCESS_HTML);
        resolve();
      } catch (error) {
        response.statusCode = 500;
        response.end(SIGN_IN_FAILURE_HTML);
        reject(error);
      } finally {
        server.close();
      }
    });

    server.listen(callbackPort, config.callbackHost);
    server.on('error', reject);
  });

  console.log(`[gemini-auth] OAuth callback listening on ${config.callbackHost}:${callbackPort}`);
  console.log(`[gemini-auth] Open this URL if the browser does not launch automatically:\n${authUrl}\n`);
  if (config.autoOpenBrowser) {
    try {
      tryOpenBrowser(authUrl);
    } catch (error) {
      console.warn('[gemini-auth] Browser auto-open failed:', error instanceof Error ? error.message : String(error));
    }
  }

  await Promise.race([
    completion,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Gemini OAuth login timed out after 5 minutes.')), 300_000)),
  ]);

  const verified = await loadGeminiCachedOAuthClient(config);
  return {
    accountEmail: verified?.activeAccount ?? null,
    callbackPort,
  };
}

export function buildGeminiCliHealthSnapshot(
  config: GeminiCliProviderConfig,
  runtimeState: GeminiCliRuntimeState = {},
): GeminiCliHealthSnapshot {
  const auth = detectGeminiCliAuth(config);
  return {
    enabled: config.enabled,
    runtime: 'embedded-codeassist',
    externalDependency: false,
    available: config.enabled,
    model: config.model,
    models: [...config.models],
    timeoutMs: config.timeoutMs,
    quotaRefreshMs: config.quotaRefreshMs,
    userHome: resolveGeminiCliUserHome(config),
    dotGeminiDir: auth.dotGeminiDir,
    settingsExists: auth.settingsExists,
    authCacheDetected: auth.authCacheDetected,
    authCacheFiles: auth.authCacheFiles,
    selectedAuthType: auth.selectedAuthType,
    activeAccount: auth.activeAccount,
    authReady:
      typeof runtimeState.authReady === 'boolean'
        ? runtimeState.authReady
        : (auth.authCacheDetected || !config.expectAuthCache),
    authVerifiedAt: runtimeState.authVerifiedAt ?? null,
    callbackHost: config.callbackHost,
    callbackPort: config.callbackPort ?? null,
    autoOpenBrowser: config.autoOpenBrowser,
    bootstrapEnabled: config.authBootstrapEnabled,
    bootstrapMode: config.authBootstrapMode,
    projectId: runtimeState.projectId ?? null,
    userTier: runtimeState.userTier ?? null,
    userTierName: runtimeState.userTierName ?? null,
    availableCredits: runtimeState.availableCredits ?? [],
    quotaBuckets: runtimeState.quotaBuckets ?? [],
    quotaUpdatedAt: runtimeState.quotaUpdatedAt ?? null,
    quotaLastError: runtimeState.quotaLastError ?? null,
    lastResolvedModel: runtimeState.lastResolvedModel ?? null,
    loginHint: buildGeminiCliLoginHint(config),
    lastError: runtimeState.lastError ?? null,
    lastSuccessAt: runtimeState.lastSuccessAt ?? null,
    lastLatencyMs: runtimeState.lastLatencyMs ?? null,
  };
}
