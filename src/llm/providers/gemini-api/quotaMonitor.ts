import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pacificDayStartMs } from './quotaLedger.js';

/**
 * Reads REAL Gemini quota consumption from Google Cloud Monitoring, per project.
 *
 * The Gemini API itself exposes no quota-remaining endpoint, but every account is a
 * Google Cloud project, and quota usage for generativelanguage.googleapis.com is
 * published as Cloud Monitoring time series. A per-project service account with
 * roles/monitoring.viewer is enough to read them. This module never replaces the
 * local ledger: it produces observations that the ledger reconciles against.
 */

const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const USAGE_METRIC = 'serviceruntime.googleapis.com/quota/rate/net_usage';
const LIMIT_METRIC = 'serviceruntime.googleapis.com/quota/limit';
const GEMINI_SERVICE = 'generativelanguage.googleapis.com';

export interface QuotaMonitorCredentialEntry {
  /** Ledger quota group this project maps to (or use accountId + resolver). */
  quotaGroup?: string;
  accountId?: string;
  projectId: string;
  /** Inline service-account JSON, or a path to the downloaded key file. */
  serviceAccount?: { client_email: string; private_key: string; token_uri?: string };
  serviceAccountPath?: string;
  enabled?: boolean;
}

export interface QuotaMonitorConfig {
  enabled: boolean;
  credentialsPath: string;
  storePath: string;
  refreshMs: number;
  timeoutMs: number;
}

export interface QuotaUsageObservation {
  quotaGroup: string;
  projectId: string;
  quotaMetric: string;
  /** Ledger model id when the series carries a model dimension, else null. */
  model: string | null;
  usedToday: number;
  limit: number | null;
  labels: Record<string, string>;
}

interface ProjectSnapshot {
  quotaGroup: string;
  projectId: string;
  ok: boolean;
  error: string | null;
  fetchedAt: string | null;
  observations: QuotaUsageObservation[];
}

interface MonitorSnapshotFile {
  version: 1;
  updatedAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  projects: Record<string, ProjectSnapshot>;
}

interface ResolvedCredential {
  quotaGroup: string;
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

async function fetchAccessToken(credential: ResolvedCredential, timeoutMs: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credential.clientEmail,
    scope: MONITORING_SCOPE,
    aud: credential.tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(credential.privateKey).toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch(credential.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(`token exchange failed (${response.status}): ${payload.error_description ?? payload.error ?? 'no access_token'}`);
  }
  return payload.access_token;
}

function normalizeModelLabel(labels: Record<string, string>): string | null {
  for (const key of ['model', 'model_id', 'base_model', 'model_name']) {
    const value = labels[key];
    if (value) return value.trim().toLowerCase().replace(/^models\//, '');
  }
  return null;
}

function collectLabels(series: Record<string, unknown>): Record<string, string> {
  const labels: Record<string, string> = {};
  const metric = series.metric as { labels?: Record<string, string> } | undefined;
  const resource = series.resource as { labels?: Record<string, string> } | undefined;
  for (const source of [resource?.labels, metric?.labels]) {
    for (const [key, value] of Object.entries(source ?? {})) labels[key] = String(value);
  }
  return labels;
}

function pointValue(series: Record<string, unknown>): number | null {
  const points = Array.isArray(series.points) ? series.points as Array<Record<string, unknown>> : [];
  let total: number | null = null;
  for (const point of points) {
    const value = point.value as { int64Value?: string; doubleValue?: number } | undefined;
    const parsed = value?.int64Value !== undefined ? Number(value.int64Value)
      : typeof value?.doubleValue === 'number' ? value.doubleValue
        : null;
    if (parsed !== null && Number.isFinite(parsed)) total = (total ?? 0) + parsed;
  }
  return total;
}

async function queryTimeSeries(input: {
  projectId: string;
  accessToken: string;
  metricType: string;
  startMs: number;
  endMs: number;
  aligner: 'ALIGN_SUM' | 'ALIGN_MAX';
  timeoutMs: number;
}): Promise<Array<Record<string, unknown>>> {
  const alignmentSeconds = Math.max(60, Math.ceil((input.endMs - input.startMs) / 1000));
  const series: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      filter: `metric.type="${input.metricType}" AND resource.labels.service="${GEMINI_SERVICE}"`,
      'interval.startTime': new Date(input.startMs).toISOString(),
      'interval.endTime': new Date(input.endMs).toISOString(),
      'aggregation.alignmentPeriod': `${alignmentSeconds}s`,
      'aggregation.perSeriesAligner': input.aligner,
      pageSize: '500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(input.projectId)}/timeSeries?${params.toString()}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as {
      timeSeries?: Array<Record<string, unknown>>;
      nextPageToken?: string;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(`monitoring query failed (${response.status}): ${payload.error?.message ?? 'unknown error'}`);
    }
    series.push(...(payload.timeSeries ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);
  return series;
}

export function createGeminiQuotaMonitor(
  config: QuotaMonitorConfig,
  hooks: {
    /** Maps an accountId from the credentials file to its ledger quotaGroup. */
    resolveQuotaGroup: (accountId: string) => string | null;
    /** Receives fresh observations so the ledger can realign its RPD counters. */
    onObservations: (observations: QuotaUsageObservation[]) => Record<string, unknown>;
  },
) {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let snapshot: MonitorSnapshotFile = loadSnapshot();
  let lastReconcile: Record<string, unknown> | null = null;

  function loadSnapshot(): MonitorSnapshotFile {
    if (existsSync(config.storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(config.storePath, 'utf8')) as MonitorSnapshotFile;
        if (parsed && parsed.version === 1) return parsed;
      } catch {
        // Snapshot is derived data: start fresh on corruption.
      }
    }
    return { version: 1, updatedAt: null, lastRunAt: null, lastError: null, projects: {} };
  }

  function persistSnapshot(): void {
    mkdirSync(path.dirname(config.storePath), { recursive: true });
    snapshot.updatedAt = new Date().toISOString();
    writeFileSync(config.storePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  function loadCredentials(): { entries: ResolvedCredential[]; errors: string[] } {
    const errors: string[] = [];
    if (!existsSync(config.credentialsPath)) return { entries: [], errors };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(config.credentialsPath, 'utf8'));
    } catch (error) {
      errors.push(`credentials file unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return { entries: [], errors };
    }
    if (!Array.isArray(parsed)) {
      errors.push('credentials file must be a JSON array');
      return { entries: [], errors };
    }
    const entries: ResolvedCredential[] = [];
    for (const raw of parsed as QuotaMonitorCredentialEntry[]) {
      if (!raw || typeof raw !== 'object' || raw.enabled === false) continue;
      const projectId = String(raw.projectId ?? '').trim();
      if (!projectId) {
        errors.push('entry without projectId skipped');
        continue;
      }
      const quotaGroup = raw.quotaGroup?.trim()
        || (raw.accountId ? hooks.resolveQuotaGroup(String(raw.accountId).trim()) : null);
      if (!quotaGroup) {
        errors.push(`${projectId}: no quotaGroup/accountId mapping`);
        continue;
      }
      let serviceAccount = raw.serviceAccount;
      if (!serviceAccount && raw.serviceAccountPath) {
        const keyPath = path.isAbsolute(raw.serviceAccountPath)
          ? raw.serviceAccountPath
          : path.resolve(path.dirname(config.credentialsPath), raw.serviceAccountPath);
        try {
          serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8')) as ResolvedCredential & { client_email: string; private_key: string; token_uri?: string };
        } catch (error) {
          errors.push(`${projectId}: service account key unreadable (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
      }
      if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
        errors.push(`${projectId}: missing client_email/private_key`);
        continue;
      }
      entries.push({
        quotaGroup,
        projectId,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
        tokenUri: serviceAccount.token_uri ?? DEFAULT_TOKEN_URI,
      });
    }
    return { entries, errors };
  }

  async function refreshProject(credential: ResolvedCredential): Promise<ProjectSnapshot> {
    const endMs = Date.now();
    const startMs = pacificDayStartMs(endMs);
    try {
      const accessToken = await fetchAccessToken(credential, config.timeoutMs);
      const [usageSeries, limitSeries] = await Promise.all([
        queryTimeSeries({
          projectId: credential.projectId,
          accessToken,
          metricType: USAGE_METRIC,
          startMs,
          endMs,
          aligner: 'ALIGN_SUM',
          timeoutMs: config.timeoutMs,
        }),
        queryTimeSeries({
          projectId: credential.projectId,
          accessToken,
          metricType: LIMIT_METRIC,
          // Limits are gauges that rarely change: a short lookback finds the latest value.
          startMs: endMs - 6 * 3_600_000,
          endMs,
          aligner: 'ALIGN_MAX',
          timeoutMs: config.timeoutMs,
        }),
      ]);

      const limitByKey = new Map<string, number>();
      for (const series of limitSeries) {
        const labels = collectLabels(series);
        const value = pointValue(series);
        if (value === null) continue;
        const key = `${labels.quota_metric ?? ''}|${normalizeModelLabel(labels) ?? ''}`;
        limitByKey.set(key, Math.max(limitByKey.get(key) ?? 0, value));
      }

      const observations: QuotaUsageObservation[] = [];
      for (const series of usageSeries) {
        const labels = collectLabels(series);
        const usedToday = pointValue(series);
        if (usedToday === null) continue;
        const model = normalizeModelLabel(labels);
        const quotaMetric = labels.quota_metric ?? '';
        observations.push({
          quotaGroup: credential.quotaGroup,
          projectId: credential.projectId,
          quotaMetric,
          model,
          usedToday,
          limit: limitByKey.get(`${quotaMetric}|${model ?? ''}`) ?? null,
          labels,
        });
      }
      return {
        quotaGroup: credential.quotaGroup,
        projectId: credential.projectId,
        ok: true,
        error: null,
        fetchedAt: new Date().toISOString(),
        observations,
      };
    } catch (error) {
      return {
        quotaGroup: credential.quotaGroup,
        projectId: credential.projectId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: new Date().toISOString(),
        observations: [],
      };
    }
  }

  async function refresh(): Promise<Record<string, unknown>> {
    if (running) return { ok: false, reason: 'already_running' };
    running = true;
    try {
      const { entries, errors } = loadCredentials();
      snapshot.lastRunAt = new Date().toISOString();
      if (entries.length === 0) {
        snapshot.lastError = errors[0] ?? 'no_credentials_configured';
        persistSnapshot();
        return { ok: false, reason: 'no_credentials', errors };
      }
      const results = await Promise.all(entries.map((entry) => refreshProject(entry)));
      const observations: QuotaUsageObservation[] = [];
      for (const result of results) {
        snapshot.projects[result.quotaGroup] = result;
        observations.push(...result.observations);
      }
      snapshot.lastError = results.every((result) => result.ok) ? (errors[0] ?? null) : results.find((result) => !result.ok)?.error ?? null;
      persistSnapshot();
      lastReconcile = observations.length > 0 ? hooks.onObservations(observations) : { reconciled: 0, skipped: 0 };
      return {
        ok: true,
        projects: results.map((result) => ({ quotaGroup: result.quotaGroup, projectId: result.projectId, ok: result.ok, error: result.error, observations: result.observations.length })),
        reconcile: lastReconcile,
        credentialErrors: errors,
      };
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (!config.enabled || config.refreshMs <= 0 || timer) return;
    timer = setInterval(() => { void refresh(); }, config.refreshMs);
    timer.unref?.();
    // First alignment shortly after boot; recurring runs every refreshMs.
    const boot = setTimeout(() => { void refresh(); }, 90_000);
    boot.unref?.();
  }

  function getSnapshot(): Record<string, unknown> {
    const { entries, errors } = loadCredentials();
    return {
      enabled: config.enabled,
      refreshMs: config.refreshMs,
      credentialsPath: config.credentialsPath,
      configuredProjects: entries.map((entry) => ({ quotaGroup: entry.quotaGroup, projectId: entry.projectId })),
      credentialErrors: errors,
      lastRunAt: snapshot.lastRunAt,
      lastError: snapshot.lastError,
      lastReconcile,
      projects: snapshot.projects,
    };
  }

  return { refresh, start, getSnapshot };
}

export type GeminiQuotaMonitor = ReturnType<typeof createGeminiQuotaMonitor>;
