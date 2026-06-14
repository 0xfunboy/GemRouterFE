#!/usr/bin/env node

import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_INPUT = "authorized_ollama_urls.txt";
const DEFAULT_MARKDOWN_OUTPUT = "ollama-model-inventory.md";
const DEFAULT_JSON_OUTPUT = "ollama-model-inventory.json";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MIN_PARAMETERS = 20;
const DEFAULT_EXCLUDE_CLOUD = true;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const inputPath = args.input ?? DEFAULT_INPUT;
const markdownOutputPath = args.output ?? DEFAULT_MARKDOWN_OUTPUT;
const jsonOutputPath = args.json ?? DEFAULT_JSON_OUTPUT;
const timeoutMs = positiveInteger(args.timeout, DEFAULT_TIMEOUT_MS);
const concurrency = positiveInteger(args.concurrency, DEFAULT_CONCURRENCY);
const minParameters = positiveNumber(args["min-parameters"] ?? args.minParameters, DEFAULT_MIN_PARAMETERS);
const excludeCloud = args["include-cloud"] ? false : DEFAULT_EXCLUDE_CLOUD;
const proxyDispatcher = createProxyDispatcher();

const urls = await readServerUrls(inputPath);

if (urls.length === 0) {
  throw new Error(`No server URLs found in ${inputPath}`);
}

const results = await mapConcurrent(urls, concurrency, (url) =>
  inspectOllamaServer(url, timeoutMs, minParameters, excludeCloud),
);

const sorted = results
  .filter((server) => server.ok && server.models.length > 0)
  .toSorted(compareServers);

await writeJson(jsonOutputPath, sorted);
await writeMarkdown(markdownOutputPath, sorted);

const reachable = sorted.filter((server) => server.ok).length;
console.log(
  `Wrote ${markdownOutputPath} and ${jsonOutputPath} for ${sorted.length} useful servers (${reachable} reachable, min ${minParameters}B).`,
);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      parsed[match[1]] = match[2];
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed[key] = value;
      index += 1;
      continue;
    }

    if (!parsed.input) {
      parsed.input = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/inventory-ollama-models.mjs [authorized_ollama_urls.txt]

Options:
  --input <file>        File with one authorized Ollama server URL per line.
  --output <file>       Markdown output path. Default: ${DEFAULT_MARKDOWN_OUTPUT}
  --json <file>         JSON output path. Default: ${DEFAULT_JSON_OUTPUT}
  --timeout <ms>        Request timeout per server. Default: ${DEFAULT_TIMEOUT_MS}
  --concurrency <n>     Parallel server checks. Default: ${DEFAULT_CONCURRENCY}
  --min-parameters <n>  Keep only models at or above this B-size. Default: ${DEFAULT_MIN_PARAMETERS}
  --include-cloud       Keep :cloud / -cloud models. Default: excluded.

The script uses Ollama's /api/tags endpoint, which is the HTTP equivalent of
running "ollama list" against a remote Ollama host.`);
}

async function readServerUrls(filePath) {
  const raw = await readFile(filePath, "utf8");
  const seen = new Set();
  const urls = [];
  let skipped = 0;

  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) {
      continue;
    }

    const candidates = extractUrlCandidates(clean);
    if (candidates.length === 0) {
      skipped += 1;
      continue;
    }

    for (const candidate of candidates) {
      const normalized = normalizeBaseUrl(candidate);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    }
  }

  if (skipped > 0) {
    console.warn(`Skipped ${skipped} non-URL lines from ${filePath}.`);
  }

  return urls;
}

function extractUrlCandidates(line) {
  const explicitUrls = line.match(/https?:\/\/[^\s<>"')]+/gi);
  if (explicitUrls) {
    return explicitUrls.map(trimUrlPunctuation);
  }

  if (line.includes(" ") || line.includes("\t")) {
    return [];
  }

  const token = trimUrlPunctuation(line);
  return isPlausibleHost(token) ? [token] : [];
}

function normalizeBaseUrl(rawUrl) {
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)
      ? rawUrl
      : `http://${rawUrl}`;
    const url = new URL(withProtocol);

    if (!isPlausibleHost(url.hostname)) {
      return null;
    }

    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isPlausibleHost(host) {
  if (!host || host.length > 253) {
    return false;
  }

  return (
    host === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(".") ||
    host.includes(":")
  );
}

function trimUrlPunctuation(value) {
  return value.replace(/[.,;:]+$/g, "");
}

function isCloudModelName(modelName) {
  return /(:cloud|-cloud)(?:$|[^a-z0-9])/i.test(String(modelName));
}

async function inspectOllamaServer(baseUrl, timeoutMs, minParameters, excludeCloud) {
  const startedAt = Date.now();
  const tagsUrl = `${baseUrl}/api/tags`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchImpl = proxyDispatcher ? undiciFetch : fetch;
    const response = await fetchImpl(tagsUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        url: baseUrl,
        ok: false,
        latencyMs,
        models: [],
        bestModel: null,
        bestScore: 0,
        error: `HTTP ${response.status}`,
      };
    }

    const body = await response.json();
    const models = Array.isArray(body.models)
      ? body.models
        .map(normalizeModel)
        .filter((model) => !excludeCloud || !isCloudModelName(model.name))
        .filter((model) => model.parameterScore >= minParameters)
        .toSorted(compareModels)
      : [];
    const bestModel = models[0] ?? null;

    return {
      url: baseUrl,
      ok: true,
      latencyMs,
      models,
      bestModel,
      bestScore: bestModel?.score ?? 0,
      error: null,
    };
  } catch (error) {
    return {
      url: baseUrl,
      ok: false,
      latencyMs: Date.now() - startedAt,
      models: [],
      bestModel: null,
      bestScore: 0,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeModel(model) {
  const name = String(model.name ?? model.model ?? "unknown");
  const sizeBytes = Number.isFinite(model.size) ? model.size : 0;
  const details = model.details && typeof model.details === "object" ? model.details : {};
  const parameterScore = inferParameterScore(name, details.parameter_size);
  const quantizationScore = inferQuantizationScore(details.quantization_level);
  const sizeScore = sizeBytes > 0 ? sizeBytes / 1_000_000_000 : 0;
  const score = Math.max(sizeScore, parameterScore) + quantizationScore;

  return {
    name,
    modifiedAt: model.modified_at ?? null,
    sizeBytes,
    size: formatBytes(sizeBytes),
    family: details.family ?? null,
    parameterSize: details.parameter_size ?? inferParameterLabel(name),
    parameterScore,
    quantization: details.quantization_level ?? null,
    score: Number(score.toFixed(3)),
  };
}

function inferParameterScore(name, parameterSize) {
  const label = parameterSize ?? inferParameterLabel(name);
  if (!label) {
    return 0;
  }

  const match = String(label).toLowerCase().match(/(\d+(?:\.\d+)?)\s*([bmk])/);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  const unit = match[2];

  if (unit === "b") return value;
  if (unit === "m") return value / 1000;
  if (unit === "k") return value / 1_000_000;
  return 0;
}

function inferParameterLabel(name) {
  const match = String(name).toLowerCase().match(/(?:^|[:-])(\d+(?:\.\d+)?\s*[bmk])(?:$|[-_:])/);
  return match ? match[1].replace(/\s+/g, "") : null;
}

function inferQuantizationScore(quantization) {
  if (!quantization) {
    return 0;
  }

  const match = String(quantization).toLowerCase().match(/q(\d+)/);
  return match ? Number(match[1]) / 100 : 0;
}

function compareServers(left, right) {
  return (
    Number(right.ok) - Number(left.ok) ||
    right.bestScore - left.bestScore ||
    right.models.length - left.models.length ||
    left.latencyMs - right.latencyMs ||
    left.url.localeCompare(right.url)
  );
}

function compareModels(left, right) {
  return (
    right.score - left.score ||
    right.sizeBytes - left.sizeBytes ||
    left.name.localeCompare(right.name)
  );
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeMarkdown(filePath, servers) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  const lines = [
    "# Ollama Model Inventory",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Rank | Server | Best model | Models | Latency | Status |",
    "|---:|---|---|---:|---:|---|",
  ];

  servers.forEach((server, index) => {
    lines.push(
      `| ${index + 1} | ${escapeCell(server.url)} | ${escapeCell(formatBestModel(server.bestModel))} | ${server.models.length} | ${server.latencyMs} ms | ${escapeCell(server.ok ? "ok" : server.error)} |`,
    );
  });

  for (const server of servers) {
    lines.push("", `## ${server.url}`, "");

    if (!server.ok) {
      lines.push(`Status: ${server.error}`, "");
      continue;
    }

    if (server.models.length === 0) {
      lines.push("No models reported.", "");
      continue;
    }

    lines.push("| Model | Parameters | Size | Family | Quantization |", "|---|---:|---:|---|---|");
    for (const model of server.models) {
      lines.push(
        `| ${escapeCell(model.name)} | ${escapeCell(model.parameterSize ?? "")} | ${escapeCell(model.size)} | ${escapeCell(model.family ?? "")} | ${escapeCell(model.quantization ?? "")} |`,
      );
    }
  }

  await writeFile(filePath, `${lines.join("\n")}\n`);
}

function formatBestModel(model) {
  if (!model) {
    return "";
  }
  return `${model.name}${model.parameterSize ? ` (${model.parameterSize})` : ""}`;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function positiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function positiveNumber(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a positive number, got: ${value}`);
  }
  return parsed;
}

function createProxyDispatcher() {
  if (!isTruthy(process.env.LEAKROUTER_OUTBOUND_PROXY_ENABLED)) return null;
  const urls = readEnvList(process.env.LEAKROUTER_OUTBOUND_PROXY_URLS);
  const single = process.env.LEAKROUTER_OUTBOUND_PROXY_URL?.trim();
  const proxyUrl = urls[0] ?? single;
  if (!proxyUrl) {
    if (isTruthy(process.env.LEAKROUTER_OUTBOUND_PROXY_REQUIRED ?? "true")) {
      throw new Error("Outbound proxy is enabled/required but no proxy URL is configured.");
    }
    return null;
  }
  return new ProxyAgent({ uri: proxyUrl });
}

function readEnvList(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}
