import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadPngDataUri(fileName: string): string {
  try {
    const assetPath = path.resolve(UI_DIR, '../docs/assets', fileName);
    const buffer = readFileSync(assetPath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

const UI_ICON_DATA_URI = loadPngDataUri('GemRouterFE_Icon_logo256.png');
const UI_WORDMARK_DATA_URI = loadPngDataUri('GemRouterFE_Trasp_horiz_Logo_textonly.png');

function svgIcon(name: 'activity' | 'admin' | 'api' | 'bolt' | 'browser' | 'chart' | 'health' | 'menu' | 'moon' | 'plug' | 'route' | 'sun'): string {
  const paths: Record<typeof name, string> = {
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    admin: '<path d="M12 3l7 4v5c0 4.4-2.8 7.2-7 9-4.2-1.8-7-4.6-7-9V7l7-4z"/><path d="M9.5 12.5l1.7 1.7 3.8-4.4"/>',
    api: '<path d="M8 6H6a3 3 0 0 0 0 6h2"/><path d="M16 12h2a3 3 0 0 0 0-6h-2"/><path d="M8 18h8"/><path d="M12 6v12"/><path d="M9 9h6"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 10-13h-7l0-7z"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><path d="M7 7h.01M10 7h.01"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-9"/>',
    health: '<path d="M20.8 8.6a5.5 5.5 0 0 0-9.1-3.9L12 5l.3-.3a5.5 5.5 0 1 1 7.8 7.8L12 20.6 3.9 12.5a5.5 5.5 0 0 1 7.8-7.8"/><path d="M7 12h3l1.5-3 2 6 1.5-3h2"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    moon: '<path d="M21 14.8A8.5 8.5 0 0 1 9.2 3a7 7 0 1 0 11.8 11.8z"/>',
    plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-10 0V7z"/><path d="M12 16v5"/>',
    route: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h3a4 4 0 0 1 4 4v5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAppShell(input: {
  projectName: string;
  modelIds: string[];
  publicBaseUrl?: string;
  socialPreviewUrl?: string;
}): string {
  const bootstrap = JSON.stringify(input).replace(/</g, '\\u003c');
  const pageTitle = `${input.projectName} — Gemini Direct + Playwright Compatibility Router`;
  const pageDescription = 'GemRouterFE routes across Gemini API keys, Gemini direct auth, and Playwright Gemini Web while exposing OpenAI, DeepSeek, and Ollama compatible APIs.';
  const canonicalTag = input.publicBaseUrl?.trim()
    ? `<link rel="canonical" href="${escapeHtml(input.publicBaseUrl.trim())}" />`
    : '';
  const socialMeta = input.socialPreviewUrl?.trim()
    ? `
    <meta name="description" content="${escapeHtml(pageDescription)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${escapeHtml(input.projectName)}" />
    <meta property="og:title" content="${escapeHtml(pageTitle)}" />
    <meta property="og:description" content="${escapeHtml(pageDescription)}" />
    <meta property="og:url" content="${escapeHtml(input.publicBaseUrl?.trim() ?? '')}" />
    <meta property="og:image" content="${escapeHtml(input.socialPreviewUrl.trim())}" />
    <meta property="og:image:secure_url" content="${escapeHtml(input.socialPreviewUrl.trim())}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1731" />
    <meta property="og:image:height" content="909" />
    <meta property="og:image:alt" content="${escapeHtml(pageTitle)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(pageDescription)}" />
    <meta name="twitter:image" content="${escapeHtml(input.socialPreviewUrl.trim())}" />
    <meta name="twitter:image:src" content="${escapeHtml(input.socialPreviewUrl.trim())}" />
    <meta name="telegram:description" content="${escapeHtml(pageDescription)}" />
    <meta name="discord:description" content="${escapeHtml(pageDescription)}" />`
    : `<meta name="description" content="${escapeHtml(pageDescription)}" />`;
  const faviconTag = UI_ICON_DATA_URI
    ? `<link rel="icon" type="image/png" href="${UI_ICON_DATA_URI}" />`
    : '';
  const brandMark = UI_ICON_DATA_URI
    ? `<img src="${UI_ICON_DATA_URI}" alt="" />`
    : escapeHtml(input.projectName.slice(0, 1).toUpperCase() || 'G');
  const brandTitle = UI_WORDMARK_DATA_URI
    ? `<img class="brand-logo" src="${UI_WORDMARK_DATA_URI}" alt="${escapeHtml(input.projectName)}" />`
    : `<strong>${escapeHtml(input.projectName)}</strong>`;
  const hiddenSocialPreview = input.socialPreviewUrl?.trim()
    ? `
    <img
      src="${escapeHtml(input.socialPreviewUrl.trim())}"
      alt="${escapeHtml(pageTitle)}"
      width="1731"
      height="909"
      aria-hidden="true"
      style="position:absolute; left:-9999px; top:-9999px; width:1px; height:1px; opacity:0;"
    />`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pageTitle)}</title>
    ${canonicalTag}
    ${socialMeta}
    ${faviconTag}
    <style>
      :root {
        color-scheme: dark;
        --bg: #070713;
        --bg-soft: #101120;
        --surface: rgba(15, 17, 33, 0.9);
        --surface-strong: rgba(22, 24, 45, 0.97);
        --surface-muted: rgba(20, 23, 43, 0.82);
        --line: rgba(86, 242, 255, 0.12);
        --line-strong: rgba(255, 62, 201, 0.24);
        --text: #f8f7ff;
        --muted: #a9abc4;
        --accent: #18f0d0;
        --accent-soft: #ff3ec9;
        --good: #51ff9b;
        --warn: #ffd166;
        --bad: #ff5f8f;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.48), 0 0 60px rgba(24, 240, 208, 0.06);
        --radius: 8px;
        --radius-sm: 5px;
      }
      [data-theme="light"] {
        color-scheme: light;
        --bg: #eef2f7;
        --bg-soft: #ffffff;
        --surface: rgba(255, 255, 255, 0.92);
        --surface-strong: rgba(255, 255, 255, 0.98);
        --surface-muted: rgba(244, 247, 252, 0.92);
        --line: rgba(13, 18, 30, 0.08);
        --line-strong: rgba(13, 18, 30, 0.14);
        --text: #111827;
        --muted: #5f6b7d;
        --accent: #087f7a;
        --accent-soft: #c4148d;
        --good: #0d8f57;
        --warn: #b87400;
        --bad: #d23764;
        --shadow: 0 22px 60px rgba(70, 90, 120, 0.12);
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        font-family: "Eurostile", "Bank Gothic", "Rajdhani", "Avenir Next", "Segoe UI", sans-serif;
        background:
          linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
          radial-gradient(circle at 14% 8%, rgba(255, 62, 201, 0.2), transparent 26%),
          radial-gradient(circle at 86% 16%, rgba(24, 240, 208, 0.2), transparent 30%),
          radial-gradient(circle at 50% 96%, rgba(255, 209, 102, 0.1), transparent 34%),
          linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 54%, var(--bg) 100%);
        background-size: 42px 42px, 42px 42px, auto, auto, auto, auto;
        color: var(--text);
      }
      a { color: inherit; text-decoration: none; }
      button, input, textarea, select { font: inherit; }
      h1, h2, h3, h4, p { margin: 0; }
      .hidden { display: none !important; }
      .app-shell {
        width: min(1480px, calc(100vw - 28px));
        margin: 14px auto 28px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
        position: relative;
        overflow: visible;
      }
      .panel::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(120deg, rgba(255, 62, 201, 0.06), transparent 32%, rgba(24, 240, 208, 0.05));
        opacity: 0.75;
      }
      .panel > * { position: relative; z-index: 1; }
      .nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        margin-bottom: 16px;
        z-index: 40;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .brand-mark {
        width: 44px;
        height: 44px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: linear-gradient(135deg, rgba(16, 163, 127, 0.12), rgba(62, 169, 255, 0.12));
        border: 1px solid rgba(255, 255, 255, 0.08);
        font-weight: 700;
        flex: 0 0 auto;
      }
      .brand-mark img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .brand-copy {
        display: grid;
        gap: 4px;
      }
      .brand-copy strong {
        font-size: 16px;
        letter-spacing: -0.03em;
      }
      .brand-logo {
        display: block;
        width: auto;
        height: 34px;
        max-width: min(360px, 42vw);
      }
      .brand-copy span {
        color: var(--muted);
        font-size: 12px;
      }
      .nav-actions, .button-row, .meta-row, .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .icon {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        flex: 0 0 auto;
      }
      .chip, .ghost-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 4px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        color: var(--muted);
        font-size: 12px;
      }
      .chip.good { color: var(--good); }
      .chip.warn { color: var(--warn); }
      .chip.bad { color: var(--bad); }
      .hero {
        display: grid;
        grid-template-columns: minmax(280px, 0.62fr) minmax(500px, 1.38fr);
        gap: 18px;
        padding: 18px;
        margin-bottom: 16px;
        overflow: visible;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
        padding: 7px 11px;
        border-radius: 4px;
        border: 1px solid rgba(16, 163, 127, 0.24);
        background: rgba(16, 163, 127, 0.1);
        color: var(--accent);
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .hero h1 {
        font-size: clamp(22px, 3.2vw, 34px);
        line-height: 1.02;
        letter-spacing: -0.045em;
        max-width: 12ch;
        text-shadow: 0 0 24px rgba(24, 240, 208, 0.12);
      }
      .hero-copy {
        display: grid;
        align-content: start;
      }
      .hero-copy p {
        margin-top: 16px;
        max-width: 64ch;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.7;
      }
      .hero-card {
        padding: 18px;
        border-radius: var(--radius);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
        border: 1px solid var(--line);
      }
      .source-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .source-card {
        min-height: 154px;
        padding: 0;
        border-radius: 5px;
        background:
          linear-gradient(180deg, rgba(255, 223, 145, 0.07), rgba(255, 255, 255, 0.012)),
          linear-gradient(135deg, rgba(255, 62, 201, 0.1), transparent 44%, rgba(24, 240, 208, 0.1));
        border: 1px solid var(--line);
        overflow: hidden;
      }
      .source-card::before {
        content: "Browser";
        display: block;
        height: 22px;
        padding: 4px 8px;
        color: #0b0b13;
        font: 700 10px/1 "IBM Plex Mono", monospace;
        background: linear-gradient(90deg, #f1d37a, #d68ac6);
        border-bottom: 1px solid rgba(0, 0, 0, 0.8);
      }
      .source-card strong {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 14px 14px 0;
        font-size: 16px;
        letter-spacing: -0.02em;
      }
      .source-card p {
        margin: 10px 14px 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .activity-strip {
        margin-top: 0;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 5px;
        background:
          linear-gradient(90deg, rgba(255, 62, 201, 0.1), rgba(24, 240, 208, 0.08)),
          rgba(0, 0, 0, 0.12);
      }
      .activity-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        color: var(--muted);
        font: 700 10px/1.2 "IBM Plex Mono", monospace;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .heartbeat {
        position: relative;
        height: 86px;
        margin-top: 10px;
        overflow: hidden;
        border: 1px solid rgba(24, 240, 208, 0.18);
        border-radius: 3px;
        background:
          linear-gradient(rgba(24, 240, 208, 0.1) 1px, transparent 1px),
          linear-gradient(90deg, rgba(24, 240, 208, 0.1) 1px, transparent 1px),
          rgba(2, 5, 12, 0.44);
        background-size: 14px 14px;
      }
      .heartbeat-line {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        background: none;
        filter: drop-shadow(0 0 7px rgba(24, 240, 208, 0.85));
      }
      .heartbeat-line svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      .heartbeat-line path {
        fill: none;
        stroke: var(--accent);
        stroke-width: 2.2;
        stroke-linecap: square;
        stroke-linejoin: miter;
      }
      .ecg-persistence {
        opacity: 0.18;
        stroke-dasharray: 32 10;
        filter: blur(0.25px);
        mask-image: linear-gradient(90deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.48) 42%, rgba(0,0,0,0.18) 82%, transparent 100%);
      }
      .ecg-trace {
        stroke-dasharray: 960;
        stroke-dashoffset: -960;
        animation: ecg-draw var(--heartbeat-speed, 7.2s) linear infinite;
      }
      .ecg-sweep {
        position: absolute;
        inset: 0 0 0 auto;
        width: 34px;
        background: linear-gradient(90deg, transparent, rgba(24, 240, 208, 0.13), transparent);
        transform: translateX(34px);
        animation: ecg-sweep var(--heartbeat-speed, 7.2s) linear infinite;
      }
      @keyframes ecg-draw {
        0% { stroke-dashoffset: -960; opacity: 0.96; }
        78% { stroke-dashoffset: 0; opacity: 0.96; }
        100% { stroke-dashoffset: 0; opacity: 0.18; }
      }
      @keyframes ecg-sweep {
        0% { transform: translateX(34px); opacity: 0.3; }
        78% { transform: translateX(-100%); opacity: 0.72; }
        100% { transform: translateX(-100%); opacity: 0; }
      }
      .nav-menu {
        position: relative;
      }
      .menu-popover {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        width: min(440px, calc(100vw - 32px));
        padding: 16px;
        border-radius: 6px;
        background: var(--surface-strong);
        border: 1px solid var(--line-strong);
        box-shadow: var(--shadow);
        z-index: 999;
      }
      .menu-links {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 14px;
      }
      .hero-card h2 {
        font-size: 18px;
        letter-spacing: -0.03em;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hero-card p {
        margin-top: 8px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 12px;
      }
      input, textarea, select {
        width: 100%;
        padding: 12px 14px;
        color: var(--text);
        background: var(--surface-muted);
        border: 1px solid var(--line);
        border-radius: 4px;
      }
      textarea {
        min-height: 126px;
        resize: vertical;
      }
      button {
        border: 1px solid var(--line-strong);
        border-radius: 4px;
        padding: 11px 14px;
        color: var(--text);
        background: linear-gradient(135deg, rgba(16, 163, 127, 0.22), rgba(62, 169, 255, 0.22));
        cursor: pointer;
      }
      button.secondary { background: rgba(255, 255, 255, 0.04); }
      button.warn { background: rgba(245, 158, 11, 0.12); }
      button.bad { background: rgba(251, 113, 133, 0.14); }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
      .status {
        min-height: 18px;
        color: var(--muted);
        font-size: 12px;
      }
      .main-grid {
        display: grid;
        gap: 16px;
      }
      .section {
        padding: 18px;
      }
      .section-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 16px;
      }
      .section-title {
        font-size: 19px;
        letter-spacing: -0.03em;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .section-copy {
        margin-top: 6px;
        color: var(--muted);
        font-size: 13px;
      }
      .stats-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .card {
        padding: 16px;
        border-radius: var(--radius-sm);
        background: var(--surface-muted);
        border: 1px solid var(--line);
      }
      .label {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .metric {
        margin-top: 10px;
        font-size: 30px;
        font-weight: 700;
        letter-spacing: -0.05em;
      }
      .metric-sub {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .chart-grid, .shell-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: 1.15fr 0.85fr;
      }
      .chart-card {
        display: grid;
        gap: 14px;
      }
      .chart-frame {
        position: relative;
        min-height: 220px;
        padding: 14px;
        border-radius: 5px;
        background: var(--surface-muted);
        border: 1px solid var(--line);
      }
      .bar-chart {
        height: 188px;
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(8px, 1fr);
        align-items: end;
        gap: 8px;
      }
      .bar-column {
        display: grid;
        gap: 8px;
        align-items: end;
      }
      .bar-stack {
        position: relative;
        height: 160px;
        display: flex;
        align-items: flex-end;
        justify-content: center;
      }
      .bar {
        width: 100%;
        min-height: 4px;
        border-radius: 2px 2px 0 0;
        background: linear-gradient(180deg, rgba(62, 169, 255, 0.92), rgba(16, 163, 127, 0.8));
      }
      .bar.fail {
        position: absolute;
        bottom: 0;
        width: 100%;
        background: linear-gradient(180deg, rgba(251, 113, 133, 0.88), rgba(245, 158, 11, 0.82));
      }
      .bar-label {
        color: var(--muted);
        font-size: 11px;
        text-align: center;
      }
      .route-list {
        display: grid;
        gap: 10px;
      }
      .route-item {
        display: grid;
        gap: 8px;
      }
      .route-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
      }
      .route-track {
        overflow: hidden;
        height: 10px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.06);
      }
      .route-fill {
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, rgba(16, 163, 127, 0.88), rgba(62, 169, 255, 0.88));
      }
      .role-banner {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
        padding: 14px 16px;
        border-radius: 5px;
        background: linear-gradient(135deg, rgba(16, 163, 127, 0.14), rgba(62, 169, 255, 0.12));
        border: 1px solid rgba(16, 163, 127, 0.18);
      }
      .role-banner strong {
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .response-box, .mono-box {
        min-height: 220px;
        padding: 14px;
        border-radius: 5px;
        background: var(--surface-muted);
        border: 1px solid var(--line);
        white-space: pre-wrap;
        line-height: 1.65;
        overflow: auto;
      }
      .mono-box, .footer-note, .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", "Consolas", monospace;
      }
      .footer-note {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.6;
      }
      .table-wrap {
        overflow: auto;
        border-radius: 5px;
        border: 1px solid var(--line);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        min-width: 720px;
      }
      .table th, .table td {
        padding: 12px 14px;
        vertical-align: top;
        border-bottom: 1px solid var(--line);
        font-size: 12px;
      }
      .table th {
        text-align: left;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-size: 10px;
      }
      .quota-shell {
        grid-template-columns: minmax(300px, 0.78fr) minmax(420px, 1.22fr);
        align-items: start;
      }
      .accounts-table {
        min-width: 0;
      }
      .accounts-table th, .accounts-table td {
        padding: 10px 12px;
      }
      .accounts-table th:nth-child(1), .accounts-table td:nth-child(1) { width: 26%; }
      .accounts-table th:nth-child(2), .accounts-table td:nth-child(2) { width: 34%; }
      .accounts-table th:nth-child(3), .accounts-table td:nth-child(3) { width: 12%; }
      .accounts-table th:nth-child(4), .accounts-table td:nth-child(4) { width: 28%; }
      .quota-table {
        min-width: 0;
      }
      .quota-table th, .quota-table td {
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .quota-table th:nth-child(1), .quota-table td:nth-child(1) { width: 16%; }
      .quota-table th:nth-child(2), .quota-table td:nth-child(2) { width: 22%; }
      .quota-table th:nth-child(3), .quota-table td:nth-child(3),
      .quota-table th:nth-child(4), .quota-table td:nth-child(4),
      .quota-table th:nth-child(5), .quota-table td:nth-child(5) { width: 13%; }
      .quota-table th:nth-child(6), .quota-table td:nth-child(6) { width: 23%; }
      @media (max-width: 980px) {
        .table.responsive-table,
        .table.responsive-table thead,
        .table.responsive-table tbody,
        .table.responsive-table tr,
        .table.responsive-table th,
        .table.responsive-table td {
          display: block;
          width: 100% !important;
          min-width: 0;
        }
        .table.responsive-table thead {
          display: none;
        }
        .table.responsive-table tr {
          padding: 10px;
          border-bottom: 1px solid var(--line);
        }
        .table.responsive-table td {
          display: grid;
          grid-template-columns: 92px minmax(0, 1fr);
          gap: 10px;
          padding: 7px 4px;
          border-bottom: 0;
        }
        .table.responsive-table td::before {
          content: attr(data-label);
          color: var(--muted);
          font: 700 10px/1.3 "IBM Plex Mono", monospace;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
      }
      iframe {
        width: 100%;
        min-height: 520px;
        border: 0;
        border-radius: 5px;
        background: #030508;
      }
      .auth-grid {
        display: grid;
        gap: 12px;
      }
      .muted {
        color: var(--muted);
      }
      @media (max-width: 1120px) {
        .hero, .chart-grid, .shell-grid {
          grid-template-columns: 1fr;
        }
        .source-grid {
          grid-template-columns: 1fr;
        }
        .stats-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .quota-shell {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 760px) {
        .app-shell {
          width: min(100vw, calc(100vw - 14px));
          margin: 8px auto 18px;
        }
        .nav, .hero, .section {
          padding: 14px;
        }
        .brand-logo {
          height: 28px;
          max-width: min(250px, 54vw);
        }
        .stats-grid {
          grid-template-columns: 1fr;
        }
        .hero h1 {
          max-width: none;
          font-size: clamp(28px, 9vw, 44px);
        }
      }
    </style>
  </head>
  <body>
    ${hiddenSocialPreview}
    <main class="app-shell">
      <header class="panel nav">
        <div class="brand">
          <div class="brand-mark">${brandMark}</div>
          <div class="brand-copy">
            ${brandTitle}
            <span>Three-source Gemini router with compatible API surfaces</span>
          </div>
        </div>
        <div class="nav-actions nav-menu">
          <button id="menu-toggle" type="button" class="secondary" aria-label="Open dashboard menu" title="Open dashboard menu">${svgIcon('menu')}</button>
          <div id="top-menu" class="menu-popover hidden">
            <div class="menu-links">
              <button id="theme-toggle" type="button" class="secondary">${svgIcon('moon')} Toggle theme</button>
              <a class="ghost-link" href="/health" target="_blank" rel="noreferrer">${svgIcon('health')} Health JSON</a>
              <button id="menu-refresh-button" type="button" class="secondary">${svgIcon('activity')} Refresh</button>
            </div>
            <div class="hero-card" style="padding:14px">
              <h2>${svgIcon('admin')} Admin Login</h2>
              <p>Use the dashboard credentials from <span class="mono">.env</span>. The session is stored in an HttpOnly cookie.</p>
              <div id="auth-summary" class="status" style="margin-top:12px">Loading session state…</div>
              <form id="login-form" style="margin-top:12px">
                <label>
                  Username
                  <input type="text" name="username" autocomplete="username" placeholder="admin" required />
                </label>
                <label>
                  Password
                  <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required />
                </label>
                <div class="button-row">
                  <button type="submit">${svgIcon('admin')} Sign in</button>
                  <button id="menu-logout-button" type="button" class="warn">${svgIcon('plug')} Log out</button>
                </div>
              </form>
              <div id="auth-status" class="status" style="margin-top:10px"></div>
              <div class="footer-note" style="margin-top:12px">
                noVNC stays separately protected. This dashboard never injects the VNC password into the browser.
              </div>
            </div>
          </div>
        </div>
      </header>

      <section class="panel hero">
        <div class="hero-copy">
          <div class="activity-strip">
            <div class="activity-head">
              <span>Live router pulse</span>
              <span id="activity-label">waiting for traffic</span>
            </div>
            <div class="heartbeat" aria-hidden="true">
              <div class="heartbeat-line">
                <svg viewBox="0 0 960 86" preserveAspectRatio="none">
                  <path class="ecg-persistence" d="M0 45 H80 L92 45 L102 37 L112 51 L124 45 H176 L188 45 L198 25 L210 74 L224 10 L240 45 H312 L326 45 L338 34 L350 55 L364 45 H480 L560 45 L572 45 L582 37 L592 51 L604 45 H656 L668 45 L678 25 L690 74 L704 10 L720 45 H792 L806 45 L818 34 L830 55 L844 45 H960" />
                  <path class="ecg-trace" d="M0 45 H80 L92 45 L102 37 L112 51 L124 45 H176 L188 45 L198 25 L210 74 L224 10 L240 45 H312 L326 45 L338 34 L350 55 L364 45 H480 L560 45 L572 45 L582 37 L592 51 L604 45 H656 L668 45 L678 25 L690 74 L704 10 L720 45 H792 L806 45 L818 34 L830 55 L844 45 H960" />
                </svg>
                <div class="ecg-sweep"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="source-grid">
          <div class="source-card">
            <strong>${svgIcon('api')} Gemini API</strong>
            <p>Multi-key pool with account aliases, local RPM/TPM/RPD ledger, model discovery, and quota-aware routing.</p>
          </div>
          <div class="source-card">
            <strong>${svgIcon('bolt')} Direct Auth</strong>
            <p>Uses cached Google/Gemini direct auth when available, useful for account-level access without browser automation.</p>
          </div>
          <div class="source-card">
            <strong>${svgIcon('browser')} Playwright Web</strong>
            <p>Headed Gemini Web fallback for logged-in sessions and UI-only tasks that the official API does not cover.</p>
          </div>
        </div>
      </section>

      <section class="panel section">
        <div class="section-head">
          <div>
            <h2 class="section-title">${svgIcon('activity')} Guest Overview</h2>
            <p class="section-copy">Guest view hides prompts, app names and API keys. It shows aggregate usage plus safe Gemini API quota aliases.</p>
          </div>
          <div id="public-runtime-pills" class="meta-row"></div>
        </div>
        <div id="public-stats" class="stats-grid"></div>
      </section>

      <section class="panel section">
        <div class="section-head">
          <div>
            <h3 class="section-title">${svgIcon('api')} Gemini API Keys and Quota</h3>
            <p class="section-copy">Configured upstream accounts, local quota ledger, and per-model RPM/TPM/RPD remaining capacity. API keys are never shown.</p>
          </div>
          <div id="provider-pills" class="meta-row"></div>
        </div>
        <div class="shell-grid quota-shell">
          <div>
            <h4 class="section-title" style="font-size:15px;margin-bottom:10px">${svgIcon('plug')} Configured Accounts</h4>
            <div class="table-wrap">
              <table class="table accounts-table responsive-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Quota Group</th>
                    <th>Priority</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody id="gemini-api-keys-table"></tbody>
              </table>
            </div>
          </div>
          <div>
            <h4 class="section-title" style="font-size:15px;margin-bottom:10px">${svgIcon('chart')} Quota Snapshot</h4>
            <div class="table-wrap">
              <table class="table quota-table responsive-table">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Model</th>
                    <th>RPM</th>
                    <th>TPM</th>
                    <th>RPD</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody id="gemini-api-quota-table"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section class="panel section">
        <div class="chart-grid">
          <div class="chart-card">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('chart')} 24h Throughput</h3>
              <p class="section-copy">Hourly request volume. Failed requests are highlighted when present.</p>
            </div>
            </div>
            <div class="chart-frame">
              <div id="hourly-chart" class="bar-chart"></div>
            </div>
          </div>
          <div class="chart-card">
            <div class="section-head">
              <div>
                <h3 class="section-title">${svgIcon('route')} Compatibility Surface Mix</h3>
                <p class="section-copy">Traffic grouped by compatibility surface.</p>
              </div>
            </div>
            <div class="chart-frame">
              <div id="route-chart" class="route-list"></div>
            </div>
          </div>
        </div>
      </section>

      <section id="admin-dashboard" class="hidden">
        <div class="role-banner panel">
          <div>
            <strong id="admin-banner-title">Operator console active</strong>
            <div id="admin-banner-copy" class="section-copy">Admin controls are available in this browser session.</div>
          </div>
          <div class="button-row">
            <button id="refresh-button" type="button" class="secondary">Refresh</button>
            <button id="logout-button" type="button" class="warn">Log out</button>
          </div>
        </div>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h2 class="section-title">Runtime Diagnostics</h2>
              <p class="section-copy">Router counters, backend routing state, browser runtime, token volume and operator feedback.</p>
            </div>
            <div id="runtime-pills" class="meta-row"></div>
          </div>
          <div id="stats-grid" class="stats-grid"></div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Backend Routing</h3>
              <p class="section-copy">Embedded Gemini direct auth is preferred when cached Google auth is available. Playwright remains the authenticated fallback path.</p>
            </div>
            <div id="backend-pills" class="meta-row"></div>
          </div>
          <div id="backend-output" class="mono-box">Loading backend routing snapshot…</div>
          <div id="backend-hint" class="footer-note" style="margin-top:10px"></div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('api')} Provider Diagnostics</h3>
              <p class="section-copy">Admin-only raw backend state for Gemini API, direct auth and fallback investigation.</p>
            </div>
          </div>
          <div id="provider-output" class="mono-box">Loading direct model and quota snapshot…</div>
        </section>


        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Compatibility Surfaces</h3>
              <p class="section-copy">Manage enabled API surfaces and choose the primary compatibility surface.</p>
            </div>
          </div>
          <div class="shell-grid">
            <div>
              <form id="compatibility-form">
                <label>
                  Primary surface
                  <select name="defaultSurface">
                    <option value="openai">openai</option>
                    <option value="deepseek">deepseek</option>
                    <option value="ollama">ollama</option>
                  </select>
                </label>
                <div class="button-row">
                  <label class="chip"><input type="checkbox" name="enabledSurfaces" value="openai" style="margin-right:8px" />openai</label>
                  <label class="chip"><input type="checkbox" name="enabledSurfaces" value="deepseek" style="margin-right:8px" />deepseek</label>
                  <label class="chip"><input type="checkbox" name="enabledSurfaces" value="ollama" style="margin-right:8px" />ollama</label>
                </div>
                <div class="button-row">
                  <button type="submit">Save surfaces</button>
                </div>
                <div id="compatibility-status" class="status"></div>
              </form>
            </div>
            <div>
              <div id="compatibility-output" class="mono-box">Loading compatibility surface snapshot…</div>
              <div class="footer-note" style="margin-top:10px">
                For Eliza with <span class="mono">modelProvider=ollama</span>, use <span class="mono">OLLAMA_SERVER_URL</span>
                without <span class="mono">/api</span>.
              </div>
            </div>
          </div>
        </section>

        <div class="shell-grid">
          <section class="panel section">
            <div class="section-head">
              <div>
                <h3 class="section-title">Prompt Lab</h3>
                <p class="section-copy">Test prompts against the live router with the selected app policy and current backend selection rules.</p>
              </div>
            </div>
            <form id="prompt-form">
              <label>
                App
                <select name="appId" id="prompt-app"></select>
              </label>
              <label>
                Model
                <select name="model" id="prompt-model"></select>
              </label>
              <label>
                System prompt
                <textarea name="systemPrompt" placeholder="Optional system instruction"></textarea>
              </label>
              <label>
                User prompt
                <textarea name="prompt" placeholder="Write a prompt to test" required></textarea>
              </label>
              <label>
                Session hint
                <input type="text" name="sessionHint" placeholder="Optional session hint" />
              </label>
              <div class="button-row">
                <label class="chip">
                  <input type="checkbox" name="stateful" style="margin-right:8px" />
                  Reuse stateful session
                </label>
              </div>
              <div class="button-row">
                <button type="submit">Run prompt</button>
              </div>
              <div id="prompt-status" class="status"></div>
            </form>
            <div id="prompt-response" class="response-box">No prompt run yet.</div>
          </section>

          <section class="panel section">
            <div class="section-head">
              <div>
                <h3 class="section-title">Browser Session</h3>
                <p class="section-copy">Visual access to the headed Gemini browser for recovery and inspection through noVNC.</p>
              </div>
              <a id="open-vnc-link" class="chip good" href="#" target="_blank" rel="noreferrer">Open noVNC</a>
            </div>
            <iframe id="vnc-frame" src="about:blank" title="Gemini noVNC"></iframe>
          </section>
        </div>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Apps and API Keys</h3>
              <p class="section-copy">Create apps, rotate API keys, and manage browser-facing limits from one console.</p>
            </div>
          </div>
          <div class="shell-grid">
            <div>
              <form id="app-form">
                <input type="hidden" name="id" />
                <label>
                  App name
                  <input type="text" name="name" placeholder="frontend-app" required />
                </label>
                <label>
                  Allowed origins
                  <textarea name="allowedOrigins" placeholder="https://app.example.com, http://localhost:*"></textarea>
                </label>
                <label>
                  Allowed models
                  <input type="text" name="allowedModels" placeholder="${escapeHtml(input.modelIds.join(', '))}" />
                </label>
                <label>
                  Session namespace
                  <input type="text" name="sessionNamespace" placeholder="frontend-app" />
                </label>
                <label>
                  Rate limit per minute
                  <input type="number" min="0" step="1" name="rateLimitPerMinute" value="30" />
                </label>
                <label>
                  Max concurrency
                  <input type="number" min="0" step="1" name="maxConcurrency" value="2" />
                </label>
                <div class="button-row">
                  <button type="submit">Save app</button>
                  <button type="button" class="secondary" id="app-reset">Reset</button>
                </div>
                <div id="app-status" class="status"></div>
              </form>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Origins</th>
                    <th>Limits</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="apps-table"></tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Recent Interactions</h3>
              <p class="section-copy">Prompt and output excerpts, token usage, latency, and operator feedback.</p>
            </div>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>App</th>
                  <th>Prompt</th>
                  <th>Output</th>
                  <th>Usage</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody id="interactions-table"></tbody>
            </table>
          </div>
        </section>
      </section>
    </main>

    <script>
      window.__GEMROUTER_BOOTSTRAP__ = ${bootstrap};
    </script>
    <script>
      const bootstrap = window.__GEMROUTER_BOOTSTRAP__;
      const state = {
        apps: [],
        compatibility: null,
        vncUrl: '',
        authenticated: false,
        username: '',
        publicSummary: null,
      };

      const root = document.documentElement;
      const savedTheme = localStorage.getItem('gemrouter-theme') || 'dark';
      root.setAttribute('data-theme', savedTheme);

      const menuToggle = document.getElementById('menu-toggle');
      const topMenu = document.getElementById('top-menu');
      const themeToggle = document.getElementById('theme-toggle');
      const menuRefreshButton = document.getElementById('menu-refresh-button');
      const menuLogoutButton = document.getElementById('menu-logout-button');
      const authSummary = document.getElementById('auth-summary');
      const authStatus = document.getElementById('auth-status');
      const loginForm = document.getElementById('login-form');
      const activityLabel = document.getElementById('activity-label');
      const publicRuntimePills = document.getElementById('public-runtime-pills');
      const publicStats = document.getElementById('public-stats');
      const hourlyChart = document.getElementById('hourly-chart');
      const routeChart = document.getElementById('route-chart');
      const adminDashboard = document.getElementById('admin-dashboard');
      const adminBannerTitle = document.getElementById('admin-banner-title');
      const adminBannerCopy = document.getElementById('admin-banner-copy');
      const refreshButton = document.getElementById('refresh-button');
      const logoutButton = document.getElementById('logout-button');
      const runtimePills = document.getElementById('runtime-pills');
      const backendPills = document.getElementById('backend-pills');
      const backendOutput = document.getElementById('backend-output');
      const backendHint = document.getElementById('backend-hint');
      const providerPills = document.getElementById('provider-pills');
      const providerOutput = document.getElementById('provider-output');
      const geminiApiKeysTable = document.getElementById('gemini-api-keys-table');
      const geminiApiQuotaTable = document.getElementById('gemini-api-quota-table');
      const statsGrid = document.getElementById('stats-grid');
      const compatibilityForm = document.getElementById('compatibility-form');
      const compatibilityStatus = document.getElementById('compatibility-status');
      const compatibilityOutput = document.getElementById('compatibility-output');
      const promptForm = document.getElementById('prompt-form');
      const promptApp = document.getElementById('prompt-app');
      const promptModel = document.getElementById('prompt-model');
      const promptStatus = document.getElementById('prompt-status');
      const promptResponse = document.getElementById('prompt-response');
      const openVncLink = document.getElementById('open-vnc-link');
      const vncFrame = document.getElementById('vnc-frame');
      const appForm = document.getElementById('app-form');
      const appStatus = document.getElementById('app-status');
      const appReset = document.getElementById('app-reset');
      const appsTable = document.getElementById('apps-table');
      const interactionsTable = document.getElementById('interactions-table');

      function fmtNumber(value) {
        return new Intl.NumberFormat().format(value || 0);
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function setTheme(theme) {
        root.setAttribute('data-theme', theme);
        localStorage.setItem('gemrouter-theme', theme);
        themeToggle.innerHTML = (theme === 'dark' ? '${svgIcon('sun')} Switch to light' : '${svgIcon('moon')} Switch to dark');
      }

      menuToggle.addEventListener('click', () => {
        topMenu.classList.toggle('hidden');
      });
      document.addEventListener('click', (event) => {
        if (!topMenu.contains(event.target) && !menuToggle.contains(event.target)) {
          topMenu.classList.add('hidden');
        }
      });
      themeToggle.addEventListener('click', () => {
        setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      });
      setTheme(savedTheme);

      async function request(url, options = {}) {
        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...(options.headers || {}),
          },
          ...options,
        });
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : await response.text();
        if (!response.ok) {
          const message = body && body.error ? body.error.message : (typeof body === 'string' ? body : 'Request failed');
          throw new Error(message);
        }
        return body;
      }

      function setAdminVisible(enabled) {
        adminDashboard.classList.toggle('hidden', !enabled);
      }

      function renderPublicPills(summary) {
        const pills = [];
        const runtime = summary.runtime || {};
        const compatibility = summary.compatibility || {};
        pills.push('<span class="chip">Primary surface ' + escapeHtml(compatibility.defaultSurface || 'openai') + '</span>');
        pills.push('<span class="chip">API surfaces ' + escapeHtml((compatibility.enabledSurfaces || []).join(', ') || 'n/a') + '</span>');
        if (runtime.activeDefaultBackend) {
          pills.push('<span class="chip">Default backend ' + escapeHtml(runtime.activeDefaultBackend) + '</span>');
        }
        if (runtime.lastBackendUsed) {
          pills.push('<span class="chip">Last backend ' + escapeHtml(runtime.lastBackendUsed) + '</span>');
        }
        if (runtime.geminiCliAvailable !== undefined) {
          pills.push('<span class="chip ' + (runtime.geminiCliAvailable ? 'good' : 'warn') + '">' + (runtime.geminiCliAvailable ? 'Direct backend available' : 'Direct backend attention') + '</span>');
        }
        if (runtime.geminiCliReady !== undefined) {
          pills.push('<span class="chip ' + (runtime.geminiCliReady ? 'good' : 'warn') + '">' + (runtime.geminiCliReady ? 'Google auth ready' : 'Google auth attention') + '</span>');
        }
        pills.push('<span class="chip ' + (runtime.profileReady ? 'good' : 'warn') + '">' + (runtime.profileReady ? 'Profile ready' : 'Profile attention') + '</span>');
        pills.push('<span class="chip">Open tabs ' + escapeHtml(String(runtime.openPages || 0)) + '</span>');
        pills.push('<span class="chip">Busy ' + escapeHtml(String(runtime.busyOpenTabs || 0)) + '</span>');
        publicRuntimePills.innerHTML = pills.join('');
      }

      function renderPublicStats(summary) {
        const stats = summary.stats || {};
        if (activityLabel) {
          activityLabel.textContent = fmtNumber(stats.requests) + ' req / 24h · ' + escapeHtml(String(stats.successRatePct || 0)) + '% ok';
        }
        const speed = Math.max(4.4, Math.min(9.4, 9.4 - Math.log10((stats.requests || 0) + 1) * 1.15));
        root.style.setProperty('--heartbeat-speed', speed.toFixed(2) + 's');
        publicStats.innerHTML = [
          ['Requests', fmtNumber(stats.requests), 'Successful and failed requests'],
          ['Success Rate', escapeHtml(String(stats.successRatePct || 0)) + '%', 'Calculated from logged requests'],
          ['Avg Latency', fmtNumber(stats.avgLatencyMs) + ' ms', 'Router-side average'],
          ['Token Volume', fmtNumber(stats.totalTokens), 'Prompt and completion tokens'],
        ].map(function(entry) {
          return '<div class="card"><div class="label">' + escapeHtml(entry[0]) + '</div><div class="metric">' + entry[1] + '</div><div class="metric-sub">' + escapeHtml(entry[2]) + '</div></div>';
        }).join('');
      }

      function renderHourlyChart(summary) {
        const points = (summary.charts && summary.charts.hourly) || [];
        const maxRequests = points.reduce(function(max, item) { return Math.max(max, item.requests || 0); }, 0) || 1;
        hourlyChart.innerHTML = points.map(function(item) {
          const requests = item.requests || 0;
          const failed = item.failed || 0;
          const requestHeight = Math.max(4, Math.round((requests / maxRequests) * 160));
          const failedHeight = requests > 0 ? Math.max(0, Math.round((failed / maxRequests) * 160)) : 0;
          return '<div class="bar-column">' +
            '<div class="bar-stack">' +
              '<div class="bar" style="height:' + requestHeight + 'px"></div>' +
              (failed > 0 ? '<div class="bar fail" style="height:' + failedHeight + 'px"></div>' : '') +
            '</div>' +
            '<div class="bar-label">' + escapeHtml(item.label || '') + '</div>' +
          '</div>';
        }).join('');
      }

      function renderRouteChart(summary) {
        const points = (summary.charts && summary.charts.routes) || [];
        const maxRequests = points.reduce(function(max, item) { return Math.max(max, item.requests || 0); }, 0) || 1;
        routeChart.innerHTML = points.map(function(item) {
          const requests = item.requests || 0;
          const width = Math.max(6, Math.round((requests / maxRequests) * 100));
          return '<div class="route-item">' +
            '<div class="route-meta"><strong>' + escapeHtml(item.label) + '</strong><span class="muted">' + escapeHtml(String(requests)) + '</span></div>' +
            '<div class="route-track"><div class="route-fill" style="width:' + width + '%"></div></div>' +
          '</div>';
        }).join('') || '<div class="muted">No compatibility traffic logged yet.</div>';
      }

      function fillModelOptions(models) {
        promptModel.innerHTML = models
          .map(function(model) { return '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>'; })
          .join('');
      }

      function fillAppOptions(apps) {
        promptApp.innerHTML = apps
          .filter(function(app) { return !app.revokedAt; })
          .map(function(app) { return '<option value="' + escapeHtml(app.id) + '">' + escapeHtml(app.name) + '</option>'; })
          .join('');
      }

      function renderRuntimePills(data) {
        const runtime = data.runtime || {};
        const llm = data.llm || {};
        const compatibility = data.compatibility || {};
        const routing = data.routing || {};
        const backends = data.backends || {};
        const geminiCli = backends.geminiCli || {};
        runtimePills.innerHTML = [
          '<span class="chip good">Admin session</span>',
          '<span class="chip ' + (runtime.profileReady ? 'good' : 'bad') + '">' + (runtime.profileReady ? 'Profile ready' : 'Profile missing') + '</span>',
          '<span class="chip ' + (geminiCli.available ? 'good' : 'warn') + '">' + (geminiCli.available ? 'Direct backend available' : 'Direct backend attention') + '</span>',
          '<span class="chip ' + (geminiCli.authReady ? 'good' : 'warn') + '">' + (geminiCli.authReady ? 'Google auth ready' : 'Google auth missing') + '</span>',
          '<span class="chip">Default backend ' + escapeHtml(routing.activeDefaultBackend || routing.configuredDefaultBackend || 'auto') + '</span>',
          '<span class="chip">Last backend ' + escapeHtml(routing.lastBackendUsed || 'n/a') + '</span>',
          '<span class="chip">Primary surface ' + escapeHtml(compatibility.defaultSurface || 'openai') + '</span>',
          '<span class="chip">Open tabs ' + escapeHtml(String(llm.openPages || 0)) + '</span>',
          '<span class="chip">Busy ' + escapeHtml(String(llm.busyOpenTabs || 0)) + '</span>',
          '<span class="chip">Apps ' + escapeHtml(String(runtime.apps || 0)) + '</span>',
        ].join('');
      }

      function renderBackendDiagnostics(data) {
        const routing = data.routing || {};
        const backends = data.backends || {};
        const geminiCli = backends.geminiCli || {};
        const playwright = backends.playwright || {};
        backendPills.innerHTML = [
          '<span class="chip ' + (geminiCli.available ? 'good' : 'warn') + '">' + (geminiCli.available ? 'Direct backend available' : 'Direct backend attention') + '</span>',
          '<span class="chip ' + (geminiCli.authReady ? 'good' : 'warn') + '">' + (geminiCli.authReady ? 'Google auth ready' : 'Google auth missing') + '</span>',
          '<span class="chip ' + (playwright.profileReady ? 'good' : 'warn') + '">' + (playwright.profileReady ? 'Playwright ready' : 'Playwright attention') + '</span>',
          '<span class="chip">Order ' + escapeHtml((data.backendOrder || []).join(' -> ') || 'n/a') + '</span>',
          '<span class="chip">Last backend ' + escapeHtml(routing.lastBackendUsed || 'n/a') + '</span>',
        ].join('');
        backendOutput.textContent = [
          'backend_order=' + (data.backendOrder || []).join(','),
          'configured_default_backend=' + String(routing.configuredDefaultBackend || ''),
          'active_default_backend=' + String(routing.activeDefaultBackend || ''),
          'last_backend_used=' + String(routing.lastBackendUsed || ''),
          'last_fallback_from=' + String(routing.lastFallbackFrom || ''),
          'last_fallback_reason=' + String(routing.lastFallbackReason || ''),
          'last_resolution_at=' + String(routing.lastResolutionAt || ''),
          '',
          '[gemini_direct]',
          'enabled=' + String(Boolean(geminiCli.enabled)),
          'available=' + String(Boolean(geminiCli.available)),
          'runtime=' + String(geminiCli.runtime || ''),
          'auth_cache_detected=' + String(Boolean(geminiCli.authCacheDetected)),
          'auth_ready=' + String(Boolean(geminiCli.authReady)),
          'auth_verified_at=' + String(geminiCli.authVerifiedAt || ''),
          'active_account=' + String(geminiCli.activeAccount || ''),
          'model=' + String(geminiCli.model || ''),
          'models=' + String((geminiCli.models || []).join(',')),
          'project_id=' + String(geminiCli.projectId || ''),
          'user_tier=' + String(geminiCli.userTier || ''),
          'user_tier_name=' + String(geminiCli.userTierName || ''),
          'timeout_ms=' + String(geminiCli.timeoutMs || ''),
          'quota_refresh_ms=' + String(geminiCli.quotaRefreshMs || ''),
          'quota_authoritative=' + String(Boolean(geminiCli.quotaAuthoritative)),
          'quota_updated_at=' + String(geminiCli.quotaUpdatedAt || ''),
          'quota_last_error=' + String(geminiCli.quotaLastError || ''),
          'last_mapped_error_code=' + String(geminiCli.lastMappedErrorCode || ''),
          'last_failure_at=' + String(geminiCli.lastFailureAt || ''),
          'last_resolved_model=' + String(geminiCli.lastResolvedModel || ''),
          '',
          '[direct_upstream]',
          'method=' + String((geminiCli.lastUpstreamError && geminiCli.lastUpstreamError.method) || ''),
          'status_code=' + String((geminiCli.lastUpstreamError && geminiCli.lastUpstreamError.statusCode) || ''),
          'google_status=' + String((geminiCli.lastUpstreamError && geminiCli.lastUpstreamError.googleStatus) || ''),
          'google_reason=' + String((geminiCli.lastUpstreamError && geminiCli.lastUpstreamError.googleReason) || ''),
          'message=' + String((geminiCli.lastUpstreamError && geminiCli.lastUpstreamError.message) || ''),
          '',
          '[playwright]',
          'profile_ready=' + String(Boolean(playwright.profileReady)),
          'profile_namespace=' + String(playwright.profileNamespace || ''),
          'headless=' + String(Boolean(playwright.headless)),
          'profile_dir=' + String(playwright.profileDir || ''),
        ].join('\\n');
        backendHint.textContent = geminiCli.loginHint
          ? 'Bootstrap Google auth with: ' + geminiCli.loginHint
          : 'Google login helper unavailable.';
      }

      function renderProviderState(data) {
        const provider = data.provider || {};
        const geminiApi = provider.geminiApi || {};
        const quota = provider.quota || {};
        const apiKeys = Array.isArray(quota.apiKeys) ? quota.apiKeys : [];
        const quotaGroups = Array.isArray(quota.quotaGroups) ? quota.quotaGroups : [];
        const models = Array.isArray(provider.models) ? provider.models : [];
        const directModels = models.filter(function(model) { return model && model.kind === 'gemini-api'; });
        const directModelCount = directModels.length || provider.directModelCount || 0;
        providerPills.innerHTML = [
          '<span class="chip ' + (geminiApi.enabled ? 'good' : 'warn') + '">' + (geminiApi.enabled ? 'Gemini API enabled' : 'Gemini API disabled') + '</span>',
          '<span class="chip">Accounts ' + escapeHtml(String(geminiApi.usableKeyCount || 0)) + '/' + escapeHtml(String(geminiApi.configuredKeyCount || 0)) + '</span>',
          '<span class="chip">Configured model ' + escapeHtml(String(provider.configuredModel || 'n/a')) + '</span>',
          '<span class="chip">Last API model ' + escapeHtml(String(geminiApi.lastResolvedModel || 'n/a')) + '</span>',
          '<span class="chip">Direct state ' + escapeHtml(String(provider.lastDirectRequestState || 'unknown')) + '</span>',
          '<span class="chip">Tier ' + escapeHtml(String(geminiApi.defaultTier || provider.userTierName || provider.userTier || 'n/a')) + '</span>',
          '<span class="chip">Direct models ' + escapeHtml(String(directModelCount)) + '</span>',
        ].join('');

        renderGeminiApiKeyTable(apiKeys);
        renderGeminiApiQuotaTable(quotaGroups);

        providerOutput.textContent = [
          '[gemini_api]',
          'enabled=' + String(Boolean(geminiApi.enabled)),
          'configured_accounts=' + String(geminiApi.configuredKeyCount || 0),
          'usable_accounts=' + String(geminiApi.usableKeyCount || 0),
          'default_tier=' + String(geminiApi.defaultTier || ''),
          'last_account=' + String(geminiApi.lastSelectedKeyId || ''),
          'last_quota_group=' + String(geminiApi.lastSelectedQuotaGroup || ''),
          'last_model=' + String(geminiApi.lastResolvedModel || ''),
          'last_error=' + String(geminiApi.lastError || ''),
          'model_discovery_last_refresh=' + String((geminiApi.modelDiscovery && geminiApi.modelDiscovery.lastRefreshAt) || ''),
          'model_discovery_last_error=' + String((geminiApi.modelDiscovery && geminiApi.modelDiscovery.lastError) || ''),
          '',
          '[gemini_cli_diagnostic]',
          'runtime=' + String(provider.runtime || ''),
          'auth_ready=' + String(Boolean(provider.authReady)),
          'auth_cache_detected=' + String(Boolean(provider.authCacheDetected)),
          'active_account=' + String(provider.activeAccount || ''),
          'selected_auth_type=' + String(provider.selectedAuthType || ''),
          'project_id=' + String(provider.projectId || ''),
          'configured_model=' + String(provider.configuredModel || ''),
          'last_resolved_model=' + String(provider.lastResolvedModel || ''),
          'last_direct_request_state=' + String(provider.lastDirectRequestState || ''),
          'user_tier=' + String(provider.userTier || ''),
          'user_tier_name=' + String(provider.userTierName || ''),
          'quota_authoritative=' + String(Boolean(provider.quotaAuthoritative)),
          'quota_updated_at=' + String(provider.quotaUpdatedAt || ''),
          'quota_last_error=' + String(provider.quotaLastError || ''),
          'last_mapped_error_code=' + String(provider.lastMappedErrorCode || ''),
          'last_failure_at=' + String(provider.lastFailureAt || ''),
          '',
          '[credits]',
          ...(Array.isArray(provider.availableCredits) && provider.availableCredits.length > 0
            ? provider.availableCredits.map(function(credit) {
              return String(credit.creditType || 'unknown') + '=' + String(credit.creditAmount || '');
            })
            : ['none']),
          '',
          '[upstream]',
          'method=' + String((provider.lastUpstreamError && provider.lastUpstreamError.method) || ''),
          'status_code=' + String((provider.lastUpstreamError && provider.lastUpstreamError.statusCode) || ''),
          'google_status=' + String((provider.lastUpstreamError && provider.lastUpstreamError.googleStatus) || ''),
          'google_reason=' + String((provider.lastUpstreamError && provider.lastUpstreamError.googleReason) || ''),
          'message=' + String((provider.lastUpstreamError && provider.lastUpstreamError.message) || ''),
          '',
          '[models]',
          ...(models.length > 0
            ? models.map(function(model) {
              const quota = model.quota || {};
              return [
                String(model.id || ''),
                'backend=' + String(model.backend || ''),
                'kind=' + String(model.kind || ''),
                'selected=' + String(Boolean(model.selected)),
                'available=' + String(Boolean(model.available)),
                'remaining_amount=' + String(quota.remainingAmount || ''),
                'remaining_fraction=' + String(
                  typeof quota.remainingFraction === 'number' ? quota.remainingFraction : ''
                ),
                'reset_time=' + String(quota.resetTime || ''),
              ].join(' ');
            })
            : ['none']),
        ].join('\\n');
      }

      function accountAlias(index) {
        return 'account' + String(index + 1);
      }

      function groupAlias(index) {
        return 'quotaGroup' + String(index + 1);
      }

      function formatQuotaMetric(metric) {
        if (!metric) return '0 / n/a';
        const used = fmtNumber(metric.used || 0);
        const limit = metric.limit === null || metric.limit === undefined ? 'unlimited' : fmtNumber(metric.limit);
        const remaining = metric.remaining === null || metric.remaining === undefined ? 'unlimited' : fmtNumber(metric.remaining);
        return used + ' / ' + limit + '<div class="footer-note">remaining ' + remaining + '</div>';
      }

      function formatTimestamp(value) {
        if (!value) return 'never';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value).replace(/\\.\\d{3}Z$/, 'Z');
        return date.toISOString().replace(/\\.\\d{3}Z$/, 'Z');
      }

      function renderGeminiApiKeyTable(apiKeys) {
        geminiApiKeysTable.innerHTML = apiKeys.map(function(key, index) {
          const enabled = key.enabled !== false;
          return '<tr>' +
            '<td data-label="Account"><strong>' + accountAlias(index) + '</strong><div class="footer-note">API key hidden</div></td>' +
            '<td data-label="Quota Group">' + groupAlias(index) + '<div class="footer-note">' + escapeHtml(formatTimestamp(key.lastUsedAt)) + '</div></td>' +
            '<td data-label="Priority">' + escapeHtml(String(key.priority || 0)) + '</td>' +
            '<td data-label="Health"><span class="chip ' + (enabled ? 'good' : 'warn') + '">' + (enabled ? 'enabled' : 'disabled') + '</span></td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="4" class="muted">No Gemini API accounts configured.</td></tr>';
      }

      function renderGeminiApiQuotaTable(quotaGroups) {
        const rows = [];
        quotaGroups.forEach(function(group, groupIndex) {
          const models = Array.isArray(group.models) ? group.models : [];
          models.slice(0, 12).forEach(function(model) {
            const cooldown = model.cooldownUntil ? 'cooldown until ' + model.cooldownUntil : 'ready';
            rows.push('<tr>' +
              '<td data-label="Group">' + groupAlias(groupIndex) + '</td>' +
              '<td data-label="Model"><strong>' + escapeHtml(String(model.model || 'unknown')) + '</strong><div class="footer-note">source: ' + escapeHtml(String(model.source || 'local-ledger')) + '</div></td>' +
              '<td data-label="RPM">' + formatQuotaMetric(model.rpm) + '</td>' +
              '<td data-label="TPM">' + formatQuotaMetric(model.tpm) + '</td>' +
              '<td data-label="RPD">' + formatQuotaMetric(model.rpd) + '</td>' +
              '<td data-label="State"><span class="chip ' + (model.cooldownUntil ? 'warn' : 'good') + '">' + escapeHtml(cooldown) + '</span><div class="footer-note">auth: estimated local ledger</div></td>' +
            '</tr>');
          });
        });
        geminiApiQuotaTable.innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">No quota groups available yet.</td></tr>';
      }

      function renderStats(summary) {
        const totals = summary.totals;
        const feedback = summary.feedback;
        statsGrid.innerHTML = [
          ['Requests', fmtNumber(totals.requests), totals.succeeded + ' ok / ' + totals.failed + ' failed'],
          ['Tokens', fmtNumber(totals.totalTokens), fmtNumber(totals.promptTokens) + ' prompt / ' + fmtNumber(totals.completionTokens) + ' completion'],
          ['Avg latency', fmtNumber(totals.avgLatencyMs) + ' ms', 'Across logged interactions'],
          ['Feedback', feedback.good + ' good / ' + feedback.bad + ' bad', feedback.unrated + ' unrated'],
        ].map(function(entry) {
          return '<div class="card"><div class="label">' + escapeHtml(entry[0]) + '</div><div class="metric">' + escapeHtml(entry[1]) + '</div><div class="metric-sub">' + escapeHtml(entry[2]) + '</div></div>';
        }).join('');
      }

      function renderCompatibility(compatibility) {
        state.compatibility = compatibility || null;
        if (!compatibility) {
          compatibilityOutput.textContent = 'Compatibility surface snapshot unavailable.';
          return;
        }
        const endpoints = compatibility.endpoints || {};
        compatibilityForm.elements.defaultSurface.value = compatibility.defaultSurface || 'openai';
        Array.from(compatibilityForm.querySelectorAll('input[name="enabledSurfaces"]')).forEach(function(input) {
          input.checked = (compatibility.enabledSurfaces || []).includes(input.value);
        });

        const openai = endpoints.openai || { enabled: false, routes: {} };
        const deepseek = endpoints.deepseek || { enabled: false, routes: {} };
        const ollama = endpoints.ollama || { enabled: false, routes: {} };
        const ollamaServerUrl = ollama.routes ? (ollama.routes.baseUrl || '') : '';
        const ollamaAuthExample = ollamaServerUrl ? ollamaServerUrl.replace(/^https?:\\/\\//, function(prefix) { return prefix + '<API_KEY>@'; }) : '';

        compatibilityOutput.textContent = [
          'default_surface=' + (compatibility.defaultSurface || 'openai'),
          'enabled_surfaces=' + (compatibility.enabledSurfaces || []).join(','),
          '',
          '[openai]',
          'enabled=' + String(Boolean(openai.enabled)),
          'OPENAI_API_URL=' + String(openai.routes && openai.routes.baseUrl || ''),
          'models=' + String(openai.routes && openai.routes.models || ''),
          'chat=' + String(openai.routes && openai.routes.chat || ''),
          'responses=' + String(openai.routes && openai.routes.responses || ''),
          '',
          '[deepseek]',
          'enabled=' + String(Boolean(deepseek.enabled)),
          'DEEPSEEK_API_URL=' + String(deepseek.routes && deepseek.routes.baseUrl || ''),
          'models=' + String(deepseek.routes && deepseek.routes.models || ''),
          'chat=' + String(deepseek.routes && deepseek.routes.chat || ''),
          '',
          '[ollama]',
          'enabled=' + String(Boolean(ollama.enabled)),
          'OLLAMA_SERVER_URL=' + ollamaServerUrl,
          'OLLAMA_SERVER_URL_with_basic_auth=' + ollamaAuthExample,
          'api_base=' + String(ollama.routes && (ollama.routes.apiBaseUrl || ollama.routes.baseUrl) || ''),
          'tags=' + String(ollama.routes && ollama.routes.tags || ''),
          'chat=' + String(ollama.routes && ollama.routes.chat || ''),
          'generate=' + String(ollama.routes && ollama.routes.generate || ''),
          'show=' + String(ollama.routes && ollama.routes.show || ''),
          'version=' + String(ollama.routes && ollama.routes.version || ''),
        ].join('\\n');
      }

      function resetAppForm() {
        appForm.reset();
        appForm.elements.id.value = '';
        appStatus.textContent = '';
      }

      function populateAppForm(app) {
        appForm.elements.id.value = app.id;
        appForm.elements.name.value = app.name;
        appForm.elements.allowedOrigins.value = app.allowedOrigins.join(', ');
        appForm.elements.allowedModels.value = app.allowedModels.join(', ');
        appForm.elements.sessionNamespace.value = app.sessionNamespace;
        appForm.elements.rateLimitPerMinute.value = app.rateLimitPerMinute;
        appForm.elements.maxConcurrency.value = app.maxConcurrency;
        appStatus.textContent = 'Editing ' + app.name + '.';
      }

      function renderApps(apps) {
        appsTable.innerHTML = apps.map(function(app) {
          const badge = app.revokedAt ? '<span class="chip bad">revoked</span>' : '<span class="chip good">active</span>';
          return '<tr>' +
            '<td><strong>' + escapeHtml(app.name) + '</strong><div class="footer-note">' + badge + '</div></td>' +
            '<td>' + escapeHtml(app.allowedOrigins.join(', ') || 'none') + '<div class="footer-note">models: ' + escapeHtml(app.allowedModels.join(', ')) + '</div></td>' +
            '<td><div>rpm: ' + escapeHtml(String(app.rateLimitPerMinute)) + '</div><div>conc: ' + escapeHtml(String(app.maxConcurrency)) + '</div><div class="footer-note mono">' + escapeHtml(app.keyPreview) + '</div></td>' +
            '<td><div class="button-row">' +
              '<button type="button" class="secondary" data-action="edit" data-id="' + escapeHtml(app.id) + '">Edit</button>' +
              '<button type="button" class="warn" data-action="rotate" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Rotate</button>' +
              '<button type="button" class="bad" data-action="revoke" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Revoke</button>' +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      function renderInteractions(summary) {
        interactionsTable.innerHTML = summary.recent.map(function(item) {
          const usage = item.usage ? item.usage.prompt_tokens + ' / ' + item.usage.completion_tokens + ' / ' + item.usage.total_tokens : 'n/a';
          const feedback = item.feedback ? '<span class="chip ' + item.feedback + '">' + item.feedback + '</span>' : '<span class="chip warn">unrated</span>';
          return '<tr>' +
            '<td>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '<div class="footer-note">' + escapeHtml(item.route) + '</div></td>' +
            '<td><strong>' + escapeHtml(item.appName) + '</strong></td>' +
            '<td>' + escapeHtml(item.promptExcerpt || '(empty)') + '</td>' +
            '<td>' + escapeHtml(item.responseExcerpt || item.error || '(empty)') + '</td>' +
            '<td>' + escapeHtml(usage) + '<div class="footer-note">' + escapeHtml(String(item.latencyMs || 0)) + ' ms</div></td>' +
            '<td>' + feedback +
              '<div class="button-row" style="margin-top:8px">' +
                '<button type="button" data-feedback="good" data-id="' + escapeHtml(item.id) + '">Good</button>' +
                '<button type="button" class="bad" data-feedback="bad" data-id="' + escapeHtml(item.id) + '">Bad</button>' +
                '<button type="button" class="secondary" data-feedback="clear" data-id="' + escapeHtml(item.id) + '">Clear</button>' +
              '</div>' +
              (item.feedbackNotes ? '<div class="footer-note">' + escapeHtml(item.feedbackNotes) + '</div>' : '') +
            '</td>' +
          '</tr>';
        }).join('');
      }

      async function loadPublicSummary() {
        const data = await request('/dashboard/summary');
        state.publicSummary = data;
        renderPublicPills(data);
        renderPublicStats(data);
        renderProviderState(data);
        renderHourlyChart(data);
        renderRouteChart(data);
      }

      async function loadAdminSummary() {
        const data = await request('/admin/summary');
        state.apps = data.apps;
        state.compatibility = data.compatibility || null;
        state.vncUrl = data.vncUrl || '';
        fillModelOptions(data.models);
        fillAppOptions(data.apps);
        renderRuntimePills(data);
        renderBackendDiagnostics(data);
        renderProviderState(data);
        renderStats(data.stats);
        renderCompatibility(data.compatibility);
        renderApps(data.apps);
        renderInteractions(data.stats);
        openVncLink.href = state.vncUrl || '#';
        vncFrame.src = state.vncUrl || 'about:blank';
        setAdminVisible(true);
        adminBannerTitle.textContent = 'Operator console active';
        adminBannerCopy.textContent = state.username ? 'Signed in as ' + state.username + '.' : 'Signed in as admin.';
      }

      async function refreshSession() {
        const me = await request('/auth/me');
        state.authenticated = me.authenticated === true;
        state.username = me.username || '';
        if (state.authenticated) {
          authSummary.textContent = state.username ? 'Admin session active for ' + state.username + '.' : 'Admin session active.';
          authStatus.textContent = '';
          await loadAdminSummary();
        } else {
          setAdminVisible(false);
          vncFrame.src = 'about:blank';
          authSummary.textContent = 'Guest view is active. Sign in to manage apps, keys, routes and diagnostics.';
          authStatus.textContent = '';
        }
      }

      loginForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        authStatus.textContent = 'Opening admin session…';
        const form = new FormData(loginForm);
        try {
          await request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              username: form.get('username'),
              password: form.get('password'),
            }),
          });
          loginForm.reset();
          await refreshSession();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      refreshButton.addEventListener('click', async function() {
        try {
          await loadPublicSummary();
          await refreshSession();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      menuRefreshButton.addEventListener('click', async function() {
        try {
          await loadPublicSummary();
          await refreshSession();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      async function logoutAdminSession() {
        try {
          await request('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
        } finally {
          state.authenticated = false;
          state.username = '';
          setAdminVisible(false);
          authSummary.textContent = 'Guest view is active. Sign in to manage apps, keys, routes and diagnostics.';
          authStatus.textContent = '';
          vncFrame.src = 'about:blank';
        }
      }

      logoutButton.addEventListener('click', logoutAdminSession);
      menuLogoutButton.addEventListener('click', logoutAdminSession);

      compatibilityForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        compatibilityStatus.textContent = 'Saving compatibility surfaces…';
        const enabledSurfaces = Array.from(compatibilityForm.querySelectorAll('input[name="enabledSurfaces"]:checked')).map(function(input) { return input.value; });
        try {
          await request('/admin/compatibility', {
            method: 'POST',
            body: JSON.stringify({
              defaultSurface: compatibilityForm.elements.defaultSurface.value,
              enabledSurfaces: enabledSurfaces,
            }),
          });
          compatibilityStatus.textContent = 'Compatibility surfaces updated.';
          await loadPublicSummary();
          await loadAdminSummary();
        } catch (error) {
          compatibilityStatus.textContent = error.message;
        }
      });

      promptForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        promptStatus.textContent = 'Sending prompt through the active router backend…';
        promptResponse.textContent = '';
        const form = new FormData(promptForm);
        try {
          const response = await request('/admin/test-chat', {
            method: 'POST',
            body: JSON.stringify({
              appId: form.get('appId'),
              model: form.get('model'),
              prompt: form.get('prompt'),
              systemPrompt: form.get('systemPrompt'),
              sessionHint: form.get('sessionHint'),
              stateful: form.get('stateful') === 'on',
            }),
          });
          promptStatus.textContent = 'Completed in ' + response.latencyMs + ' ms.';
          promptResponse.textContent = response.text || '';
          await loadPublicSummary();
          await loadAdminSummary();
        } catch (error) {
          promptStatus.textContent = error.message;
        }
      });

      appForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        const form = new FormData(appForm);
        const id = String(form.get('id') || '').trim();
        appStatus.textContent = id ? 'Updating app…' : 'Creating app…';
        const payload = {
          name: form.get('name'),
          allowedOrigins: String(form.get('allowedOrigins') || '').split(',').map(function(item) { return item.trim(); }).filter(Boolean),
          allowedModels: String(form.get('allowedModels') || '').split(',').map(function(item) { return item.trim(); }).filter(Boolean),
          sessionNamespace: form.get('sessionNamespace'),
          rateLimitPerMinute: Number(form.get('rateLimitPerMinute') || 0),
          maxConcurrency: Number(form.get('maxConcurrency') || 0),
        };
        try {
          const response = await request(id ? '/admin/apps/' + encodeURIComponent(id) : '/admin/apps', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(payload),
          });
          appStatus.textContent = id ? 'App updated.' : ('App created. Save this key now: ' + response.apiKey);
          resetAppForm();
          await loadAdminSummary();
        } catch (error) {
          appStatus.textContent = error.message;
        }
      });

      appReset.addEventListener('click', resetAppForm);

      appsTable.addEventListener('click', async function(event) {
        const target = event.target.closest('button');
        if (!target) return;
        const id = target.dataset.id;
        const action = target.dataset.action;
        const app = state.apps.find(function(entry) { return entry.id === id; });
        if (!app) return;
        try {
          if (action === 'edit') {
            populateAppForm(app);
            return;
          }
          if (action === 'rotate') {
            const response = await request('/admin/apps/' + encodeURIComponent(id) + '/rotate', {
              method: 'POST',
              body: JSON.stringify({}),
            });
            appStatus.textContent = 'Key rotated. New key: ' + response.apiKey;
          }
          if (action === 'revoke') {
            await request('/admin/apps/' + encodeURIComponent(id) + '/revoke', {
              method: 'POST',
              body: JSON.stringify({}),
            });
            appStatus.textContent = 'App revoked.';
          }
          await loadAdminSummary();
        } catch (error) {
          appStatus.textContent = error.message;
        }
      });

      interactionsTable.addEventListener('click', async function(event) {
        const target = event.target.closest('button');
        if (!target) return;
        const id = target.dataset.id;
        const feedback = target.dataset.feedback;
        if (!id || !feedback) return;
        try {
          if (feedback === 'clear') {
            await request('/admin/interactions/' + encodeURIComponent(id) + '/feedback', { method: 'DELETE' });
          } else {
            const notes = window.prompt('Optional note for this rating:', '') || '';
            await request('/admin/interactions/' + encodeURIComponent(id) + '/feedback', {
              method: 'POST',
              body: JSON.stringify({ feedback: feedback, notes: notes }),
            });
          }
          await loadAdminSummary();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      Promise.resolve()
        .then(loadPublicSummary)
        .then(refreshSession)
        .catch(function(error) {
          authStatus.textContent = error.message;
        });
    </script>
  </body>
</html>`;
}
