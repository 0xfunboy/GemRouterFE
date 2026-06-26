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

const UI_ICON_DATA_URI = loadPngDataUri('GemRouter_Icon_logo256.png');
const UI_WORDMARK_DATA_URI = loadPngDataUri('GemRouter_Wordmark.png');

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
  const pageTitle = `${input.projectName} - Gemini API Compatibility Router`;
  const pageDescription = 'GemRouter routes across Gemini API keys while exposing OpenAI, DeepSeek, and Ollama compatible APIs.';
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
        /* Squared house style: no rounded corners, one uniform gap between frames. */
        --radius: 0px;
        --radius-sm: 0px;
        --frame-gap: 5mm;
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
        background-attachment: fixed, fixed, fixed, fixed, fixed, fixed;
        color: var(--text);
      }
      a { color: inherit; text-decoration: none; }
      button, input, textarea, select { font: inherit; }
      h1, h2, h3, h4, p { margin: 0; }
      .hidden { display: none !important; }
      .app-shell {
        width: min(1480px, calc(100vw - 28px));
        margin: 14px auto 28px;
        display: grid;
        gap: 16px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 0;
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
        display: grid;
        place-items: center;
        /* Floating logo: no surrounding box, background, or border. */
        background: none;
        border: 0;
        font-weight: 700;
        flex: 0 0 auto;
      }
      .brand-mark img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
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
        border-radius: 0;
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
        gap: var(--frame-gap);
        padding: 18px;
        overflow: visible;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
        padding: 7px 11px;
        border-radius: 0;
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
        border-radius: 0;
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
        border-radius: 0;
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
        border-radius: 0;
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
        border-radius: 0;
        background:
          linear-gradient(rgba(24, 240, 208, 0.1) 1px, transparent 1px),
          linear-gradient(90deg, rgba(24, 240, 208, 0.1) 1px, transparent 1px),
          rgba(2, 5, 12, 0.44);
        background-size: 14px 14px;
      }
      .heartbeat-line {
        position: absolute;
        inset: 0;
        width: 200%;
        height: 100%;
        background: none;
        display: flex;
        filter: drop-shadow(0 0 7px rgba(24, 240, 208, 0.85));
        animation: ecg-block-drift calc(var(--heartbeat-speed, 7.2s) * 2) linear infinite;
      }
      .heartbeat-line svg {
        display: block;
        width: 50%;
        height: 100%;
        flex: 0 0 50%;
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
      @keyframes ecg-block-drift {
        from { transform: translateX(-50%); }
        to { transform: translateX(0); }
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
        border-radius: 0;
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
        border-radius: 0;
      }
      textarea {
        min-height: 126px;
        resize: vertical;
      }
      .compact-textarea {
        min-height: 46px;
        max-height: 180px;
        overflow: auto;
        resize: vertical;
      }
      .prompt-user-textarea {
        min-height: 84px;
        box-shadow: 0 0 0 1px rgba(81, 255, 155, 0.16), 0 0 24px rgba(81, 255, 155, 0.08);
      }
      .prompt-user-textarea:focus {
        outline: none;
        border-color: rgba(81, 255, 155, 0.34);
        box-shadow: 0 0 0 1px rgba(81, 255, 155, 0.22), 0 0 28px rgba(81, 255, 155, 0.14);
      }
      button {
        border: 1px solid var(--line-strong);
        border-radius: 0;
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
        gap: var(--frame-gap);
      }
      #admin-dashboard {
        display: grid;
        gap: var(--frame-gap);
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
      .section-head-actions {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-left: auto;
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
        gap: var(--frame-gap);
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .card {
        padding: 16px;
        border-radius: 0;
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
        gap: var(--frame-gap);
        grid-template-columns: 1.15fr 0.85fr;
      }
      .apps-shell {
        grid-template-columns: minmax(240px, 0.58fr) minmax(620px, 1.42fr);
        align-items: start;
      }
      .chart-card {
        display: grid;
        gap: 14px;
      }
      .chart-frame {
        position: relative;
        min-height: 220px;
        padding: 14px;
        border-radius: 0;
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
        border-radius: 0;
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
        border-radius: 0;
        background: rgba(255, 255, 255, 0.06);
      }
      .route-fill {
        height: 100%;
        border-radius: 0;
        background: linear-gradient(90deg, rgba(16, 163, 127, 0.88), rgba(62, 169, 255, 0.88));
      }
      .role-banner {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border-radius: 0;
        background: linear-gradient(135deg, rgba(16, 163, 127, 0.14), rgba(62, 169, 255, 0.12));
        border: 1px solid rgba(16, 163, 127, 0.18);
      }
      .role-banner strong {
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .role-banner.is-critical {
        background: linear-gradient(135deg, rgba(255, 65, 82, 0.22), rgba(255, 170, 70, 0.13));
        border-color: rgba(255, 65, 82, 0.5);
        box-shadow: 0 0 34px rgba(255, 65, 82, 0.16);
      }
      .response-box, .mono-box {
        min-height: 220px;
        padding: 14px;
        border-radius: 0;
        background: var(--surface-muted);
        border: 1px solid var(--line);
        white-space: pre-wrap;
        line-height: 1.65;
        overflow: auto;
      }
      .response-box.markdown-body {
        white-space: normal;
      }
      .response-box.markdown-body > :first-child {
        margin-top: 0;
      }
      .response-box.markdown-body > :last-child {
        margin-bottom: 0;
      }
      .response-box.markdown-body h1,
      .response-box.markdown-body h2,
      .response-box.markdown-body h3 {
        margin: 1.1em 0 0.45em;
        line-height: 1.2;
        letter-spacing: -0.03em;
      }
      .response-box.markdown-body p,
      .response-box.markdown-body ul,
      .response-box.markdown-body ol,
      .response-box.markdown-body blockquote,
      .response-box.markdown-body pre {
        margin: 0.75em 0;
      }
      .response-box.markdown-body ul,
      .response-box.markdown-body ol {
        padding-left: 1.35em;
      }
      .response-box.markdown-body blockquote {
        padding-left: 12px;
        border-left: 2px solid var(--line-strong);
        color: var(--muted);
      }
      .response-box.markdown-body code {
        padding: 0.1em 0.35em;
        border-radius: 0;
        background: rgba(255, 255, 255, 0.06);
      }
      .response-box.markdown-body pre code {
        display: block;
        padding: 12px;
        overflow: auto;
        background: rgba(3, 5, 8, 0.68);
        border: 1px solid var(--line);
      }
      .response-box.markdown-body a {
        color: var(--accent);
      }
      .prompt-response-box {
        box-shadow: 0 0 0 1px rgba(255, 95, 143, 0.16), 0 0 26px rgba(255, 95, 143, 0.08);
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
        border-radius: 0;
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
      .public-rpd-table {
        min-width: 0;
        table-layout: fixed;
      }
      .public-rpd-table th:nth-child(1), .public-rpd-table td:nth-child(1) { width: 34%; }
      .public-rpd-table th:nth-child(2), .public-rpd-table td:nth-child(2) { width: 14%; }
      .public-rpd-table th:nth-child(3), .public-rpd-table td:nth-child(3) { width: 22%; }
      .public-rpd-table th:nth-child(4), .public-rpd-table td:nth-child(4) { width: 16%; }
      .public-rpd-table th:nth-child(5), .public-rpd-table td:nth-child(5) { width: 14%; }
      .quota-meter {
        width: 76px;
        height: 7px;
        overflow: hidden;
        border-radius: 0;
        background: var(--surface-muted);
        border: 1px solid var(--line);
      }
      .quota-meter > span {
        display: block;
        height: 100%;
        min-width: 2px;
        background: var(--good);
      }
      .quota-meter.warn > span { background: var(--warn); }
      .quota-meter.bad > span { background: var(--bad); }
      .interactions-table {
        min-width: 0;
        table-layout: fixed;
      }
      .interactions-table th:nth-child(1), .interactions-table td:nth-child(1) { width: 10%; }
      .interactions-table th:nth-child(2), .interactions-table td:nth-child(2) { width: 8%; }
      .interactions-table th:nth-child(3), .interactions-table td:nth-child(3) { width: 17%; }
      .interactions-table th:nth-child(4), .interactions-table td:nth-child(4) { width: 21%; }
      .interactions-table th:nth-child(5), .interactions-table td:nth-child(5) { width: 26%; }
      .interactions-table th:nth-child(6), .interactions-table td:nth-child(6) { width: 8%; }
      .interactions-table th:nth-child(7), .interactions-table td:nth-child(7) { width: 10%; }
      .interactions-table td {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
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
        border-radius: 0;
        background: #030508;
      }
      .auth-grid {
        display: grid;
        gap: 12px;
      }
      .muted {
        color: var(--muted);
      }
      .field-inline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .section-inline-control {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .section-inline-control select {
        width: auto;
        min-width: 74px;
        padding: 8px 28px 8px 10px;
      }
      .field-help {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 0;
        border: 1px solid var(--line);
        color: var(--muted);
        font: 700 10px/1 "IBM Plex Mono", monospace;
        cursor: help;
      }
      .model-picker {
        border: 1px solid var(--line);
        border-radius: 0;
        background: var(--surface-muted);
      }
      .model-picker summary {
        padding: 12px 14px;
        cursor: pointer;
        color: var(--text);
        list-style: none;
      }
      .model-picker summary::-webkit-details-marker {
        display: none;
      }
      .model-picker-panel {
        max-height: 280px;
        overflow: auto;
        border-top: 1px solid var(--line);
      }
      .model-picker-option {
        display: grid;
        gap: 2px;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      .model-picker-option.is-disabled {
        opacity: 0.6;
      }
      .model-picker-option:last-child {
        border-bottom: 0;
      }
      .model-picker-option input {
        width: auto;
        margin-right: 8px;
      }
      .section-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 108px;
        justify-content: center;
      }
      .section-toggle-label {
        font-size: 12px;
      }
      .section-toggle-arrow {
        display: inline-block;
        line-height: 1;
        transition: transform 0.18s ease;
      }
      .section-toggle[aria-expanded="true"] .section-toggle-arrow {
        transform: rotate(90deg);
      }
      .rpd-toggle-arrow {
        display: inline-block;
        line-height: 1;
        transition: transform 0.18s ease;
      }
      .rpd-toggle[aria-expanded="true"] .rpd-toggle-arrow {
        transform: rotate(90deg);
      }
      .model-picker-title {
        color: var(--text);
        font-size: 12px;
      }
      .apps-table {
        min-width: 640px;
      }
      .apps-table th,
      .apps-table td {
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .image-preview-box {
        min-height: 220px;
        padding: 14px;
        border-radius: 0;
        background: var(--surface-muted);
        border: 1px solid var(--line);
      }
      .image-preview-grid {
        display: grid;
        gap: 12px;
      }
      .image-preview-card {
        display: grid;
        gap: 10px;
      }
      .image-preview-card img {
        width: 100%;
        border-radius: 0;
        border: 1px solid var(--line);
        background: rgba(3, 5, 8, 0.68);
        cursor: zoom-in;
        transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
      }
      .image-preview-card img:hover {
        transform: translateY(-1px);
        border-color: var(--line-strong);
        box-shadow: 0 0 22px rgba(24, 240, 208, 0.08);
      }
      .image-preview-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .image-download-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 0;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        font-size: 12px;
      }
      .image-download-link:hover {
        border-color: var(--line-strong);
        color: var(--accent);
      }
      .image-lightbox {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 28px;
        background: rgba(3, 5, 8, 0.84);
        backdrop-filter: blur(10px);
        z-index: 1500;
        cursor: zoom-out;
      }
      .image-lightbox img {
        display: block;
        max-width: min(92vw, 1440px);
        max-height: 88vh;
        width: auto;
        height: auto;
        border-radius: 0;
        border: 1px solid var(--line-strong);
        box-shadow: 0 34px 90px rgba(0, 0, 0, 0.55);
        background: rgba(3, 5, 8, 0.8);
      }
      .image-lightbox.hidden {
        display: none !important;
      }
      .key-modal {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 28px;
        background: rgba(3, 5, 8, 0.84);
        backdrop-filter: blur(12px);
        z-index: 1600;
      }
      .key-modal.hidden {
        display: none !important;
      }
      .key-modal-card {
        width: min(680px, 100%);
        padding: 20px;
        border-radius: 0;
        border: 1px solid var(--line-strong);
        background: var(--surface-strong);
        box-shadow: 0 34px 90px rgba(0, 0, 0, 0.55);
      }
      .key-modal-card input[readonly] {
        font-family: "IBM Plex Mono", "SFMono-Regular", "Consolas", monospace;
        letter-spacing: 0.01em;
      }
      .key-modal-warning {
        margin-bottom: 14px;
        color: var(--warn);
        font-size: 12px;
      }
      .app-footer {
        padding: 18px;
      }
      .footer-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(240px, 1.05fr) minmax(0, 1.95fr);
        align-items: start;
      }
      .footer-brand {
        display: grid;
        gap: 12px;
      }
      .footer-brand-top {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .footer-brand-top span {
        color: var(--accent);
      }
      .footer-brand-mark {
        width: 40px;
        height: 40px;
        color: var(--accent);
        flex: 0 0 auto;
      }
      .footer-brand-copy {
        max-width: 26ch;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.7;
      }
      .footer-blog-link {
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
      }
      .footer-blog-link:hover {
        color: var(--accent);
      }
      .footer-columns {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .footer-column {
        display: grid;
        gap: 8px;
      }
      .footer-column h4 {
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .footer-column a {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .footer-column a:hover {
        color: var(--accent);
      }
      .footer-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
      }
      .footer-legal {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.7;
      }
      .footer-socials {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
      }
      .footer-social-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        border-radius: 0;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        color: var(--muted);
      }
      .footer-social-link:hover {
        color: var(--accent);
        border-color: var(--line-strong);
      }
      .footer-social-link svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
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
        .footer-grid {
          grid-template-columns: 1fr;
        }
        .footer-columns {
          grid-template-columns: repeat(2, minmax(0, 1fr));
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
        .footer-columns {
          grid-template-columns: 1fr 1fr;
        }
        .footer-bottom {
          flex-direction: column;
          align-items: flex-start;
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
            <span>Gemini API router with compatible API surfaces</span>
          </div>
        </div>
        <div class="nav-actions nav-menu">
          <button id="theme-toggle" type="button" class="secondary">${svgIcon('moon')} Toggle theme</button>
          <a id="health-link" class="secondary" href="/health" target="_blank" rel="noreferrer">${svgIcon('health')} Health</a>
          <button id="menu-refresh-button" type="button" class="secondary">${svgIcon('activity')} Refresh</button>
          <button id="menu-toggle" type="button" class="secondary" aria-label="Open admin login" title="Admin login">${svgIcon('admin')}</button>
          <div id="top-menu" class="menu-popover hidden">
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
              <div class="footer-note" style="margin-top:12px">Admin actions stay in this browser session and use the same backend APIs exposed by GemRouter.</div>
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
                <svg viewBox="0 0 960 86" preserveAspectRatio="none">
                  <path class="ecg-persistence" d="M0 45 H80 L92 45 L102 37 L112 51 L124 45 H176 L188 45 L198 25 L210 74 L224 10 L240 45 H312 L326 45 L338 34 L350 55 L364 45 H480 L560 45 L572 45 L582 37 L592 51 L604 45 H656 L668 45 L678 25 L690 74 L704 10 L720 45 H792 L806 45 L818 34 L830 55 L844 45 H960" />
                  <path class="ecg-trace" d="M0 45 H80 L92 45 L102 37 L112 51 L124 45 H176 L188 45 L198 25 L210 74 L224 10 L240 45 H312 L326 45 L338 34 L350 55 L364 45 H480 L560 45 L572 45 L582 37 L592 51 L604 45 H656 L668 45 L678 25 L690 74 L704 10 L720 45 H792 L806 45 L818 34 L830 55 L844 45 H960" />
                </svg>
              </div>
              <div class="ecg-sweep"></div>
            </div>
          </div>
        </div>
        <div class="source-grid">
          <div class="source-card">
            <strong>${svgIcon('api')} Gemini API</strong>
            <p>Multi-key pool with real account metadata in admin, local RPM/TPM/RPD ledger, model discovery, and quota-aware routing.</p>
          </div>
          <div class="source-card">
            <strong>${svgIcon('route')} Fallback Routing</strong>
            <p>Automatic fallback across configured Gemini API keys and allowed text models when an upstream path is exhausted, rate-limited, or temporarily unavailable.</p>
          </div>
          <div class="source-card">
            <strong>${svgIcon('chart')} Operator Surface</strong>
            <p>Compatibility controls, prompt testing, quota visibility, app management, and interaction telemetry in one admin UI.</p>
          </div>
        </div>
      </section>

      <section class="panel section">
        <div class="section-head">
          <div>
            <h2 class="section-title">${svgIcon('activity')} Guest Overview</h2>
            <p class="section-copy">Guest view hides prompts, app names, secrets, and raw key metadata. It shows aggregate usage, sanitized routing state, and Gemini quota state.</p>
          </div>
          <div id="public-runtime-pills" class="meta-row"></div>
        </div>
        <div id="public-stats" class="stats-grid"></div>
      </section>

      <section class="panel section">
        <div class="section-head">
          <div>
            <h3 class="section-title">${svgIcon('api')} Gemini RPD Capacity</h3>
          </div>
          <div id="provider-pills" class="meta-row"></div>
        </div>
        <div>
          <p id="public-rpd-copy" class="section-copy" style="margin-bottom:8px">Loading router quota ledger.</p>
          <div class="table-wrap">
            <table class="table responsive-table quota-table public-rpd-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Accounts</th>
                  <th>RPD left</th>
                  <th>Used / limit</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="public-rpd-table"></tbody>
            </table>
          </div>
          <p class="section-copy" style="margin:18px 0 8px">Per-account daily request capacity from the same ledger used by routing. RPD resets at the next Pacific midnight.</p>
          <div class="table-wrap">
            <table class="table responsive-table quota-table public-rpd-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Model</th>
                  <th>RPD left</th>
                  <th>Used / limit</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="public-rpd-account-table"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel section" id="ollama-local-section" style="display:none">
        <div class="section-head">
          <div>
            <h3 class="section-title">${svgIcon('chart')} Ollama Local RPD</h3>
            <p class="section-copy">Local-only embedding and vision models with their daily request budgets (resets America/Los_Angeles).</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table responsive-table quota-table public-rpd-table">
            <thead>
              <tr><th>Model</th><th>Type</th><th>RPD</th><th></th></tr>
            </thead>
            <tbody id="ollama-local-table"></tbody>
          </table>
        </div>
      </section>

      <section class="panel section">
        <div class="chart-grid">
          <div class="chart-card">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('chart')} 24h Throughput</h3>
              <p class="section-copy">Last 24 clock hours of request volume. Failed requests are highlighted when present.</p>
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
              <p class="section-copy">Top compatibility traffic families across the latest 240 logged interactions. Each bar shows request count and share of this sampled window.</p>
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
              <h3 class="section-title">Backend Routing</h3>
              <p class="section-copy">Requests stay on official Gemini API keys. Fallback rotates to the next usable key when a request hits a fallback-eligible upstream failure.</p>
            </div>
            <div class="section-head-actions">
              <div id="backend-pills" class="meta-row"></div>
              <button type="button" class="secondary section-toggle" data-section-toggle="backend-section-body" aria-controls="backend-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="backend-section-body" class="section-body hidden">
            <div id="backend-output" class="mono-box">Loading backend routing snapshot…</div>
            <div id="backend-hint" class="footer-note" style="margin-top:10px"></div>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('api')} Provider Diagnostics</h3>
              <p class="section-copy">Admin-only raw backend state for the Gemini API key pool and fallback investigation.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="provider-section-body" aria-controls="provider-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="provider-section-body" class="section-body hidden">
            <div id="provider-output" class="mono-box">Loading model and quota snapshot…</div>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('api')} Gemini Accounts</h3>
              <p class="section-copy">Manage the Gemini API key pool: add accounts, set per-account priority, enable/disable, and download the free models each account can serve. Changes apply live and persist to the accounts file.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="accounts-section-body" aria-controls="accounts-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="accounts-section-body" class="section-body hidden">
            <div class="table-wrap">
              <table class="table responsive-table">
                <thead>
                  <tr><th>Account</th><th>Quota group</th><th>Priority</th><th>Enabled</th><th>Key</th><th>Actions</th></tr>
                </thead>
                <tbody id="accounts-table"></tbody>
              </table>
            </div>
            <div id="accounts-status" class="footer-note" style="margin-top:8px"></div>

            <div class="shell-grid" style="margin-top:16px">
              <div>
                <h4 class="model-picker-title">Add account</h4>
                <form id="account-add-form" class="stack" autocomplete="off">
                  <input class="input" id="account-add-key" type="password" placeholder="API key secret (AIza… / AQ.…)" required />
                  <input class="input" id="account-add-owner" type="text" placeholder="Label / owner (optional)" />
                  <input class="input" id="account-add-group" type="text" placeholder="Quota group / project id (optional)" />
                  <input class="input" id="account-add-priority" type="number" placeholder="Priority (default 100)" />
                  <button type="submit" class="primary">Add account</button>
                </form>
              </div>
              <div>
                <h4 class="model-picker-title">Download free models</h4>
                <div class="stack">
                  <select class="input" id="account-models-select"></select>
                  <button type="button" class="secondary" id="account-models-btn">Fetch models for account</button>
                  <div id="account-models-output" class="mono-box" style="max-height:280px;overflow:auto">Pick an account and fetch its catalog.</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('plug')} Outbound Proxy</h3>
              <p class="section-copy">Manage the outbound proxy pool. Disabled by default and not yet applied to upstream calls (Gemini runs direct from the host IP); configure it here so it is ready when needed.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="proxy-section-body" aria-controls="proxy-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="proxy-section-body" class="section-body hidden">
            <form id="proxy-form" class="stack" autocomplete="off">
              <label class="model-picker-option"><div><input type="checkbox" id="proxy-enabled" /> <span class="model-picker-title">Enable outbound proxy</span></div></label>
              <label class="footer-note">Strategy
                <select class="input" id="proxy-strategy">
                  <option value="round-robin">round-robin</option>
                  <option value="random">random</option>
                </select>
              </label>
              <label class="footer-note">Proxy URLs (one per line, e.g. http://user:pass@host:port)
                <textarea class="input" id="proxy-urls" rows="4" placeholder="http://user:pass@host:port"></textarea>
              </label>
              <label class="footer-note">Bypass hosts (one per line; supports *.suffix)
                <textarea class="input" id="proxy-bypass" rows="3"></textarea>
              </label>
              <button type="submit" class="primary">Save proxy config</button>
              <div id="proxy-status" class="footer-note"></div>
            </form>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">${svgIcon('route')} Routed Models</h3>
              <p class="section-copy">Choose which Gemini models the router offers and in what order (strongest first). The first entry is the default; the rest are the fallback chain. Applies live and persists.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="models-config-body" aria-controls="models-config-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="models-config-body" class="section-body hidden">
            <div class="shell-grid">
              <div>
                <h4 class="model-picker-title">Enabled - in routing order</h4>
                <div id="models-enabled" class="model-picker-panel"></div>
              </div>
              <div>
                <h4 class="model-picker-title">Available</h4>
                <div id="models-available" class="model-picker-panel"></div>
              </div>
            </div>
            <div style="margin-top:12px">
              <button type="button" class="primary" id="models-config-save">Save model order</button>
              <div id="models-config-status" class="footer-note" style="margin-top:8px"></div>
            </div>
          </div>
        </section>


        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Compatibility Surfaces</h3>
              <p class="section-copy">Choose the primary compatibility surface and inspect the routed endpoints.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="compatibility-section-body" aria-controls="compatibility-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="compatibility-section-body" class="section-body hidden">
          <div class="shell-grid">
            <div>
              <form id="compatibility-form">
                <label>
                  Primary surface
                  <select name="defaultSurface">
                    <option value="gemrouter">gemrouter</option>
                    <option value="openai">openai</option>
                    <option value="deepseek">deepseek</option>
                    <option value="ollama">ollama</option>
                  </select>
                </label>
                <div id="compatibility-status" class="status">Changes apply automatically when you switch the surface.</div>
              </form>
              <div class="section-head" style="margin-top:24px">
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
                  <textarea class="compact-textarea" rows="1" name="systemPrompt" placeholder="Optional system instruction"></textarea>
                </label>
                <label>
                  User prompt
                  <textarea class="compact-textarea prompt-user-textarea" rows="2" data-min-height="84" name="prompt" placeholder="Write a prompt to test" required></textarea>
                </label>
                <label>
                  Session hint
                  <input type="text" name="sessionHint" placeholder="Optional session hint" />
                </label>
                <div class="button-row">
                  <button type="submit">Run prompt</button>
                </div>
                <div id="prompt-status" class="status"></div>
              </form>
              <div id="prompt-response" class="response-box markdown-body prompt-response-box"><div class="muted">No prompt run yet.</div></div>
            </div>
            <div>
              <div id="compatibility-output" class="mono-box">Loading compatibility surface snapshot…</div>
              <div class="footer-note" style="margin-top:10px">
                For Eliza with <span class="mono">modelProvider=ollama</span>, use <span class="mono">OLLAMA_SERVER_URL</span>
                without <span class="mono">/api</span>.
              </div>
              <div class="section-head" style="margin-top:18px">
                <div>
                  <h3 class="section-title" style="font-size:15px">${svgIcon('api')} Generated Image</h3>
                  <p class="section-copy">Shown here when the selected model returns inline image output.</p>
                </div>
              </div>
              <div id="prompt-image-output" class="image-preview-box"><div class="muted">No generated image yet.</div></div>
            </div>
          </div>
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Apps and API Keys</h3>
              <p class="section-copy">Create apps, rotate API keys, and manage client-facing limits from one console.</p>
            </div>
            <div class="section-head-actions">
              <button type="button" class="secondary section-toggle" data-section-toggle="apps-section-body" aria-controls="apps-section-body" aria-expanded="false">
                <span class="section-toggle-label">Expand</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="apps-section-body" class="section-body hidden">
          <div class="shell-grid apps-shell">
            <div>
              <form id="app-form">
                <input type="hidden" name="id" />
                <label>
                  App name
                  <input type="text" name="name" placeholder="client-app" required />
                </label>
                <label>
                  Allowed origins
                  <textarea class="compact-textarea" rows="1" name="allowedOrigins" placeholder="https://app.example.com, http://localhost:*"></textarea>
                </label>
                <label>
                  Allowed models
                  <details id="allowed-models-picker" class="model-picker">
                    <summary>Select allowed models</summary>
                    <div id="allowed-models-options" class="model-picker-panel"></div>
                  </details>
                  <div id="allowed-models-summary" class="footer-note">Empty selection uses the bootstrap defaults.</div>
                </label>
                <label>
                  Session namespace
                  <input type="text" name="sessionNamespace" placeholder="client-app" />
                </label>
                <label>
                  <span class="field-inline">Custom API key <span class="field-help" title="Optional. Leave empty to auto-generate. Use to set a custom prefix, e.g. goon_...">?</span></span>
                  <input type="text" name="apiKey" placeholder="(optional) e.g. goon_..." autocomplete="off" />
                </label>
                <label>
                  <span class="field-inline">Rate limit per minute <span class="field-help" title="Zero for no limits">?</span></span>
                  <input type="number" min="0" step="1" name="rateLimitPerMinute" value="30" />
                </label>
                <label>
                  <span class="field-inline">Max concurrency <span class="field-help" title="Zero for no limits">?</span></span>
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
              <table class="table apps-table">
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
          </div>
        </section>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Recent Interactions</h3>
              <p class="section-copy">Prompt and output excerpts, token usage, latency, and operator feedback.</p>
            </div>
            <div class="section-head-actions">
              <label class="section-inline-control" for="interactions-app-filter">
                App
                <select id="interactions-app-filter">
                  <option value="">All apps</option>
                </select>
              </label>
              <label class="section-inline-control" for="interactions-limit-select">
                Latest
                <select id="interactions-limit-select">
                  <option value="10" selected>10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                </select>
              </label>
              <button type="button" class="secondary section-toggle" data-section-toggle="interactions-section-body" aria-controls="interactions-section-body" aria-expanded="true">
                <span class="section-toggle-label">Collapse</span>
                <span class="section-toggle-arrow" aria-hidden="true">▸</span>
              </button>
            </div>
          </div>
          <div id="interactions-section-body" class="section-body">
          <div class="table-wrap">
            <table class="table responsive-table interactions-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>App</th>
                  <th>Routing</th>
                  <th>Prompt</th>
                  <th>Output</th>
                  <th>Usage</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody id="interactions-table"></tbody>
            </table>
          </div>
          </div>
        </section>
      </section>
      <footer class="panel app-footer">
        <div class="footer-grid">
          <div class="footer-brand">
            <div class="footer-brand-top">
              <svg class="footer-brand-mark" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M20 4L6 36H14L20 22L26 36H34L20 4Z" fill="currentColor" />
                <path d="M20 12V22" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <span>AIRewardrop</span>
            </div>
            <p class="footer-brand-copy">Autonomous agent infrastructure for crypto.</p>
            <a class="footer-blog-link" href="https://airewardrop.xyz/blog" target="_blank" rel="noreferrer">Our Blog →</a>
          </div>
          <div class="footer-columns">
            <div class="footer-column">
              <h4>Navigate</h4>
              <a href="https://airewardrop.xyz/products" target="_blank" rel="noreferrer">Products</a>
              <a href="https://airewardrop.xyz/agents" target="_blank" rel="noreferrer">Agents</a>
              <a href="https://airewardrop.xyz/roadmap" target="_blank" rel="noreferrer">Roadmap</a>
              <a href="https://airewardrop.xyz/clients" target="_blank" rel="noreferrer">Clients</a>
            </div>
            <div class="footer-column">
              <h4>Resources</h4>
              <a href="https://airewardrop.xyz/commands" target="_blank" rel="noreferrer">User Manual</a>
              <a href="https://airewardrop.xyz/tokenomics" target="_blank" rel="noreferrer">Tokenomics</a>
              <a href="https://airewardrop.xyz/api-plugins" target="_blank" rel="noreferrer">API &amp; Plugins</a>
              <a href="https://airewardrop.xyz/faq" target="_blank" rel="noreferrer">FAQ</a>
            </div>
            <div class="footer-column">
              <h4>Community</h4>
              <a href="https://t.me/AIRewardrop" target="_blank" rel="noreferrer">Telegram Channel</a>
              <a href="https://t.me/AIR3Community" target="_blank" rel="noreferrer">Telegram Community</a>
              <a href="https://discord.gg/S4f87VdsHt" target="_blank" rel="noreferrer">Discord</a>
            </div>
            <div class="footer-column">
              <h4>Legal</h4>
              <a href="https://airewardrop.xyz/legal" target="_blank" rel="noreferrer">Terms of Service</a>
              <a href="https://airewardrop.xyz/legal" target="_blank" rel="noreferrer">Privacy Policy</a>
              <a href="https://airewardrop.xyz/legal" target="_blank" rel="noreferrer">Cookie Policy</a>
            </div>
          </div>
        </div>
        <div class="footer-bottom">
          <div class="footer-legal">
            <div>© 2025 AIRewardrop. All rights reserved.</div>
            <div>Disclaimer: Not financial advice. Always do your own research.</div>
          </div>
          <div class="footer-socials">
            <a class="footer-social-link" href="https://x.com/AIRewardrop" target="_blank" rel="noreferrer" aria-label="X / Twitter">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a class="footer-social-link" href="https://t.me/AIR3Community" target="_blank" rel="noreferrer" aria-label="Telegram">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.043 7.924c-.234-.94-.83-1.21-1.42.21L11.79 12.2l-3.26-1.026c-1.154-.384-1.153-1.144.24-1.523l8.693-2.9c.9-.3 1.623.192 1.348 1.487l-1.9 8.54c-.23 1.053-1.002 1.3-1.802.82l-3.514-2.58-1.7 1.64c-.19.19-.35.35-.69.35-.46 0-.62-.16-.69-.77l.25-2.22 5.02-4.52c.46-.43-.1-.68-.69-.26l-6.3 3.97-3.34-1.04c-1.02-.31-1.05-.98.24-1.42l1.33-.45z" />
              </svg>
            </a>
            <a class="footer-social-link" href="https://discord.gg/S4f87VdsHt" target="_blank" rel="noreferrer" aria-label="Discord">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M20.317 4.369A19.791 19.791 0 0016.556 3c-.215.39-.463.917-.636 1.333a18.626 18.626 0 00-3.848 0A12.64 12.64 0 0011.436 3a19.736 19.736 0 00-3.762 1.385c-2.381 3.49-3.025 6.892-2.701 10.24a19.903 19.903 0 003.996 2.02c.33-.452.624-.934.873-1.442a12.815 12.815 0 001.696.136c.6.021 1.2-.02 1.794-.123.253.5.546.98.872 1.432a19.758 19.758 0 004.003-2.03c.332-3.348-.321-6.75-2.703-10.239zM9.845 14.9c-.785 0-1.43-.72-1.43-1.606 0-.886.636-1.606 1.43-1.606.803 0 1.439.73 1.43 1.606 0 .886-.636 1.606-1.43 1.606zm4.31 0c-.785 0-1.43-.72-1.43-1.606 0-.886.636-1.606 1.43-1.606.803 0 1.439.73 1.43 1.606 0 .886-.627 1.606-1.43 1.606z" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
      <div id="image-lightbox" class="image-lightbox hidden" aria-hidden="true">
        <img id="image-lightbox-media" src="" alt="Expanded generated image" />
      </div>
      <div id="app-key-modal" class="key-modal hidden" aria-hidden="true">
        <div id="app-key-modal-card" class="key-modal-card" role="dialog" aria-modal="true" aria-labelledby="app-key-modal-title">
          <div class="section-head" style="margin-bottom:14px">
            <div>
              <h3 id="app-key-modal-title" class="section-title" style="font-size:18px">API key ready</h3>
              <p class="section-copy">This key will be shown only once. Save it now.</p>
            </div>
            <button id="app-key-modal-close" type="button" class="secondary">Close</button>
          </div>
          <div class="key-modal-warning">This key will be shown only once. Save it now.</div>
          <label>
            API key
            <input id="app-key-modal-input" type="text" readonly value="" />
          </label>
          <div class="button-row" style="margin-top:14px">
            <button id="app-key-modal-copy" type="button">Copy key</button>
          </div>
          <div id="app-key-modal-status" class="status" style="margin-top:10px"></div>
        </div>
      </div>
    </main>

    <script>
      window.__GEMROUTER_BOOTSTRAP__ = ${bootstrap};
    </script>
    <script>
      const bootstrap = window.__GEMROUTER_BOOTSTRAP__;
      const state = {
        apps: [],
        appFormDirty: false,
        modelsConfigDirty: false,
        proxyDirty: false,
        accountsDirty: false,
        adminRefreshInFlight: false,
        adminSummary: null,
        adminStats: null,
        compatibility: null,
        authenticated: false,
        interactionLimit: 10,
        interactionAppFilter: '',
        modelCatalog: [],
        projectQuota: null,
        projectQuotaRefreshInFlight: false,
        username: '',
        publicSummary: null,
        publicRefreshInFlight: false,
      };
      const PUBLIC_REFRESH_MS = 5000;
      const PROJECT_QUOTA_REFRESH_MS = 30000;

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
      const publicRpdCopy = document.getElementById('public-rpd-copy');
      const publicRpdTable = document.getElementById('public-rpd-table');
      const publicRpdAccountTable = document.getElementById('public-rpd-account-table');
      const ollamaLocalSection = document.getElementById('ollama-local-section');
      const ollamaLocalTable = document.getElementById('ollama-local-table');
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
      const statsGrid = document.getElementById('stats-grid');
      const compatibilityForm = document.getElementById('compatibility-form');
      const compatibilityStatus = document.getElementById('compatibility-status');
      const compatibilityOutput = document.getElementById('compatibility-output');
      const promptForm = document.getElementById('prompt-form');
      const promptApp = document.getElementById('prompt-app');
      const promptModel = document.getElementById('prompt-model');
      const promptStatus = document.getElementById('prompt-status');
      const promptResponse = document.getElementById('prompt-response');
      const promptImageOutput = document.getElementById('prompt-image-output');
      const imageLightbox = document.getElementById('image-lightbox');
      const imageLightboxMedia = document.getElementById('image-lightbox-media');
      const appKeyModal = document.getElementById('app-key-modal');
      const appKeyModalCard = document.getElementById('app-key-modal-card');
      const appKeyModalTitle = document.getElementById('app-key-modal-title');
      const appKeyModalInput = document.getElementById('app-key-modal-input');
      const appKeyModalStatus = document.getElementById('app-key-modal-status');
      const appKeyModalCopyButton = document.getElementById('app-key-modal-copy');
      const appKeyModalCloseButton = document.getElementById('app-key-modal-close');
      const appForm = document.getElementById('app-form');
      const appStatus = document.getElementById('app-status');
      const appReset = document.getElementById('app-reset');
      const appsTable = document.getElementById('apps-table');
      const interactionsTable = document.getElementById('interactions-table');
      const interactionsLimitSelect = document.getElementById('interactions-limit-select');
      const interactionsAppFilter = document.getElementById('interactions-app-filter');
      const allowedModelsPicker = document.getElementById('allowed-models-picker');
      const allowedModelsOptions = document.getElementById('allowed-models-options');
      const allowedModelsSummary = document.getElementById('allowed-models-summary');

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

      function htmlToText(value) {
        return String(value || '')
          .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
          .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/\\s+/g, ' ')
          .trim();
      }

      function summarizeHtmlError(html, statusCode) {
        const text = htmlToText(html);
        if (statusCode === 504 || /gateway time-?out|error code 504/i.test(text)) {
          return 'Gateway timeout while waiting for the router response. Retry or use a faster image model.';
        }
        if (/cloudflare/i.test(text)) {
          return 'Cloudflare returned an error page while waiting for the router response.';
        }
        return 'The server returned an HTML error page instead of JSON' + (statusCode ? ' (HTTP ' + statusCode + ')' : '') + '.';
      }

      function normalizeRequestError(response, body) {
        if (body && typeof body === 'object' && body.error && body.error.message) {
          return String(body.error.message);
        }
        if (typeof body === 'string') {
          const trimmed = body.trim();
          if (!trimmed) {
            return 'Request failed with HTTP ' + response.status + '.';
          }
          if (response.status === 504 || /gateway time-?out|error code:\s*504/i.test(trimmed)) {
            return 'Gateway timeout while waiting for the router response. Retry or use a faster image model.';
          }
          if (/<(!doctype|html)\\b/i.test(trimmed)) {
            return summarizeHtmlError(trimmed, response.status);
          }
          return trimmed.length > 320 ? trimmed.slice(0, 317) + '…' : trimmed;
        }
        return 'Request failed with HTTP ' + response.status + '.';
      }

      function imageFileExtension(mimeType) {
        const normalized = String(mimeType || '').trim().toLowerCase();
        if (normalized === 'image/jpeg') return 'jpg';
        if (normalized === 'image/svg+xml') return 'svg';
        if (!normalized.startsWith('image/')) return 'png';
        const rawExtension = normalized.slice('image/'.length);
        const cleaned = rawExtension.replace(/[^a-z0-9]+/gi, '');
        return cleaned || 'png';
      }

      function syncBodyScrollLock() {
        const hasImageLightbox = imageLightbox && !imageLightbox.classList.contains('hidden');
        const hasKeyModal = appKeyModal && !appKeyModal.classList.contains('hidden');
        document.body.style.overflow = (hasImageLightbox || hasKeyModal) ? 'hidden' : '';
      }

      function closeImageLightbox() {
        if (!imageLightbox || !imageLightboxMedia) return;
        imageLightbox.classList.add('hidden');
        imageLightbox.setAttribute('aria-hidden', 'true');
        imageLightboxMedia.setAttribute('src', '');
        syncBodyScrollLock();
      }

      function toggleImageLightbox(src, alt) {
        if (!imageLightbox || !imageLightboxMedia || !src) return;
        const isOpen = !imageLightbox.classList.contains('hidden');
        const isSameImage = imageLightboxMedia.getAttribute('src') === src;
        if (isOpen && isSameImage) {
          closeImageLightbox();
          return;
        }
        imageLightboxMedia.setAttribute('src', src);
        imageLightboxMedia.setAttribute('alt', alt || 'Expanded generated image');
        imageLightbox.classList.remove('hidden');
        imageLightbox.setAttribute('aria-hidden', 'false');
        syncBodyScrollLock();
      }

      function closeAppKeyModal() {
        if (!appKeyModal || !appKeyModalInput || !appKeyModalStatus) return;
        appKeyModal.classList.add('hidden');
        appKeyModal.setAttribute('aria-hidden', 'true');
        appKeyModalInput.value = '';
        appKeyModalStatus.textContent = '';
        syncBodyScrollLock();
      }

      function openAppKeyModal(title, apiKey) {
        if (!appKeyModal || !appKeyModalTitle || !appKeyModalInput || !appKeyModalStatus) return;
        appKeyModalTitle.textContent = title || 'API key ready';
        appKeyModalInput.value = String(apiKey || '');
        appKeyModalStatus.textContent = '';
        appKeyModal.classList.remove('hidden');
        appKeyModal.setAttribute('aria-hidden', 'false');
        syncBodyScrollLock();
        appKeyModalInput.focus();
        appKeyModalInput.select();
      }

      async function copyAppKeyFromModal() {
        if (!appKeyModalInput || !appKeyModalStatus) return;
        const value = String(appKeyModalInput.value || '').trim();
        if (!value) return;
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
          } else {
            appKeyModalInput.focus();
            appKeyModalInput.select();
            document.execCommand('copy');
          }
          appKeyModalStatus.textContent = 'API key copied.';
        } catch {
          appKeyModalInput.focus();
          appKeyModalInput.select();
          appKeyModalStatus.textContent = 'Copy failed. Copy it manually now.';
        }
      }

      function describeRouteFamily(label) {
        switch (String(label || '')) {
          case 'chat':
            return { title: 'GemRouter / OpenAI chat', detail: 'Traffic hitting /chat/completions style compatibility routes' };
          case 'images':
            return { title: 'GemRouter / OpenAI images', detail: 'Traffic hitting /images/generations style compatibility routes' };
          case 'responses':
            return { title: 'OpenAI responses', detail: 'Traffic hitting the OpenAI-style /responses endpoint' };
          case 'ollama_chat':
            return { title: 'Ollama chat', detail: 'Traffic hitting Ollama-compatible /api/chat requests' };
          case 'ollama_generate':
            return { title: 'Ollama generate', detail: 'Traffic hitting Ollama-compatible /api/generate requests' };
          case 'models':
            return { title: 'Model discovery', detail: 'Traffic hitting model list, tags, show, or discovery endpoints' };
          default:
            return { title: 'Other compatibility routes', detail: 'Traffic outside the main chat, image, Ollama, and model-discovery families' };
        }
      }

      Array.from(document.querySelectorAll('.compact-textarea')).forEach(function(textarea) {
        autosizeTextarea(textarea);
        textarea.addEventListener('input', function() {
          autosizeTextarea(textarea);
        });
      });

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
          throw new Error(normalizeRequestError(response, body));
        }
        if (typeof body === 'string' && /<(!doctype|html)\\b/i.test(body.trim())) {
          throw new Error(summarizeHtmlError(body, response.status));
        }
        return body;
      }

      // ---- Gemini account manager (admin) ----
      const accountsTable = document.getElementById('accounts-table');
      const accountsStatus = document.getElementById('accounts-status');
      const accountAddForm = document.getElementById('account-add-form');
      const accountModelsSelect = document.getElementById('account-models-select');
      const accountModelsBtn = document.getElementById('account-models-btn');
      const accountModelsOutput = document.getElementById('account-models-output');

      function setAccountsStatus(message, isError) {
        if (!accountsStatus) return;
        accountsStatus.textContent = message || '';
        accountsStatus.style.color = isError ? 'var(--bad)' : 'var(--muted)';
      }

      function renderAccounts(accounts) {
        if (!accountsTable) return;
        // Fresh authoritative data (initial load or post-mutation): edits are settled.
        state.accountsDirty = false;
        const list = Array.isArray(accounts) ? accounts : [];
        accountsTable.innerHTML = list.map(function(account) {
          const id = escapeHtml(String(account.id || ''));
          return '<tr>' +
            '<td data-label="Account"><strong>' + id + '</strong>' + (account.owner ? '<div class="footer-note">' + escapeHtml(String(account.owner)) + '</div>' : '') + '</td>' +
            '<td data-label="Quota group">' + escapeHtml(String(account.quotaGroup || '')) + '</td>' +
            '<td data-label="Priority"><input class="input account-priority" data-account="' + id + '" type="number" value="' + escapeHtml(String(account.priority)) + '" style="width:84px" /></td>' +
            '<td data-label="Enabled"><input type="checkbox" class="account-enabled" data-account="' + id + '"' + (account.enabled ? ' checked' : '') + ' /></td>' +
            '<td data-label="Key"><code>' + escapeHtml(String(account.keyPreview || '')) + '</code></td>' +
            '<td data-label="Actions"><button type="button" class="secondary account-save" data-account="' + id + '">Save</button> <button type="button" class="secondary account-remove" data-account="' + id + '">Remove</button></td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="6" class="muted">No Gemini accounts configured.</td></tr>';

        if (accountModelsSelect) {
          const previous = accountModelsSelect.value;
          accountModelsSelect.innerHTML = list.map(function(account) {
            return '<option value="' + escapeHtml(String(account.id)) + '">' + escapeHtml(String(account.id)) + (account.owner ? ' (' + escapeHtml(String(account.owner)) + ')' : '') + '</option>';
          }).join('');
          if (previous) accountModelsSelect.value = previous;
        }
      }

      async function loadAccounts() {
        if (!accountsTable) return;
        // Don't clobber in-progress priority/enable edits during a background refresh.
        if (state.accountsDirty) return;
        try {
          const data = await request('/admin/provider/gemini-api/accounts');
          renderAccounts(data.accounts);
        } catch (error) {
          setAccountsStatus(error.message || 'Failed to load accounts.', true);
        }
      }

      if (accountsTable) {
        // Editing a priority/enabled field marks the table dirty so refreshes leave it alone.
        accountsTable.addEventListener('input', function() { state.accountsDirty = true; });
        accountsTable.addEventListener('click', async function(event) {
          const saveBtn = event.target.closest('.account-save');
          const removeBtn = event.target.closest('.account-remove');
          if (saveBtn) {
            const id = saveBtn.getAttribute('data-account');
            const priorityInput = accountsTable.querySelector('.account-priority[data-account="' + id + '"]');
            const enabledInput = accountsTable.querySelector('.account-enabled[data-account="' + id + '"]');
            try {
              const data = await request('/admin/provider/gemini-api/accounts/update', {
                method: 'POST',
                body: JSON.stringify({ id: id, priority: Number(priorityInput.value), enabled: enabledInput.checked }),
              });
              renderAccounts(data.accounts);
              setAccountsStatus('Saved ' + id + '. Routing reloaded live.', false);
            } catch (error) {
              setAccountsStatus(error.message || 'Save failed.', true);
            }
          } else if (removeBtn) {
            const id = removeBtn.getAttribute('data-account');
            if (!window.confirm('Remove account ' + id + '? This deletes its key from the pool.')) return;
            try {
              const data = await request('/admin/provider/gemini-api/accounts/remove', {
                method: 'POST',
                body: JSON.stringify({ id: id }),
              });
              renderAccounts(data.accounts);
              setAccountsStatus('Removed ' + id + '.', false);
            } catch (error) {
              setAccountsStatus(error.message || 'Remove failed.', true);
            }
          }
        });
      }

      if (accountAddForm) {
        accountAddForm.addEventListener('submit', async function(event) {
          event.preventDefault();
          const keyInput = document.getElementById('account-add-key');
          const ownerInput = document.getElementById('account-add-owner');
          const groupInput = document.getElementById('account-add-group');
          const priorityInput = document.getElementById('account-add-priority');
          const payload = { key: keyInput.value.trim() };
          if (ownerInput.value.trim()) payload.owner = ownerInput.value.trim();
          if (groupInput.value.trim()) payload.quotaGroup = groupInput.value.trim();
          if (priorityInput.value.trim()) payload.priority = Number(priorityInput.value);
          try {
            const data = await request('/admin/provider/gemini-api/accounts/add', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
            renderAccounts(data.accounts);
            accountAddForm.reset();
            setAccountsStatus('Added ' + data.added + '. Routing reloaded live.', false);
          } catch (error) {
            setAccountsStatus(error.message || 'Add failed.', true);
          }
        });
      }

      if (accountModelsBtn) {
        accountModelsBtn.addEventListener('click', async function() {
          const accountId = accountModelsSelect ? accountModelsSelect.value : '';
          if (!accountId) return;
          accountModelsOutput.textContent = 'Fetching ' + accountId + '…';
          try {
            const data = await request('/admin/provider/gemini-api/accounts/list-models', {
              method: 'POST',
              body: JSON.stringify({ accountId: accountId }),
            });
            if (!data.ok) {
              accountModelsOutput.textContent = 'Error: ' + (data.error || data.status || 'unknown');
              return;
            }
            const lines = (data.models || []).map(function(model) {
              const lim = model.limit ? ('  rpm=' + model.limit.rpm + ' tpm=' + model.limit.tpm + ' rpd=' + model.limit.rpd) : '  (no configured limit)';
              return model.id + lim;
            });
            accountModelsOutput.textContent = lines.join('\\n') || 'No chat models returned.';
          } catch (error) {
            accountModelsOutput.textContent = 'Error: ' + (error.message || 'request failed');
          }
        });
      }

      // ---- Outbound proxy management (admin) ----
      const proxyForm = document.getElementById('proxy-form');
      const proxyEnabled = document.getElementById('proxy-enabled');
      const proxyStrategy = document.getElementById('proxy-strategy');
      const proxyUrls = document.getElementById('proxy-urls');
      const proxyBypass = document.getElementById('proxy-bypass');
      const proxyStatus = document.getElementById('proxy-status');

      async function loadProxyConfig() {
        if (!proxyForm) return;
        if (state.proxyDirty) return;
        try {
          const data = await request('/admin/provider/proxy');
          proxyEnabled.checked = data.enabled === true;
          proxyStrategy.value = data.strategy === 'random' ? 'random' : 'round-robin';
          proxyUrls.value = (data.urls || []).join('\\n');
          proxyBypass.value = (data.bypassHosts || []).join('\\n');
        } catch (error) {
          if (proxyStatus) proxyStatus.textContent = error.message || 'Failed to load proxy config.';
        }
      }

      if (proxyForm) {
        // Editing any field marks the form dirty so background refreshes don't overwrite it.
        proxyForm.addEventListener('input', function() { state.proxyDirty = true; });
        proxyForm.addEventListener('submit', async function(event) {
          event.preventDefault();
          const splitLines = function(value) { return String(value || '').split('\\n').map(function(line) { return line.trim(); }).filter(Boolean); };
          try {
            const data = await request('/admin/provider/proxy', {
              method: 'POST',
              body: JSON.stringify({
                enabled: proxyEnabled.checked,
                strategy: proxyStrategy.value,
                urls: splitLines(proxyUrls.value),
                bypassHosts: splitLines(proxyBypass.value),
              }),
            });
            state.proxyDirty = false;
            proxyUrls.value = (data.urls || []).join('\\n');
            if (proxyStatus) { proxyStatus.style.color = 'var(--muted)'; proxyStatus.textContent = 'Proxy config saved' + (data.enabled ? ' (enabled)' : ' (disabled)') + '.'; }
          } catch (error) {
            if (proxyStatus) { proxyStatus.style.color = 'var(--bad)'; proxyStatus.textContent = error.message || 'Save failed.'; }
          }
        });
      }

      // ---- Routed-models editor (admin) ----
      const modelsEnabledBox = document.getElementById('models-enabled');
      const modelsAvailableBox = document.getElementById('models-available');
      const modelsConfigSave = document.getElementById('models-config-save');
      const modelsConfigStatus = document.getElementById('models-config-status');
      let modelsEnabledOrder = [];
      let modelsAvailableList = [];

      function renderModelsConfig() {
        if (!modelsEnabledBox) return;
        modelsEnabledBox.innerHTML = modelsEnabledOrder.map(function(id, index) {
          return '<div class="model-picker-option"><div><span class="model-picker-title">' + (index + 1) + '. ' + escapeHtml(id) + '</span></div>' +
            '<div>' +
            '<button type="button" class="secondary" data-mc-up="' + escapeHtml(id) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button> ' +
            '<button type="button" class="secondary" data-mc-down="' + escapeHtml(id) + '"' + (index === modelsEnabledOrder.length - 1 ? ' disabled' : '') + '>↓</button> ' +
            '<button type="button" class="secondary" data-mc-remove="' + escapeHtml(id) + '">✕</button>' +
            '</div></div>';
        }).join('') || '<div class="footer-note" style="padding:10px">No models enabled.</div>';
        modelsAvailableBox.innerHTML = modelsAvailableList.map(function(id) {
          return '<div class="model-picker-option"><div><span class="model-picker-title">' + escapeHtml(id) + '</span></div>' +
            '<button type="button" class="secondary" data-mc-add="' + escapeHtml(id) + '">+ add</button></div>';
        }).join('') || '<div class="footer-note" style="padding:10px">All known models are enabled.</div>';
      }

      async function loadModelsConfig() {
        if (!modelsEnabledBox) return;
        // Don't reset an in-progress reorder/selection during a background refresh.
        if (state.modelsConfigDirty) return;
        try {
          const data = await request('/admin/provider/models-config');
          modelsEnabledOrder = Array.isArray(data.enabled) ? data.enabled.slice() : [];
          modelsAvailableList = Array.isArray(data.available) ? data.available.slice() : [];
          renderModelsConfig();
        } catch (error) {
          if (modelsConfigStatus) modelsConfigStatus.textContent = error.message || 'Failed to load model config.';
        }
      }

      if (modelsEnabledBox) {
        function move(id, delta) {
          const i = modelsEnabledOrder.indexOf(id);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= modelsEnabledOrder.length) return;
          const tmp = modelsEnabledOrder[i]; modelsEnabledOrder[i] = modelsEnabledOrder[j]; modelsEnabledOrder[j] = tmp;
          state.modelsConfigDirty = true;
          renderModelsConfig();
        }
        modelsEnabledBox.addEventListener('click', function(event) {
          const up = event.target.closest('[data-mc-up]');
          const down = event.target.closest('[data-mc-down]');
          const rem = event.target.closest('[data-mc-remove]');
          if (up) move(up.getAttribute('data-mc-up'), -1);
          else if (down) move(down.getAttribute('data-mc-down'), 1);
          else if (rem) {
            const id = rem.getAttribute('data-mc-remove');
            modelsEnabledOrder = modelsEnabledOrder.filter(function(m) { return m !== id; });
            if (modelsAvailableList.indexOf(id) < 0) modelsAvailableList.push(id);
            state.modelsConfigDirty = true;
            renderModelsConfig();
          }
        });
        modelsAvailableBox.addEventListener('click', function(event) {
          const add = event.target.closest('[data-mc-add]');
          if (!add) return;
          const id = add.getAttribute('data-mc-add');
          if (modelsEnabledOrder.indexOf(id) < 0) modelsEnabledOrder.push(id);
          modelsAvailableList = modelsAvailableList.filter(function(m) { return m !== id; });
          state.modelsConfigDirty = true;
          renderModelsConfig();
        });
        modelsConfigSave.addEventListener('click', async function() {
          try {
            await request('/admin/provider/models-config', { method: 'POST', body: JSON.stringify({ textModels: modelsEnabledOrder }) });
            state.modelsConfigDirty = false;
            if (modelsConfigStatus) { modelsConfigStatus.style.color = 'var(--muted)'; modelsConfigStatus.textContent = 'Saved. Routing order applied live.'; }
          } catch (error) {
            if (modelsConfigStatus) { modelsConfigStatus.style.color = 'var(--bad)'; modelsConfigStatus.textContent = error.message || 'Save failed.'; }
          }
        });
      }

      function setSectionExpanded(button, expanded) {
        const bodyId = button && typeof button.getAttribute === 'function' ? button.getAttribute('aria-controls') : '';
        const body = bodyId ? document.getElementById(bodyId) : null;
        if (!body) return;
        body.classList.toggle('hidden', !expanded);
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const label = button.querySelector('.section-toggle-label');
        if (label) {
          label.textContent = expanded ? 'Collapse' : 'Expand';
        }
      }

      Array.from(document.querySelectorAll('[data-section-toggle]')).forEach(function(button) {
        const bodyId = button.getAttribute('aria-controls');
        const body = bodyId ? document.getElementById(bodyId) : null;
        setSectionExpanded(button, body ? !body.classList.contains('hidden') : false);
        button.addEventListener('click', function() {
          setSectionExpanded(button, button.getAttribute('aria-expanded') !== 'true');
        });
      });

      // Delegated handler: expand/collapse the idle (untouched) quota rows in any RPD table.
      document.addEventListener('click', function(event) {
        const button = event.target.closest ? event.target.closest('[data-rpd-toggle]') : null;
        if (!button) return;
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        const toggleRow = button.closest('tr');
        const tbody = button.closest('tbody');
        if (tbody && tbody.id) expandedRpdTables[tbody.id] = !expanded;
        let sibling = toggleRow ? toggleRow.nextElementSibling : null;
        while (sibling && sibling.classList.contains('rpd-idle')) {
          sibling.classList.toggle('hidden', expanded);
          sibling = sibling.nextElementSibling;
        }
        const count = button.textContent.replace(/[^0-9]/g, '');
        button.innerHTML = '<span class="rpd-toggle-arrow">&#9656;</span> ' +
          (expanded ? 'Show ' : 'Hide ') + count + ' idle model' + (count === '1' ? '' : 's');
      });

      function autosizeTextarea(textarea) {
        if (!textarea || !textarea.classList || !textarea.classList.contains('compact-textarea')) return;
        const minHeight = Math.max(46, Number(textarea.dataset.minHeight || 46) || 46);
        textarea.style.height = minHeight + 'px';
        const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, 180));
        textarea.style.height = nextHeight + 'px';
      }

      function normalizeMarkdownInline(value) {
        return value
          .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
          .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
          .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      }

      function renderMarkdown(markdown) {
        const source = String(markdown || '').trim();
        if (!source) return '<div class="muted">No text response returned.</div>';
        const escaped = escapeHtml(source).replace(/\\r\\n/g, '\\n');
        const blocks = [];
        const lines = escaped.split('\\n');
        let paragraph = [];
        let listType = '';
        let listItems = [];
        let inCodeBlock = false;
        let codeLines = [];

        function flushParagraph() {
          if (paragraph.length === 0) return;
          blocks.push('<p>' + normalizeMarkdownInline(paragraph.join(' ')) + '</p>');
          paragraph = [];
        }

        function flushList() {
          if (!listType || listItems.length === 0) return;
          blocks.push('<' + listType + '>' + listItems.map(function(item) {
            return '<li>' + normalizeMarkdownInline(item) + '</li>';
          }).join('') + '</' + listType + '>');
          listType = '';
          listItems = [];
        }

        function flushCodeBlock() {
          if (!inCodeBlock) return;
          blocks.push('<pre><code>' + codeLines.join('\\n') + '</code></pre>');
          inCodeBlock = false;
          codeLines = [];
        }

        lines.forEach(function(line) {
          if (line.trim().startsWith('\`\`\`')) {
            flushParagraph();
            flushList();
            if (inCodeBlock) {
              flushCodeBlock();
            } else {
              inCodeBlock = true;
              codeLines = [];
            }
            return;
          }

          if (inCodeBlock) {
            codeLines.push(line);
            return;
          }

          if (!line.trim()) {
            flushParagraph();
            flushList();
            return;
          }

          const heading = line.match(/^(#{1,3})\\s+(.+)$/);
          if (heading) {
            flushParagraph();
            flushList();
            const level = String(heading[1]).length;
            blocks.push('<h' + level + '>' + normalizeMarkdownInline(heading[2]) + '</h' + level + '>');
            return;
          }

          const quote = line.match(/^&gt;\\s?(.*)$/);
          if (quote) {
            flushParagraph();
            flushList();
            blocks.push('<blockquote>' + normalizeMarkdownInline(quote[1]) + '</blockquote>');
            return;
          }

          const unordered = line.match(/^[-*]\\s+(.+)$/);
          if (unordered) {
            flushParagraph();
            if (listType && listType !== 'ul') flushList();
            listType = 'ul';
            listItems.push(unordered[1]);
            return;
          }

          const ordered = line.match(/^\\d+\\.\\s+(.+)$/);
          if (ordered) {
            flushParagraph();
            if (listType && listType !== 'ol') flushList();
            listType = 'ol';
            listItems.push(ordered[1]);
            return;
          }

          flushList();
          paragraph.push(line);
        });

        flushParagraph();
        flushList();
        flushCodeBlock();
        return blocks.join('') || '<div class="muted">No text response returned.</div>';
      }

      function renderPromptImages(images) {
        if (!Array.isArray(images) || images.length === 0) {
          promptImageOutput.innerHTML = '<div class="muted">No generated image yet.</div>';
          return;
        }
        promptImageOutput.innerHTML = '<div class="image-preview-grid">' + images.map(function(image, index) {
          const mimeType = typeof image.mimeType === 'string' && image.mimeType.trim() ? image.mimeType.trim() : 'image/png';
          const data = typeof image.data === 'string' ? image.data.trim() : '';
          const src = 'data:' + mimeType + ';base64,' + data;
          const extension = imageFileExtension(mimeType);
          return '<div class="image-preview-card">' +
            '<img class="prompt-preview-image" src="' + src + '" data-image-src="' + src + '" alt="Generated image ' + escapeHtml(String(index + 1)) + '" />' +
            '<div class="image-preview-meta">' +
              '<div class="footer-note mono">' + escapeHtml(mimeType) + '</div>' +
              '<a class="image-download-link" href="' + src + '" download="gemrouter-image-' + escapeHtml(String(index + 1)) + '.' + escapeHtml(extension) + '">Download</a>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }

      function setAdminVisible(enabled) {
        adminDashboard.classList.toggle('hidden', !enabled);
      }

      function renderPublicPills(summary) {
        const pills = [];
        const runtime = summary.runtime || {};
        if (runtime.lastBackendUsed) {
          pills.push('<span class="chip">Last backend ' + escapeHtml(runtime.lastBackendUsed) + '</span>');
        }
        publicRuntimePills.innerHTML = pills.join('');
      }

      function renderPublicStats(summary) {
        const stats = summary.stats || {};
        const completeWindow = stats.windowComplete === true;
        const windowLabel = completeWindow ? '24h' : 'tracking';
        const requestDetail = completeWindow
          ? 'Successful and failed requests'
          : 'Precise telemetry started ' + formatTimestamp(stats.windowStartedAt);
        if (activityLabel) {
          activityLabel.textContent = fmtNumber(stats.requests) + ' req / ' + windowLabel + ' · ' + escapeHtml(String(stats.successRatePct || 0)) + '% ok';
        }
        const speed = Math.max(4.4, Math.min(9.4, 9.4 - Math.log10((stats.requests || 0) + 1) * 1.15));
        root.style.setProperty('--heartbeat-speed', speed.toFixed(2) + 's');
        publicStats.innerHTML = [
          ['Requests (' + windowLabel + ')', fmtNumber(stats.requests), requestDetail],
          ['Success Rate', escapeHtml(String(stats.successRatePct || 0)) + '%', 'Calculated from logged requests'],
          ['Avg Latency', fmtNumber(stats.avgLatencyMs) + ' ms', 'Router-side average'],
          ['Token Volume', fmtNumber(stats.totalTokens), 'Prompt and completion tokens'],
        ].map(function(entry) {
          return '<div class="card"><div class="label">' + escapeHtml(entry[0]) + '</div><div class="metric">' + entry[1] + '</div><div class="metric-sub">' + escapeHtml(entry[2]) + '</div></div>';
        }).join('');
      }

      // Strongest -> weakest. Anything not listed sorts after, alphabetically.
      const MODEL_POWER_ORDER = [
        'gemini-3.5-flash',
        'gemini-3-flash-preview',
        'gemini-3-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.1-flash-lite-preview',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it',
      ];
      function modelPowerRank(id) {
        const index = MODEL_POWER_ORDER.indexOf(String(id || '').toLowerCase());
        return index === -1 ? MODEL_POWER_ORDER.length : index;
      }
      function byModelPower(left, right) {
        const delta = modelPowerRank(left.model) - modelPowerRank(right.model);
        return delta !== 0 ? delta : String(left.model).localeCompare(String(right.model));
      }
      function quotaMeterCell(used, limit) {
        const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
        const meterClass = percent >= 100 ? 'bad' : percent > 75 ? 'warn' : 'good';
        return '<td data-label=""><div class="quota-meter ' + meterClass + '" title="' + escapeHtml(String(percent)) + '% used"><span style="width:' + escapeHtml(String(percent)) + '%"></span></div></td>';
      }
      // Tables (by tbody id) whose idle rows the operator has expanded. Persisted across the
      // 5s refresh re-renders so the section does not snap shut on every tick.
      const expandedRpdTables = {};
      // Render consumed rows first; collapse the idle (untouched) ones behind a toggle.
      function renderRpdRows(tableEl, rows, idleColspan) {
        const consumed = rows.filter(function(r) { return r.html.used > 0; }).map(function(r) { return r.row; });
        const idle = rows.filter(function(r) { return r.html.used <= 0; }).map(function(r) { return r.row; });
        const expanded = expandedRpdTables[tableEl.id] === true;
        let out = consumed.join('');
        if (idle.length > 0) {
          out += '<tr class="rpd-toggle-row"><td colspan="' + idleColspan + '">' +
            '<button type="button" class="secondary rpd-toggle" data-rpd-toggle aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
            '<span class="rpd-toggle-arrow">&#9656;</span> ' + (expanded ? 'Hide ' : 'Show ') + idle.length + ' idle model' + (idle.length === 1 ? '' : 's') +
            '</button></td></tr>';
          out += idle.map(function(row) { return row.replace('<tr>', '<tr class="rpd-idle' + (expanded ? '' : ' hidden') + '">'); }).join('');
        }
        tableEl.innerHTML = consumed.length + idle.length > 0
          ? out
          : '<tr><td colspan="' + idleColspan + '" class="muted">No Gemini RPD limits are configured.</td></tr>';
      }

      function renderPublicRpd(summary) {
        if (!publicRpdTable || !publicRpdCopy) return;
        const quota = summary && summary.provider && summary.provider.quota ? summary.provider.quota : {};
        const apiKeys = Array.isArray(quota.apiKeys) ? quota.apiKeys : [];
        const accountLabelsByGroup = new Map();
        apiKeys.forEach(function(key) {
          const group = typeof key.quotaGroup === 'string' && key.quotaGroup.trim() ? key.quotaGroup.trim() : '';
          const account = typeof key.id === 'string' && key.id.trim() ? key.id.trim() : '';
          if (!group || !account) return;
          const labels = accountLabelsByGroup.get(group) || [];
          if (!labels.includes(account)) labels.push(account);
          accountLabelsByGroup.set(group, labels);
        });

        const resetAt = quota.rpdResetAt ? formatTimestamp(quota.rpdResetAt) : 'the next Pacific midnight';
        publicRpdCopy.textContent = 'Cumulative daily request capacity from the same ledger used by routing. RPD resets at ' + resetAt + '.';

        const byModel = new Map();
        const perAccount = [];
        const groups = Array.isArray(quota.quotaGroups) ? quota.quotaGroups : [];
        groups.forEach(function(group) {
          const groupId = typeof group.id === 'string' && group.id.trim() ? group.id.trim() : 'account';
          const accounts = accountLabelsByGroup.get(groupId);
          const accountLabels = accounts && accounts.length > 0 ? accounts : [groupId];
          const models = Array.isArray(group.models) ? group.models : [];
          models.forEach(function(model) {
            const modelId = String(model && model.model || '').trim();
            if (!modelId) return;
            const rpd = model && model.rpd ? model.rpd : null;
            if (!rpd || rpd.limit === null || rpd.limit === undefined) return;
            const used = typeof rpd.used === 'number' ? rpd.used : 0;
            const limit = typeof rpd.limit === 'number' ? rpd.limit : null;
            if (limit === null) return;
            const entry = byModel.get(modelId) || {
              model: modelId, accounts: new Set(), used: 0, limit: 0, remaining: 0,
            };
            accountLabels.forEach(function(label) { entry.accounts.add(label); });
            entry.used += used;
            entry.limit += limit;
            entry.remaining += Math.max(0, limit - used);
            byModel.set(modelId, entry);
            accountLabels.forEach(function(label) {
              perAccount.push({ account: label, model: modelId, used: used, limit: limit, remaining: Math.max(0, limit - used) });
            });
          });
        });

        const modelRows = Array.from(byModel.values())
          .sort(byModelPower)
          .map(function(entry) {
            const accountCount = entry.accounts.size;
            const accountLabel = accountCount + ' ' + (accountCount === 1 ? 'account' : 'accounts');
            return {
              html: { used: entry.used },
              row: '<tr>' +
                '<td data-label="Model"><strong>' + escapeHtml(entry.model) + '</strong></td>' +
                '<td data-label="Accounts">' + escapeHtml(accountLabel) + '</td>' +
                '<td data-label="RPD left"><strong>' + escapeHtml(fmtNumber(entry.remaining)) + '</strong></td>' +
                '<td data-label="Used / limit">' + escapeHtml(fmtNumber(entry.used)) + ' / ' + escapeHtml(fmtNumber(entry.limit)) + '</td>' +
                quotaMeterCell(entry.used, entry.limit) +
              '</tr>',
            };
          });
        renderRpdRows(publicRpdTable, modelRows, 5);

        if (publicRpdAccountTable) {
          const accountRows = perAccount
            .sort(function(left, right) {
              const accountDelta = String(left.account).localeCompare(String(right.account));
              return accountDelta !== 0 ? accountDelta : byModelPower(left, right);
            })
            .map(function(entry) {
              return {
                html: { used: entry.used },
                row: '<tr>' +
                  '<td data-label="Account"><strong>' + escapeHtml(entry.account) + '</strong></td>' +
                  '<td data-label="Model">' + escapeHtml(entry.model) + '</td>' +
                  '<td data-label="RPD left"><strong>' + escapeHtml(fmtNumber(entry.remaining)) + '</strong></td>' +
                  '<td data-label="Used / limit">' + escapeHtml(fmtNumber(entry.used)) + ' / ' + escapeHtml(fmtNumber(entry.limit)) + '</td>' +
                  quotaMeterCell(entry.used, entry.limit) +
                '</tr>',
              };
            });
          renderRpdRows(publicRpdAccountTable, accountRows, 5);
        }
      }

      function renderOllamaLocalRpd(summary) {
        if (!ollamaLocalSection || !ollamaLocalTable) return;
        const local = summary && summary.ollamaLocal ? summary.ollamaLocal : null;
        const models = local && Array.isArray(local.models) ? local.models : [];
        if (!local || local.enabled !== true || models.length === 0) {
          ollamaLocalSection.style.display = 'none';
          return;
        }
        ollamaLocalSection.style.display = '';
        ollamaLocalTable.innerHTML = models.map(function(model) {
          const id = String(model.model || 'unknown');
          const kind = String(model.kind || 'text');
          const used = typeof model.used === 'number' ? model.used : 0;
          const limit = typeof model.limit === 'number' && model.limit > 0 ? model.limit : null;
          const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
          const meterClass = percent >= 100 ? 'bad' : percent > 75 ? 'warn' : 'good';
          const rpdLabel = limit ? (fmtNumber(used) + ' / ' + fmtNumber(limit)) : (fmtNumber(used) + ' / ∞');
          return '<tr>' +
            '<td data-label="Model"><strong>' + escapeHtml(id) + '</strong></td>' +
            '<td data-label="Type"><span class="chip">' + escapeHtml(kind) + '</span></td>' +
            '<td data-label="RPD">' + escapeHtml(rpdLabel) + '</td>' +
            '<td data-label=""><div class="quota-meter ' + meterClass + '" title="' + escapeHtml(String(percent)) + '% used"><span style="width:' + escapeHtml(String(percent)) + '%"></span></div></td>' +
          '</tr>';
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
        const totalRequests = points.reduce(function(total, item) { return total + (item.requests || 0); }, 0) || 1;
        routeChart.innerHTML = points.map(function(item) {
          const requests = item.requests || 0;
          const width = Math.max(6, Math.round((requests / maxRequests) * 100));
          const routeInfo = describeRouteFamily(item.label);
          const share = Math.round((requests / totalRequests) * 1000) / 10;
          return '<div class="route-item">' +
            '<div class="route-meta"><strong>' + escapeHtml(routeInfo.title) + '</strong><span class="muted">' + escapeHtml(String(requests)) + ' req · ' + escapeHtml(String(share)) + '%</span></div>' +
            '<div class="route-track"><div class="route-fill" style="width:' + width + '%"></div></div>' +
            '<div class="footer-note">' + escapeHtml(routeInfo.detail) + '</div>' +
          '</div>';
        }).join('') || '<div class="muted">No compatibility traffic logged in the latest 240 interactions.</div>';
      }

      function modelId(entry) {
        return entry && typeof entry.id === 'string' ? entry.id.trim() : '';
      }

      function modelDisplayName(entry) {
        const displayName = entry && typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
        return displayName || modelId(entry);
      }

      function modelCapabilities(entry) {
        return entry && entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
      }

      function modelSupportsChat(entry) {
        return modelCapabilities(entry).chat === true;
      }

      function modelSupportsImage(entry) {
        return modelCapabilities(entry).imageGeneration === true;
      }

      function modelSupportsRouter(entry) {
        return modelSupportsChat(entry) || modelSupportsImage(entry);
      }

      function modelCapabilityTags(entry) {
        const capabilities = modelCapabilities(entry);
        return [
          capabilities.chat ? 'chat' : '',
          capabilities.imageGeneration ? 'image' : '',
          capabilities.live ? 'live' : '',
          capabilities.nativeAudio ? 'native-audio' : '',
          capabilities.tts ? 'tts' : '',
          capabilities.embeddings ? 'embeddings' : '',
          capabilities.longRunning ? 'long-running' : '',
        ].filter(Boolean);
      }

      function getModelCatalog() {
        const entries = Array.isArray(state.modelCatalog) ? state.modelCatalog : [];
        if (entries.length > 0) return entries;
        return (bootstrap.modelIds || []).map(function(id) {
          return {
            id: id,
            displayName: id,
            label: id,
            capabilities: {
              chat: true,
              imageGeneration: /image|nano-banana/i.test(String(id)),
            },
          };
        });
      }

      function getAllowedModelSelection() {
        return Array.from(allowedModelsOptions.querySelectorAll('input[name="allowedModels"]:checked'))
          .map(function(input) { return String(input.value || '').trim(); })
          .filter(Boolean);
      }

      function setAllowedModelSelection(models) {
        const selected = new Set((Array.isArray(models) ? models : []).map(function(model) { return String(model || '').trim(); }).filter(Boolean));
        Array.from(allowedModelsOptions.querySelectorAll('input[name="allowedModels"]')).forEach(function(input) {
          if (!input.disabled) {
            input.checked = selected.has(String(input.value || '').trim());
          }
        });
        updateAllowedModelsSummary();
      }

      function updateAllowedModelsSummary() {
        const selected = getAllowedModelSelection();
        const preview = selected.length > 3
          ? selected.slice(0, 3).join(', ') + ', +' + String(selected.length - 3) + ' more'
          : selected.join(', ');
        const summary = allowedModelsPicker ? allowedModelsPicker.querySelector('summary') : null;
        if (summary) {
          summary.textContent = selected.length > 0
            ? ('Select allowed models (' + selected.length + ' selected)')
            : 'Select allowed models';
        }
        allowedModelsSummary.textContent = selected.length > 0
          ? (selected.length + ' selected: ' + preview)
          : 'Empty selection uses the bootstrap defaults.';
      }

      function renderAllowedModelsPicker(modelCatalog, selectedModels) {
        const selected = new Set((Array.isArray(selectedModels) ? selectedModels : []).map(function(model) { return String(model || '').trim(); }).filter(Boolean));
        const sourceEntries = Array.isArray(modelCatalog) && modelCatalog.length > 0 ? modelCatalog : getModelCatalog();
        const entries = sourceEntries
          .slice()
          .sort(function(left, right) {
            const leftCompatible = modelSupportsRouter(left) ? 0 : 1;
            const rightCompatible = modelSupportsRouter(right) ? 0 : 1;
            if (leftCompatible !== rightCompatible) return leftCompatible - rightCompatible;
            return modelId(left).localeCompare(modelId(right));
          });

        allowedModelsOptions.innerHTML = entries.map(function(entry) {
          const id = modelId(entry);
          const compatible = modelSupportsRouter(entry);
          const capabilityTags = modelCapabilityTags(entry);
          const notes = [];
          if (modelDisplayName(entry) && modelDisplayName(entry) !== id) notes.push(modelDisplayName(entry));
          if (capabilityTags.length > 0) notes.push(capabilityTags.join(', '));
          if (!compatible) notes.push('not exposed by the current router');
          return '<label class="model-picker-option' + (compatible ? '' : ' is-disabled') + '">' +
            '<div><input type="checkbox" name="allowedModels" value="' + escapeHtml(id) + '"' + (selected.has(id) ? ' checked' : '') + (compatible ? '' : ' disabled') + ' />' +
              '<span class="model-picker-title">' + escapeHtml(id) + '</span></div>' +
            '<div class="footer-note">' + escapeHtml(notes.join(' · ') || 'Gemini API model') + '</div>' +
          '</label>';
        }).join('') || '<div class="footer-note" style="padding:12px 14px">No Gemini model catalog available yet.</div>';

        updateAllowedModelsSummary();
      }

      function findActiveAppById(appId) {
        return state.apps.find(function(app) {
          return !app.revokedAt && app.id === appId;
        }) || null;
      }

      function fillModelOptions(selectedModel) {
        const app = findActiveAppById(promptApp.value);
        const allowed = new Set(app && Array.isArray(app.allowedModels) ? app.allowedModels : []);
        const options = getModelCatalog().filter(function(entry) {
          const id = modelId(entry);
          return modelSupportsRouter(entry) && id && (allowed.size === 0 || allowed.has(id));
        });
        const nextSelected = typeof selectedModel === 'string' && selectedModel.trim() ? selectedModel.trim() : promptModel.value;
        promptModel.innerHTML = options
          .map(function(entry) {
            const id = modelId(entry);
            const label = modelSupportsImage(entry)
              ? id + ' [image]'
              : id;
            return '<option value="' + escapeHtml(id) + '">' + escapeHtml(label) + '</option>';
          })
          .join('');
        if (options.length === 0) {
          promptModel.innerHTML = '<option value="">No compatible models enabled for this app</option>';
          promptModel.disabled = true;
          return;
        }
        promptModel.disabled = false;
        if (nextSelected && options.some(function(entry) { return modelId(entry) === nextSelected; })) {
          promptModel.value = nextSelected;
        } else {
          promptModel.value = modelId(options[0]);
        }
      }

      function fillAppOptions(apps) {
        const previous = promptApp.value;
        const activeApps = apps.filter(function(app) { return !app.revokedAt; });
        promptApp.innerHTML = activeApps
          .map(function(app) { return '<option value="' + escapeHtml(app.id) + '">' + escapeHtml(app.name) + '</option>'; })
          .join('');
        if (previous && activeApps.some(function(app) { return app.id === previous; })) {
          promptApp.value = previous;
        } else if (activeApps[0]) {
          promptApp.value = activeApps[0].id;
        }
        fillModelOptions();
      }

      function renderRuntimePills(data) {
        if (!runtimePills) return;
        const runtime = data.runtime || {};
        const compatibility = data.compatibility || {};
        const routing = data.routing || {};
        const backends = data.backends || {};
        const geminiApi = backends.geminiApi || {};
        runtimePills.innerHTML = [
          '<span class="chip good">Admin session</span>',
          '<span class="chip">Backend-only</span>',
          '<span class="chip ' + (geminiApi.available ? 'good' : 'warn') + '">' + (geminiApi.available ? 'Gemini API available' : 'Gemini API attention') + '</span>',
          '<span class="chip">Default backend ' + escapeHtml(routing.activeDefaultBackend || routing.configuredDefaultBackend || 'auto') + '</span>',
          '<span class="chip">Last backend ' + escapeHtml(routing.lastBackendUsed || 'n/a') + '</span>',
          '<span class="chip">Primary surface ' + escapeHtml(compatibility.defaultSurface || 'gemrouter') + '</span>',
          '<span class="chip">Apps ' + escapeHtml(String(runtime.apps || 0)) + '</span>',
        ].join('');
      }

      function renderBackendDiagnostics(data) {
        const routing = data.routing || {};
        const backends = data.backends || {};
        const geminiApi = backends.geminiApi || {};
        backendPills.innerHTML = [
          '<span class="chip ' + (geminiApi.available ? 'good' : 'warn') + '">' + (geminiApi.available ? 'Gemini API available' : 'Gemini API attention') + '</span>',
          '<span class="chip">Accounts ' + escapeHtml(String(geminiApi.usableKeyCount || 0)) + '/' + escapeHtml(String(geminiApi.configuredKeyCount || 0)) + '</span>',
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
          '[gemini_api]',
          'enabled=' + String(Boolean(geminiApi.enabled)),
          'available=' + String(Boolean(geminiApi.available)),
          'configured_accounts=' + String(geminiApi.configuredKeyCount || 0),
          'usable_accounts=' + String(geminiApi.usableKeyCount || 0),
          'default_tier=' + String(geminiApi.defaultTier || ''),
          'base_url=' + String(geminiApi.baseUrl || ''),
          'version=' + String(geminiApi.version || ''),
          'last_account=' + String(geminiApi.lastSelectedKeyId || ''),
          'last_quota_group=' + String(geminiApi.lastSelectedQuotaGroup || ''),
          'last_model=' + String(geminiApi.lastResolvedModel || ''),
          'last_error=' + String(geminiApi.lastError || ''),
          'last_failure_at=' + String(geminiApi.lastFailureAt || ''),
          'last_success_at=' + String(geminiApi.lastSuccessAt || ''),
          'last_latency_ms=' + String(geminiApi.lastLatencyMs || ''),
        ].join('\\n');
        backendHint.textContent = geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.message
          ? 'Last upstream error: ' + geminiApi.lastUpstreamError.message
          : 'Fallback stays on the Gemini API key pool; there is no browser or CLI backend.';
      }

      function syncProjectQuotaState(quota) {
        const payload = quota && typeof quota === 'object' ? quota : {};
        state.projectQuota = {
          source: payload.source || 'local-ledger',
          authoritative: payload.authoritative === true,
          monitoringAuthoritative: payload.monitoringAuthoritative === true,
          updatedAt: payload.updatedAt || null,
          lastError: payload.lastError || payload.projectQuotaLastError || null,
          projectQuotas: Array.isArray(payload.projectQuotas) ? payload.projectQuotas : [],
        };
      }

      function resolveProjectQuotaState(quota) {
        if (state.projectQuota && typeof state.projectQuota === 'object') {
          return state.projectQuota;
        }
        return quota && typeof quota === 'object' ? quota : {};
      }

      function lookupAccountIdByProjectId(apiKeys, projectId) {
        const normalizedProjectId = String(projectId || '').trim();
        if (!normalizedProjectId) return 'unknown';
        const match = Array.isArray(apiKeys)
          ? apiKeys.find(function(key) {
            return String(key && key.projectId || '').trim() === normalizedProjectId;
          })
          : null;
        return match && match.id ? String(match.id) : normalizedProjectId;
      }

      function extractProjectQuotaPredictRpm(projectQuota) {
        const metrics = Array.isArray(projectQuota && projectQuota.metrics) ? projectQuota.metrics : [];
        const metric = metrics.find(function(entry) {
          return String(entry && entry.metric || '') === 'generativelanguage.googleapis.com/predict_requests_free_tier_per_model';
        });
        if (!metric || !Array.isArray(metric.limits)) return null;
        for (const limit of metric.limits) {
          const quotaBuckets = Array.isArray(limit && limit.quotaBuckets) ? limit.quotaBuckets : [];
          const bucket = quotaBuckets.find(function(entry) {
            return !entry.dimensions || Object.keys(entry.dimensions).length === 0;
          }) || quotaBuckets[0];
          if (bucket && bucket.effectiveLimit !== undefined && bucket.effectiveLimit !== null) {
            return String(bucket.effectiveLimit);
          }
        }
        return null;
      }

      function renderProviderState(data) {
        const provider = data.provider || {};
        const geminiApi = provider.geminiApi || {};
        const quota = provider.quota || {};
        const models = Array.isArray(provider.models) ? provider.models : [];
        const directModels = models.filter(function(model) { return model && model.kind === 'gemini-api'; });
        const directModelCount = directModels.length || provider.directModelCount || 0;
        providerPills.innerHTML = '';

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
          '[upstream]',
          'status=' + String((geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.status) || ''),
          'code=' + String((geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.code) || ''),
          'google_status=' + String((geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.googleStatus) || ''),
          'google_reason=' + String((geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.googleReason) || ''),
          'message=' + String((geminiApi.lastUpstreamError && geminiApi.lastUpstreamError.message) || ''),
          '',
          '[models]',
          ...(models.length > 0
            ? models.map(function(model) {
              return [
                String(model.id || ''),
                'backend=gemini-api',
                'kind=' + String(model.kind || ''),
                'available=' + String(Boolean(model.available)),
              ].join(' ');
            })
            : ['none']),
        ].join('\\n');
      }

      function quotaMetricUsed(metric) {
        return Boolean(metric && typeof metric.used === 'number' && metric.used > 0);
      }

      function hasQuotaActivity(model) {
        return quotaMetricUsed(model && model.rpm) || quotaMetricUsed(model && model.tpm) || quotaMetricUsed(model && model.rpd);
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
        return date.toLocaleString(undefined, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        });
      }

      function formatRetryAfter(value, source) {
        if (!value) return 'ready';
        if (source === 'retry-after') return 'retry after ' + formatTimestamp(value);
        if (source === 'daily-depleted' || source === 'pacific-reset') return 'daily quota depleted · resets ' + formatTimestamp(value);
        if (source === '429-backoff') return 'rate-limit backoff until ' + formatTimestamp(value);
        if (source === 'high-demand') return 'upstream busy until ' + formatTimestamp(value);
        return 'local counter active';
      }

      function renderHiddenLabel(label) {
        return '<span class="muted">' + escapeHtml(label) + '</span>';
      }

      function renderGeminiApiKeyTable(apiKeys) {
        geminiApiKeysTable.innerHTML = apiKeys.map(function(key) {
          const enabled = key.enabled !== false;
          const accountId = typeof key.id === 'string' && key.id.trim() ? key.id.trim() : '';
          const owner = typeof key.owner === 'string' && key.owner.trim() ? key.owner.trim() : '';
          const quotaGroup = typeof key.quotaGroup === 'string' && key.quotaGroup.trim() ? key.quotaGroup.trim() : '';
          const accountLabel = accountId ? '<strong>' + escapeHtml(accountId) + '</strong>' : renderHiddenLabel('hidden in guest view');
          const accountMeta = owner ? escapeHtml(owner) : 'API key hidden';
          const quotaLabel = quotaGroup ? escapeHtml(quotaGroup) : renderHiddenLabel('hidden in guest view');
          return '<tr>' +
            '<td data-label="Account">' + accountLabel + '<div class="footer-note">' + accountMeta + '</div></td>' +
            '<td data-label="Quota Group">' + quotaLabel + '<div class="footer-note">' + escapeHtml(formatTimestamp(key.lastUsedAt)) + '</div></td>' +
            '<td data-label="Priority">' + escapeHtml(String(key.priority || 0)) + '</td>' +
            '<td data-label="Health"><span class="chip ' + (enabled ? 'good' : 'warn') + '">' + (enabled ? 'enabled' : 'disabled') + '</span></td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="4" class="muted">No Gemini API accounts configured.</td></tr>';
      }

      function lookupEffectiveLimitFromMetrics(serviceUsageMetrics, quotaMetric, model, isAllocation) {
        if (!Array.isArray(serviceUsageMetrics)) return null;
        const metric = serviceUsageMetrics.find(function(m) { return String(m && m.metric || '') === quotaMetric; });
        if (!metric || !Array.isArray(metric.limits)) return null;
        for (var li = 0; li < metric.limits.length; li++) {
          var limit = metric.limits[li];
          if (!Array.isArray(limit.quotaBuckets)) continue;
          var buckets = limit.quotaBuckets;
          var match = null;
          if (model) {
            match = buckets.find(function(b) {
              var dims = b.dimensions || {};
              return String(dims.model || dims.model_id || '').toLowerCase() === String(model).toLowerCase();
            });
          }
          if (!match) match = buckets.find(function(b) { return !b.dimensions || Object.keys(b.dimensions).length === 0; });
          if (!match) match = buckets[0];
          if (match && match.effectiveLimit !== null && match.effectiveLimit !== undefined) {
            return parseInt(String(match.effectiveLimit), 10) || null;
          }
        }
        return null;
      }


      function renderGeminiApiQuotaTable(quotaGroups, supportedModelIds) {
        const rows = [];
        const supported = Array.isArray(supportedModelIds) && supportedModelIds.length > 0
          ? new Set(supportedModelIds)
          : null;
        quotaGroups.forEach(function(group) {
          const models = Array.isArray(group.models)
            ? group.models.filter(function(model) {
              const modelId = typeof model.model === 'string' ? model.model.trim() : '';
              // Skip models with all-zero limits (removed from config but still in ledger)
              const zeroLimits = model.rpm && model.tpm && model.rpd &&
                model.rpm.limit === 0 && model.tpm.limit === 0 && model.rpd.limit === 0;
              if (zeroLimits) return false;
              return (!supported || supported.has(modelId)) && hasQuotaActivity(model);
            })
            : [];
          const groupId = typeof group.id === 'string' && group.id.trim() ? group.id.trim() : '';
          const groupLabel = groupId ? escapeHtml(groupId) : renderHiddenLabel('hidden in guest view');
          models.slice(0, 12).forEach(function(model) {
            const cooldown = formatRetryAfter(model.cooldownUntil, model.cooldownSource);
            // If upstream headers were captured from the Gemini API response, prefer those for RPM/RPD display
            const hasUpstream = model.upstreamRpmLimit !== null || model.upstreamRpdLimit !== null;
            const rpmDisplay = hasUpstream && model.upstreamRpmRemaining !== null
              ? '<span title="From Gemini API response headers (authoritative)">' +
                  escapeHtml(String(model.upstreamRpmRemaining)) + ' left / ' +
                  (model.upstreamRpmLimit !== null ? escapeHtml(String(model.upstreamRpmLimit)) : '-') +
                  ' <span class="chip good" style="font-size:0.7em">upstream</span></span>'
              : formatQuotaMetric(model.rpm);
            const rpdDisplay = hasUpstream && model.upstreamRpdRemaining !== null
              ? '<span title="From Gemini API response headers (authoritative)">' +
                  escapeHtml(String(model.upstreamRpdRemaining)) + ' left / ' +
                  (model.upstreamRpdLimit !== null ? escapeHtml(String(model.upstreamRpdLimit)) : '-') +
                  ' <span class="chip good" style="font-size:0.7em">upstream</span></span>'
              : formatQuotaMetric(model.rpd);
            const headerNote = model.upstreamHeadersAt
              ? '<div class="footer-note">headers at ' + escapeHtml(formatTimestamp(model.upstreamHeadersAt)) + '</div>'
              : (model.upstreamHeadersRaw === null ? '<div class="footer-note muted">no upstream headers yet</div>' : '');
            rows.push('<tr>' +
              '<td data-label="Group">' + groupLabel + '</td>' +
              '<td data-label="Model"><strong>' + escapeHtml(String(model.model || 'unknown')) + '</strong><div class="footer-note">RPD resets at Pacific midnight</div>' + headerNote + '</td>' +
              '<td data-label="RPM">' + rpmDisplay + '</td>' +
              '<td data-label="TPM">' + formatQuotaMetric(model.tpm) + '</td>' +
              '<td data-label="RPD">' + rpdDisplay + '</td>' +
              '<td data-label="State"><span class="chip ' + (model.cooldownUntil ? 'warn' : 'good') + '">' + escapeHtml(cooldown) + '</span></td>' +
            '</tr>');
          });
        });
        geminiApiQuotaTable.innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">No quota activity recorded yet.</td></tr>';
      }

      function renderStats(summary) {
        if (!statsGrid) return;
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
        compatibilityForm.elements.defaultSurface.value = compatibility.defaultSurface || 'gemrouter';
        if (!compatibilityStatus.textContent.trim()) {
          compatibilityStatus.textContent = 'Changes apply automatically when you switch the surface.';
        }

        const gemrouter = endpoints.gemrouter || { enabled: false, routes: {} };
        const openai = endpoints.openai || { enabled: false, routes: {} };
        const deepseek = endpoints.deepseek || { enabled: false, routes: {} };
        const ollama = endpoints.ollama || { enabled: false, routes: {} };
        const ollamaServerUrl = ollama.routes ? (ollama.routes.baseUrl || '') : '';
        const ollamaAuthExample = ollamaServerUrl ? ollamaServerUrl.replace(/^https?:\\/\\//, function(prefix) { return prefix + '<API_KEY>@'; }) : '';

        compatibilityOutput.textContent = [
          'default_surface=' + (compatibility.defaultSurface || 'gemrouter'),
          'enabled_surfaces=' + (compatibility.enabledSurfaces || []).join(','),
          '',
          '[gemrouter]',
          'enabled=' + String(Boolean(gemrouter.enabled)),
          'GEMROUTER_API_URL=' + String(gemrouter.routes && gemrouter.routes.baseUrl || ''),
          'models=' + String(gemrouter.routes && gemrouter.routes.models || ''),
          'chat=' + String(gemrouter.routes && gemrouter.routes.chat || ''),
          'images=' + String(gemrouter.routes && gemrouter.routes.images || ''),
          '',
          '[openai]',
          'enabled=' + String(Boolean(openai.enabled)),
          'OPENAI_API_URL=' + String(openai.routes && openai.routes.baseUrl || ''),
          'models=' + String(openai.routes && openai.routes.models || ''),
          'chat=' + String(openai.routes && openai.routes.chat || ''),
          'images=' + String(openai.routes && openai.routes.images || ''),
          'responses=' + String(openai.routes && openai.routes.responses || ''),
          '',
          '[deepseek]',
          'enabled=' + String(Boolean(deepseek.enabled)),
          'DEEPSEEK_API_URL=' + String(deepseek.routes && deepseek.routes.baseUrl || ''),
          'models=' + String(deepseek.routes && deepseek.routes.models || ''),
          'chat=' + String(deepseek.routes && deepseek.routes.chat || ''),
          'images=' + String(deepseek.routes && deepseek.routes.images || ''),
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
        state.appFormDirty = false;
        appForm.reset();
        appForm.elements.id.value = '';
        setAllowedModelSelection([]);
        if (allowedModelsPicker) {
          allowedModelsPicker.open = false;
        }
        Array.from(appForm.querySelectorAll('.compact-textarea')).forEach(function(textarea) {
          autosizeTextarea(textarea);
        });
        appStatus.textContent = '';
      }

      function populateAppForm(app) {
        appForm.elements.id.value = app.id;
        appForm.elements.name.value = app.name;
        appForm.elements.allowedOrigins.value = app.allowedOrigins.join(', ');
        appForm.elements.sessionNamespace.value = app.sessionNamespace;
        appForm.elements.rateLimitPerMinute.value = app.rateLimitPerMinute;
        appForm.elements.maxConcurrency.value = app.maxConcurrency;
        setAllowedModelSelection(app.allowedModels);
        Array.from(appForm.querySelectorAll('.compact-textarea')).forEach(function(textarea) {
          autosizeTextarea(textarea);
        });
        appStatus.textContent = 'Editing ' + app.name + '.';
        // Fresh load from server state: not a user edit yet.
        state.appFormDirty = false;
      }

      function renderApps(apps) {
        appsTable.innerHTML = apps.map(function(app) {
          const badge = app.revokedAt ? '<span class="chip bad">revoked</span>' : '<span class="chip good">active</span>';
          const modelSummary = app.allowedModels.length > 0
            ? (app.allowedModels.length + ' models')
            : 'bootstrap defaults';
          return '<tr>' +
            '<td><strong>' + escapeHtml(app.name) + '</strong><div class="footer-note">' + badge + '</div></td>' +
            '<td>' + escapeHtml(app.allowedOrigins.join(', ') || 'none') + '<div class="footer-note">' + escapeHtml(modelSummary) + ': ' + escapeHtml(app.allowedModels.join(', ') || 'inherit bootstrap') + '</div></td>' +
            '<td><div>rpm: ' + escapeHtml(String(app.rateLimitPerMinute)) + '</div><div>conc: ' + escapeHtml(String(app.maxConcurrency)) + '</div><div class="footer-note mono">' + escapeHtml(app.keyPreview) + '</div></td>' +
            '<td><div class="button-row">' +
              '<button type="button" class="secondary" data-action="edit" data-id="' + escapeHtml(app.id) + '">Edit</button>' +
              '<button type="button" class="warn" data-action="rotate" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Rotate</button>' +
              '<button type="button" class="bad" data-action="revoke" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Revoke</button>' +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      function formatAttemptTarget(attempt) {
        if (attempt && attempt.keyId) return String(attempt.keyId);
        return 'no-key';
      }

      function describePolicyRemap(item) {
        const reason = (item && item.policyFallbackReason) || (item && item.fallbackReason) || '';
        if (reason === 'non_free_or_unsupported_model') return 'free-tier';
        if (reason === 'app_model_not_allowed') return 'app';
        return 'policy';
      }

      function describeAttemptReason(attempt) {
        const reason = String(attempt && attempt.reason || '');
        switch (reason) {
          case 'local_rpm_limit_zero':
            return 'quota zero';
          case 'local_tpm_limit_zero':
            return 'tpm zero';
          case 'local_rpd_limit_zero':
            return 'rpd zero';
          case 'local_rpm_unavailable':
            return 'rpm full';
          case 'local_tpm_unavailable':
            return 'tpm full';
          case 'local_rpd_unavailable':
            return 'rpd full';
          case 'local_cooldown_unavailable':
            return 'cooldown';
          case 'gemini_api_auth_failed':
            return 'auth';
          case 'gemini_api_model_not_found':
            return 'model missing';
          case 'gemini_api_rate_limited':
            return 'rate limit';
          case 'gemini_api_high_demand':
            return 'busy';
          case 'gemini_api_upstream_error':
            return 'upstream';
          case 'gemini_api_timeout':
            return 'timeout';
          case 'gemini_api_quota_unavailable':
            return 'no quota';
          case 'gemini_api_no_key_for_model':
            return 'no key';
          default:
            return reason ? reason.replace(/_/g, ' ') : 'attempt failed';
        }
      }

      function buildRoutingSummary(item) {
        const requested = item.requestedModel || item.model || 'n/a';
        const startModel = item.model || requested;
        const finalModel = item.backendModel || startModel;
        const attempts = Array.isArray(item.fallbackAttempts) ? item.fallbackAttempts : [];
        const steps = [];
        let step = 1;

        steps.push('<div class="footer-note">' + String(step++) + '. req ' + escapeHtml(requested) + '</div>');

        if (requested !== startModel) {
          steps.push(
            '<div class="footer-note warn-text">' +
            String(step++) + '. map ' + escapeHtml(requested) + ' -> ' + escapeHtml(startModel) +
            ' [' + escapeHtml(describePolicyRemap(item)) + ']</div>'
          );
        }

        attempts.forEach(function(attempt) {
          const parts = [formatAttemptTarget(attempt), describeAttemptReason(attempt)];
          if (attempt.statusCode) parts.push('[' + String(attempt.statusCode) + ']');
          if (attempt.availableAfter) parts.push('retry ' + formatTimestamp(attempt.availableAfter));
          steps.push(
            '<div class="footer-note">' +
            String(step++) + '. ' + escapeHtml(attempt.model || 'n/a') +
            ' · ' + escapeHtml(parts.filter(Boolean).join(' · ')) + '</div>'
          );
        });

        if (item.status === 'succeeded') {
          steps.push(
            '<div class="footer-note good-text">' +
            String(step++) + '. ok ' + escapeHtml(finalModel) +
            ' · ' + escapeHtml(String(item.apiKeyId || 'unknown')) + '</div>'
          );
        } else {
          const finalReason = item.fallbackReason || item.error || 'failed';
          steps.push(
            '<div class="footer-note warn-text">' +
            String(step++) + '. fail ' + escapeHtml(describeAttemptReason({ reason: finalReason })) + '</div>'
          );
        }

        return '<strong>' + escapeHtml(finalModel) + '</strong>' + steps.join('');
      }

      // Keep the app filter populated with non-revoked apps only.
      function fillInteractionAppFilter() {
        if (!interactionsAppFilter) return;
        const apps = Array.isArray(state.apps) ? state.apps.filter(function(app) { return !app.revokedAt; }) : [];
        const current = state.interactionAppFilter || '';
        const options = ['<option value="">All apps</option>'].concat(apps.map(function(app) {
          return '<option value="' + escapeHtml(String(app.id)) + '">' + escapeHtml(String(app.name || app.id)) + '</option>';
        }));
        interactionsAppFilter.innerHTML = options.join('');
        // Drop the filter if its app was revoked/removed.
        if (current && !apps.some(function(app) { return app.id === current; })) {
          state.interactionAppFilter = '';
        }
        interactionsAppFilter.value = state.interactionAppFilter || '';
      }

      function renderInteractions(summary) {
        let recent = Array.isArray(summary && summary.recent) ? summary.recent : [];
        if (state.interactionAppFilter) {
          recent = recent.filter(function(item) { return item.appId === state.interactionAppFilter; });
        }
        recent = recent.slice(0, Math.max(1, Number(state.interactionLimit) || 10));
        interactionsTable.innerHTML = recent.map(function(item) {
          const usage = item.usage
            ? (item.usage.prompt_tokens + ' / ' + item.usage.completion_tokens + ' / ' + item.usage.total_tokens)
            : 'n/a';
          const feedback = item.feedback ? '<span class="chip ' + item.feedback + '">' + item.feedback + '</span>' : '<span class="chip warn">unrated</span>';
          return '<tr>' +
            '<td>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '<div class="footer-note">' + escapeHtml(item.route) + '</div></td>' +
            '<td><strong>' + escapeHtml(item.appName) + '</strong></td>' +
            '<td>' + buildRoutingSummary(item) + '</td>' +
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
        }).join('') || '<tr><td colspan="7" class="muted">No interactions logged yet.</td></tr>';
      }

      async function loadPublicSummary() {
        if (state.publicRefreshInFlight) return;
        state.publicRefreshInFlight = true;
        try {
          const data = await request('/dashboard/summary');
          state.publicSummary = data;
          renderPublicPills(data);
          renderPublicStats(data);
          renderPublicRpd(data);
          renderOllamaLocalRpd(data);
          if (!state.authenticated) {
            renderProviderState(data);
          }
          renderHourlyChart(data);
          renderRouteChart(data);
        } finally {
          state.publicRefreshInFlight = false;
        }
      }

      async function loadAdminSummary() {
        if (state.adminRefreshInFlight) return;
        state.adminRefreshInFlight = true;
        const editingAppId = String(appForm.elements.id.value || '').trim();
        const selectedModels = getAllowedModelSelection();
        const selectedPromptModel = promptModel.value;
        try {
          const data = await request('/admin/summary');
          state.adminSummary = data;
          state.apps = data.apps;
          state.adminStats = data.stats || null;
          state.modelCatalog = Array.isArray(data.modelCatalog) ? data.modelCatalog : [];
          state.compatibility = data.compatibility || null;
          state.freeTierPolicy = data.freeTierPolicy || null;
          syncProjectQuotaState((data.provider && data.provider.quota) || null);
          // Never clobber the app form while the operator is editing it: a background
          // refresh must not wipe in-progress model checkboxes or reset the form fields.
          if (!state.appFormDirty) {
            renderAllowedModelsPicker(state.modelCatalog, selectedModels);
          }
          fillAppOptions(data.apps);
          fillModelOptions(selectedPromptModel);
          renderRuntimePills(data);
          renderBackendDiagnostics(data);
          renderProviderState(data);
          renderStats(data.stats);
          loadAccounts();
          loadProxyConfig();
          loadModelsConfig();
          renderCompatibility(data.compatibility);
          renderApps(data.apps);
          fillInteractionAppFilter();
          renderInteractions(state.adminStats);
          if (editingAppId && !state.appFormDirty) {
            const editingApp = data.apps.find(function(app) { return app.id === editingAppId; });
            if (editingApp) {
              populateAppForm(editingApp);
            }
          }
          setAdminVisible(true);
          const freeTierAlerts = state.freeTierPolicy && Array.isArray(state.freeTierPolicy.alerts)
            ? state.freeTierPolicy.alerts
            : [];
          const criticalAlert = freeTierAlerts.find(function(alert) { return alert.level === 'critical'; }) || freeTierAlerts[0];
          const banner = adminBannerTitle ? adminBannerTitle.closest('.role-banner') : null;
          if (banner) banner.classList.toggle('is-critical', Boolean(criticalAlert));
          if (criticalAlert) {
            adminBannerTitle.textContent = criticalAlert.message;
            adminBannerCopy.textContent = (criticalAlert.modelIds || []).join(', ') || 'Free-tier model policy changed.';
          } else {
            adminBannerTitle.textContent = 'Operator console active';
            adminBannerCopy.textContent = state.username ? 'Signed in as ' + state.username + '.' : 'Signed in as admin.';
          }
        } finally {
          state.adminRefreshInFlight = false;
        }
      }

      async function loadProjectQuota(force) {
        if (!state.authenticated || state.projectQuotaRefreshInFlight) return;
        const updatedAt = Date.parse(String(state.projectQuota && state.projectQuota.updatedAt || ''));
        if (!force && Number.isFinite(updatedAt) && (Date.now() - updatedAt) < PROJECT_QUOTA_REFRESH_MS) {
          return;
        }
        state.projectQuotaRefreshInFlight = true;
        try {
          const data = await request('/admin/provider/gemini-api/refresh-quota', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          syncProjectQuotaState(data);
          if (state.adminSummary) {
            renderProviderState(state.adminSummary);
          }
        } finally {
          state.projectQuotaRefreshInFlight = false;
        }
      }

      async function refreshSession() {
        const me = await request('/auth/me');
        state.authenticated = me.authenticated === true;
        state.username = me.username || '';
        if (state.authenticated) {
          authSummary.textContent = state.username ? 'Admin session active for ' + state.username + '.' : 'Admin session active.';
          authStatus.textContent = '';
          await loadAdminSummary();
          await loadProjectQuota(false);
        } else {
          state.adminSummary = null;
          state.projectQuota = null;
          setAdminVisible(false);
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
          state.adminSummary = null;
          state.projectQuota = null;
          setAdminVisible(false);
          authSummary.textContent = 'Guest view is active. Sign in to manage apps, keys, routes and diagnostics.';
          authStatus.textContent = '';
        }
      }

      logoutButton.addEventListener('click', logoutAdminSession);
      menuLogoutButton.addEventListener('click', logoutAdminSession);

      async function saveCompatibilitySurface() {
        compatibilityStatus.textContent = 'Updating primary surface…';
        try {
          await request('/admin/compatibility', {
            method: 'POST',
            body: JSON.stringify({
              defaultSurface: compatibilityForm.elements.defaultSurface.value,
            }),
          });
          compatibilityStatus.textContent = 'Primary surface updated.';
          await loadPublicSummary();
          await loadAdminSummary();
        } catch (error) {
          compatibilityStatus.textContent = error.message;
        }
      }

      compatibilityForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        await saveCompatibilitySurface();
      });
      compatibilityForm.elements.defaultSurface.addEventListener('change', function() {
        void saveCompatibilitySurface();
      });

      promptForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        promptStatus.textContent = 'Sending prompt through the active router backend…';
        promptResponse.innerHTML = '<div class="muted">Waiting for model response…</div>';
        promptImageOutput.innerHTML = '<div class="muted">No generated image yet.</div>';
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
            }),
          });
          promptStatus.textContent = 'Completed in ' + response.latencyMs + ' ms.';
          promptResponse.innerHTML = renderMarkdown(response.text || '');
          renderPromptImages(response.images || []);
          await loadPublicSummary();
          await loadAdminSummary();
        } catch (error) {
          promptStatus.textContent = error.message;
          promptResponse.innerHTML = '<div class="muted">' + escapeHtml(error.message) + '</div>';
          promptImageOutput.innerHTML = '<div class="muted">No generated image yet.</div>';
        }
      });
      promptImageOutput.addEventListener('click', function(event) {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        if (target.closest('.image-download-link')) return;
        const image = target.closest('.prompt-preview-image');
        if (!image) return;
        toggleImageLightbox(image.getAttribute('data-image-src') || image.getAttribute('src') || '', image.getAttribute('alt') || 'Expanded generated image');
      });
      if (imageLightbox) {
        imageLightbox.addEventListener('click', function() {
          closeImageLightbox();
        });
      }
      if (appKeyModal) {
        appKeyModal.addEventListener('click', function() {
          closeAppKeyModal();
        });
      }
      if (appKeyModalCard) {
        appKeyModalCard.addEventListener('click', function(event) {
          event.stopPropagation();
        });
      }
      if (appKeyModalCopyButton) {
        appKeyModalCopyButton.addEventListener('click', function() {
          void copyAppKeyFromModal();
        });
      }
      if (appKeyModalCloseButton) {
        appKeyModalCloseButton.addEventListener('click', function() {
          closeAppKeyModal();
        });
      }
      document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
          closeImageLightbox();
          closeAppKeyModal();
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
          allowedModels: getAllowedModelSelection(),
          sessionNamespace: form.get('sessionNamespace'),
          rateLimitPerMinute: Number(form.get('rateLimitPerMinute') || 0),
          maxConcurrency: Number(form.get('maxConcurrency') || 0),
        };
        const customKey = String(form.get('apiKey') || '').trim();
        if (!id && customKey) payload.apiKey = customKey;
        try {
          const response = await request(id ? '/admin/apps/' + encodeURIComponent(id) : '/admin/apps', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(payload),
          });
          if (id) {
            appStatus.textContent = 'App updated.';
          } else {
            appStatus.textContent = 'App created. The new key is shown in the popup.';
            openAppKeyModal('New API key for ' + String((response.app && response.app.name) || payload.name || 'app'), response.apiKey);
          }
          resetAppForm();
          await loadAdminSummary();
        } catch (error) {
          appStatus.textContent = error.message;
        }
      });

      appReset.addEventListener('click', resetAppForm);
      promptApp.addEventListener('change', function() {
        fillModelOptions();
      });
      if (interactionsLimitSelect) {
        interactionsLimitSelect.value = String(state.interactionLimit);
        interactionsLimitSelect.addEventListener('change', function() {
          const nextValue = Number(interactionsLimitSelect.value || 10);
          state.interactionLimit = Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 10;
          renderInteractions(state.adminStats);
        });
      }
      if (interactionsAppFilter) {
        interactionsAppFilter.addEventListener('change', function() {
          state.interactionAppFilter = interactionsAppFilter.value || '';
          renderInteractions(state.adminStats);
        });
      }
      allowedModelsOptions.addEventListener('change', function() {
        state.appFormDirty = true;
        updateAllowedModelsSummary();
      });
      // Any manual edit to the app form marks it dirty so background refreshes leave it alone.
      appForm.addEventListener('input', function() {
        state.appFormDirty = true;
      });

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
            appStatus.textContent = 'Key rotated. The new key is shown in the popup.';
            openAppKeyModal('Rotated API key for ' + String((response.app && response.app.name) || app.name || 'app'), response.apiKey);
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

      window.setInterval(function() {
        if (document.hidden) return;
        Promise.all([
          loadPublicSummary(),
          refreshSession(),
        ]).catch(function(error) {
          authStatus.textContent = error.message;
        });
      }, PUBLIC_REFRESH_MS);
    </script>
  </body>
</html>`;
}
