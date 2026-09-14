import { createHash, randomBytes } from 'node:crypto';

import { normalizeWorkerId } from './protocol.js';
import { ChatGptGatewayStore, type OAuthAuthorizationRequestRecord } from './store.js';
import type { AuthenticatedMcpGrant } from './types.js';

const CLIENT_ID = /^grmcp_[a-f0-9]{32}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const ALLOWED_SCOPES = new Set(['mcp:tools', 'offline_access']);

export class ChatGptOAuthService {
  readonly issuer: string;

  constructor(
    private readonly store: ChatGptGatewayStore,
    publicBaseUrl: string,
  ) {
    this.issuer = canonicalChatGptOrigin(publicBaseUrl);
  }

  workerResource(workerId: string): string {
    return `${this.issuer}/mcp/chatgpt/${encodeURIComponent(normalizeWorkerId(workerId))}`;
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.issuer}/oauth/chatgpt/authorize`,
      token_endpoint: `${this.issuer}/oauth/chatgpt/token`,
      revocation_endpoint: `${this.issuer}/oauth/chatgpt/revoke`,
      registration_endpoint: `${this.issuer}/oauth/chatgpt/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...ALLOWED_SCOPES],
    };
  }

  protectedResourceMetadata(workerId: string): Record<string, unknown> {
    const resource = this.workerResource(workerId);
    return {
      resource,
      authorization_servers: [this.issuer],
      scopes_supported: ['mcp:tools', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: `GemRouter ChatGPT worker ${normalizeWorkerId(workerId)}`,
    };
  }

  registerClient(value: unknown): Record<string, unknown> {
    const workerId = this.store.activePairingWorker();
    if (!workerId) throw oauthError('registration_closed', 'Open exactly one worker pairing window from the GemRouter dashboard.');
    if (!isRecord(value)) throw oauthError('invalid_client_metadata', 'Registration body must be JSON.');
    const allowed = new Set(['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope',
      'client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'software_id', 'software_version', 'contacts']);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw oauthError('invalid_client_metadata', 'Unsupported registration metadata.');
    const clientName = value.client_name === undefined ? 'ChatGPT MCP connector' : boundedString(value.client_name, 120);
    if (!clientName) throw oauthError('invalid_client_metadata', 'Client name is invalid.');
    // Informational standard DCR metadata is bounded but never fetched, rendered,
    // or trusted as client identity or authorization policy.
    for (const key of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'software_id', 'software_version']) {
      if (value[key] !== undefined && !boundedString(value[key], 2048)) throw oauthError('invalid_client_metadata', `${key} is invalid.`);
    }
    if (value.contacts !== undefined && (!Array.isArray(value.contacts) || value.contacts.length > 8 || value.contacts.some((contact) => !boundedString(contact, 320)))) {
      throw oauthError('invalid_client_metadata', 'contacts is invalid.');
    }
    if (!Array.isArray(value.redirect_uris) || value.redirect_uris.length !== 1) {
      throw oauthError('invalid_redirect_uri', 'Exactly one redirect URI is required.');
    }
    const redirectUri = validateRedirectUri(value.redirect_uris[0]);
    if (value.grant_types !== undefined && !Array.isArray(value.grant_types)) throw oauthError('invalid_client_metadata', 'grant_types must be an array.');
    const grants = Array.isArray(value.grant_types) ? value.grant_types : ['authorization_code', 'refresh_token'];
    if (grants.length !== 2 || !grants.includes('authorization_code') || !grants.includes('refresh_token')) {
      throw oauthError('invalid_client_metadata', 'authorization_code and refresh_token grants are required.');
    }
    if (value.response_types !== undefined && !Array.isArray(value.response_types)) throw oauthError('invalid_client_metadata', 'response_types must be an array.');
    const responses = Array.isArray(value.response_types) ? value.response_types : ['code'];
    if (responses.length !== 1 || responses[0] !== 'code') {
      throw oauthError('invalid_client_metadata', 'Only response_type=code is supported.');
    }
    if (value.scope !== undefined) normalizeScope(requireString(value.scope, 'scope'));
    if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none') {
      throw oauthError('invalid_client_metadata', 'ChatGPT DCR uses a public PKCE client (token_endpoint_auth_method=none).');
    }
    const client = this.store.createOAuthClient({ workerId, clientName, redirectUri });
    return {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: [client.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools offline_access',
      client_id_issued_at: Math.floor(client.createdAtMs / 1_000),
    };
  }

  beginAuthorization(query: Record<string, unknown>): { request: OAuthAuthorizationRequestRecord; csrfToken: string } {
    if (Object.values(query).some((value) => typeof value !== 'string')) throw oauthError('invalid_request', 'OAuth parameters must occur exactly once.');
    if (single(query.response_type) !== 'code') throw oauthError('unsupported_response_type', 'Only authorization code is supported.');
    const clientId = single(query.client_id);
    if (!clientId || !CLIENT_ID.test(clientId)) throw oauthError('invalid_client', 'Unknown OAuth client.');
    const client = this.store.getOAuthClient(clientId);
    if (!client || client.revokedAtMs !== null) throw oauthError('invalid_client', 'Unknown OAuth client.');
    const redirectUri = single(query.redirect_uri);
    if (!redirectUri || redirectUri !== client.redirectUri) throw oauthError('invalid_request', 'redirect_uri does not match the registered callback.');
    const resource = single(query.resource);
    const expectedResource = this.workerResource(client.workerId);
    if (!resource || resource !== expectedResource) throw oauthError('invalid_target', 'The worker resource is required and must match the registered client.');
    const challenge = single(query.code_challenge);
    if (!challenge || !PKCE_CHALLENGE.test(challenge) || single(query.code_challenge_method) !== 'S256') {
      throw oauthError('invalid_request', 'PKCE S256 is required.');
    }
    const scope = normalizeScope(single(query.scope) ?? 'mcp:tools offline_access');
    const state = single(query.state) ?? '';
    if (Buffer.byteLength(state, 'utf8') > 4096 || /[\0\r\n]/u.test(state)) throw oauthError('invalid_request', 'state is invalid.');
    const csrfToken = randomBytes(32).toString('base64url');
    const request = this.store.createAuthorizationRequest({
      clientId,
      workerId: client.workerId,
      redirectUri,
      resource,
      scope,
      state,
      codeChallenge: challenge,
      csrfHash: secretHash(csrfToken),
      expiresAtMs: Date.now() + 5 * 60_000,
    });
    return { request, csrfToken };
  }

  approveAuthorization(requestId: string, csrfToken: string): string {
    const { code, request } = this.store.approveAuthorization({ requestId, csrfHash: secretHash(csrfToken) });
    const callback = new URL(request.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('iss', this.issuer);
    if (request.state) callback.searchParams.set('state', request.state);
    return callback.toString();
  }

  denyAuthorization(requestId: string, csrfToken: string): string {
    const request = this.store.denyAuthorization({ requestId, csrfHash: secretHash(csrfToken) });
    const callback = new URL(request.redirectUri);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('iss', this.issuer);
    if (request.state) callback.searchParams.set('state', request.state);
    return callback.toString();
  }

  exchangeToken(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw oauthError('invalid_request', 'Token request must be form encoded.');
    if (Object.values(value).some((entry) => typeof entry !== 'string')) throw oauthError('invalid_request', 'OAuth parameters must occur exactly once.');
    const grantType = String(value.grant_type ?? '');
    if (grantType === 'authorization_code') {
      const clientId = String(value.client_id ?? '');
      const client = this.store.getOAuthClient(clientId);
      if (!client || client.revokedAtMs !== null) throw oauthError('invalid_client', 'Unknown OAuth client.');
      validateTokenResource(value.resource, this.workerResource(client.workerId));
      const code = boundedString(value.code, 512);
      const redirectUri = boundedString(value.redirect_uri, 2048);
      const verifier = boundedString(value.code_verifier, 128);
      if (!code || redirectUri !== client.redirectUri || !verifier || !PKCE_VERIFIER.test(verifier)) throw oauthError('invalid_grant', 'Authorization code request is invalid.');
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
      const grant = this.store.consumeAuthorizationCode({ code, clientId, redirectUri, codeChallenge: challenge });
      if (!grant || grant.clientId !== clientId) throw oauthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
      return tokenResponse(this.store.issueTokens(grant), grant.scopes);
    }
    if (grantType === 'refresh_token') {
      const clientId = boundedString(value.client_id, 256);
      const refreshToken = boundedString(value.refresh_token, 4096);
      if (!clientId || !refreshToken) throw oauthError('invalid_grant', 'client_id and refresh_token are required.');
      const current = this.store.consumeRefreshToken(refreshToken);
      if (!current || current.grant.clientId !== clientId) throw oauthError('invalid_grant', 'Refresh token is invalid, expired, revoked, or already used.');
      validateTokenResource(value.resource, current.grant.resource);
      if (!current.grant.scopes.includes('offline_access')) throw oauthError('invalid_grant', 'This grant does not authorize refresh tokens.');
      // Scope narrowing would require issuing a separate, narrower persisted grant.
      // Reject scope changes rather than silently returning broader authority.
      if (value.scope !== undefined) {
        const scopes = normalizeScope(requireString(value.scope, 'scope')).split(' ');
        if (scopes.length !== current.grant.scopes.length || scopes.some((scope) => !current.grant.scopes.includes(scope))) {
          throw oauthError('invalid_scope', 'Refresh token scope must match the original grant.');
        }
      }
      return tokenResponse(this.store.issueTokens(current.grant, current.tokenHash), current.grant.scopes);
    }
    throw oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  revokeToken(value: unknown): void {
    if (!isRecord(value)) return;
    const token = boundedString(value.token, 4096);
    if (token) this.store.revokeToken(token);
  }

  authenticate(authorization: unknown, workerId: string): AuthenticatedMcpGrant | null {
    if (typeof authorization !== 'string') return null;
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,4096})$/u);
    if (!match) return null;
    return this.store.authenticateAccessToken(match[1], normalizeWorkerId(workerId), this.workerResource(workerId), 'mcp:tools');
  }
}

export class OAuthRequestError extends Error {
  constructor(readonly errorCode: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'OAuthRequestError';
  }
}

function oauthError(code: string, message: string, status = 400): OAuthRequestError {
  return new OAuthRequestError(code, message, status);
}

function tokenResponse(tokens: { accessToken: string; refreshToken?: string; expiresIn: number }, scopes: string[]): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    scope: scopes.join(' '),
  };
}

export function canonicalChatGptOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('ChatGPT public base URL must be a clean origin.');
  const isLoopbackHttp = isLoopbackUrl(url);
  if (url.protocol !== 'https:' && !isLoopbackHttp) throw new Error('ChatGPT public base URL must use HTTPS (HTTP is allowed only on loopback for tests).');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('ChatGPT public base URL must not contain a path.');
  return url.origin;
}

function validateRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2048) throw oauthError('invalid_redirect_uri', 'Redirect URI is invalid.');
  let url: URL;
  try { url = new URL(value); } catch { throw oauthError('invalid_redirect_uri', 'Redirect URI is invalid.'); }
  const loopback = isLoopbackUrl(url);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash) {
    throw oauthError('invalid_redirect_uri', 'Redirect URI must be exact HTTPS (or test loopback HTTP) without credentials or fragment.');
  }
  return url.toString();
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function validateTokenResource(value: unknown, expected: string): void {
  if (value !== undefined && value !== expected) throw oauthError('invalid_target', 'The token resource must match the authorized worker.');
}

function requireString(value: unknown, parameter: string): string {
  if (typeof value !== 'string') throw oauthError('invalid_request', `${parameter} must be a string.`);
  return value;
}

function normalizeScope(value: string): string {
  const scopes = value.split(/\s+/u).filter(Boolean);
  if (scopes.length < 1 || new Set(scopes).size !== scopes.length || scopes.some((scope) => !ALLOWED_SCOPES.has(scope)) || !scopes.includes('mcp:tools')) {
    throw oauthError('invalid_scope', 'Requested OAuth scope is not available.');
  }
  return scopes.join(' ');
}

function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boundedString(value: unknown, bytes: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= bytes && !/[\0\r\n]/u.test(value) ? value : undefined;
}

function secretHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
