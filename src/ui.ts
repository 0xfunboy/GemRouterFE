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
  serviceName: string;
  publicBaseUrl: string;
  vncUrl: string;
  studyPath: string;
  modelIds: string[];
}): string {
  const bootstrap = JSON.stringify(input).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.projectName)} Control Deck</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09131a;
        --bg-soft: #10212d;
        --panel: rgba(13, 29, 40, 0.88);
        --panel-strong: rgba(7, 19, 27, 0.96);
        --line: rgba(141, 185, 202, 0.18);
        --text: #edf6fb;
        --muted: #8db0bf;
        --accent: #7be0bf;
        --accent-strong: #a7ff83;
        --warn: #ffbe69;
        --bad: #ff7d66;
        --good: #73f2ae;
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        --radius: 22px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(123, 224, 191, 0.18), transparent 32%),
          radial-gradient(circle at top right, rgba(255, 190, 105, 0.16), transparent 24%),
          linear-gradient(180deg, #0a141a 0%, #081016 48%, #060d12 100%);
        color: var(--text);
      }
      a { color: inherit; }
      .shell {
        width: min(1500px, calc(100vw - 32px));
        margin: 24px auto 48px;
      }
      .hero {
        display: grid;
        gap: 18px;
        grid-template-columns: 1.3fr 0.7fr;
        margin-bottom: 20px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .hero-main, .hero-side, .section {
        padding: 24px;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(123, 224, 191, 0.1);
        border: 1px solid rgba(123, 224, 191, 0.18);
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1, h2, h3, h4, p { margin: 0; }
      h1 {
        margin-top: 18px;
        font-size: clamp(34px, 4vw, 64px);
        line-height: 0.96;
        letter-spacing: -0.04em;
      }
      .lede {
        margin-top: 14px;
        max-width: 64ch;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }
      .hero-grid, .stats-grid, .apps-grid, .runtime-grid {
        display: grid;
        gap: 16px;
      }
      .hero-grid, .stats-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin-top: 22px;
      }
      .runtime-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .card {
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.02);
        padding: 16px;
      }
      .label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
      }
      .metric {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .metric-sub {
        margin-top: 6px;
        color: var(--muted);
        font-size: 13px;
      }
      .section {
        margin-top: 20px;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .section-title {
        font-size: 22px;
        letter-spacing: -0.03em;
      }
      .section-copy {
        color: var(--muted);
        font-size: 14px;
      }
      .hidden { display: none !important; }
      .login-wrap {
        max-width: 460px;
        margin: 56px auto;
      }
      form {
        display: grid;
        gap: 14px;
      }
      label {
        display: grid;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.03em;
      }
      input, textarea, select, button {
        border: 1px solid rgba(141, 185, 202, 0.18);
        border-radius: 14px;
        background: rgba(4, 10, 14, 0.65);
        color: var(--text);
        font: inherit;
        padding: 12px 14px;
      }
      textarea {
        min-height: 132px;
        resize: vertical;
      }
      button {
        cursor: pointer;
        background: linear-gradient(135deg, rgba(123, 224, 191, 0.2), rgba(167, 255, 131, 0.2));
      }
      button.secondary {
        background: rgba(255, 255, 255, 0.03);
      }
      button.warn {
        background: rgba(255, 190, 105, 0.12);
      }
      button.bad {
        background: rgba(255, 125, 102, 0.12);
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .shell-grid {
        display: grid;
        gap: 20px;
        grid-template-columns: 1.1fr 0.9fr;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th, .table td {
        padding: 12px 10px;
        text-align: left;
        border-top: 1px solid rgba(141, 185, 202, 0.12);
        vertical-align: top;
        font-size: 13px;
      }
      .table th {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .pill.good { color: var(--good); border-color: rgba(115, 242, 174, 0.2); }
      .pill.bad { color: var(--bad); border-color: rgba(255, 125, 102, 0.24); }
      .pill.warn { color: var(--warn); border-color: rgba(255, 190, 105, 0.24); }
      .status {
        min-height: 24px;
        color: var(--muted);
        font-size: 13px;
      }
      .response-box {
        white-space: pre-wrap;
        line-height: 1.55;
        min-height: 220px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.02);
        padding: 18px;
      }
      iframe {
        width: 100%;
        min-height: 420px;
        border: 0;
        border-radius: 18px;
        background: #020507;
      }
      .footer-note {
        margin-top: 14px;
        color: var(--muted);
        font-size: 12px;
      }
      @media (max-width: 1080px) {
        .hero, .shell-grid { grid-template-columns: 1fr; }
        .hero-grid, .stats-grid, .runtime-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px) {
        .shell { width: min(100vw - 16px, 100%); margin: 12px auto 32px; }
        .hero-main, .hero-side, .section { padding: 18px; }
        .hero-grid, .stats-grid, .runtime-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero" id="top-shell">
        <div class="panel hero-main">
          <span class="tag">Gemini Frontend Router</span>
          <h1>${escapeHtml(input.projectName)}<br />Control Deck</h1>
          <p class="lede">
            OpenAI-compatible API routing on top of Gemini Web via Playwright, with a built-in admin deck for prompt testing,
            app key management, runtime inspection, and VNC-assisted login recovery.
          </p>
          <div class="hero-grid">
            <div class="card">
              <div class="label">Public Base</div>
              <div class="metric mono" id="public-base">${escapeHtml(input.publicBaseUrl)}</div>
              <div class="metric-sub">Main UI and API surface</div>
            </div>
            <div class="card">
              <div class="label">VNC Endpoint</div>
              <div class="metric mono" id="vnc-base">${escapeHtml(input.vncUrl)}</div>
              <div class="metric-sub">Use it to re-login Gemini in headed mode</div>
            </div>
            <div class="card">
              <div class="label">Models</div>
              <div class="metric mono" id="model-list">${escapeHtml(input.modelIds.join(', '))}</div>
              <div class="metric-sub">OpenAI-compatible routes on top</div>
            </div>
            <div class="card">
              <div class="label">Study Path</div>
              <div class="metric mono">${escapeHtml(input.studyPath)}</div>
              <div class="metric-sub">Project plan outside the repo</div>
            </div>
          </div>
        </div>
        <aside class="panel hero-side" id="auth-panel">
          <div class="section-head">
            <div>
              <h2 class="section-title">Admin Access</h2>
              <p class="section-copy">Use the configured admin token to unlock app management and the prompt lab.</p>
            </div>
          </div>
          <div id="auth-status" class="status">Checking session…</div>
          <form id="login-form" class="hidden">
            <label>
              Admin token
              <input type="password" name="token" autocomplete="current-password" placeholder="Paste admin token" required />
            </label>
            <button type="submit">Enter Dashboard</button>
          </form>
          <div id="auth-actions" class="button-row hidden">
            <button id="refresh-button" type="button" class="secondary">Refresh Dashboard</button>
            <button id="logout-button" type="button" class="warn">Log Out</button>
          </div>
          <p class="footer-note">
            API clients still use standard bearer keys on <span class="mono">/v1/chat/completions</span> and <span class="mono">/v1/responses</span>.
          </p>
        </aside>
      </section>

      <section id="dashboard" class="hidden">
        <section class="panel section">
          <div class="section-head">
            <div>
              <h2 class="section-title">Overview</h2>
              <p class="section-copy">Live request counts, token usage, feedback quality, and runtime health.</p>
            </div>
          </div>
          <div class="stats-grid" id="stats-grid"></div>
        </section>

        <div class="shell-grid">
          <section class="panel section">
            <div class="section-head">
              <div>
                <h2 class="section-title">Prompt Lab</h2>
                <p class="section-copy">Run prompts through the live Playwright session without exposing app keys in the browser.</p>
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
                <textarea name="prompt" placeholder="Write the prompt you want to test" required></textarea>
              </label>
              <label>
                Session hint
                <input type="text" name="sessionHint" placeholder="Optional stateful session id" />
              </label>
              <div class="button-row">
                <label class="pill">
                  <input type="checkbox" name="stateful" style="margin-right:8px" />
                  Keep Playwright conversation open
                </label>
              </div>
              <div class="button-row">
                <button type="submit">Run Prompt</button>
              </div>
              <div id="prompt-status" class="status"></div>
            </form>
            <div id="prompt-response" class="response-box">No prompt sent yet.</div>
          </section>

          <section class="panel section">
            <div class="section-head">
              <div>
                <h2 class="section-title">Gemini VNC</h2>
                <p class="section-copy">Use this pane when the Playwright profile is signed out and needs a manual Gemini login.</p>
              </div>
              <a id="open-vnc-link" class="pill" href="${escapeHtml(input.vncUrl)}" target="_blank" rel="noreferrer">Open in New Tab</a>
            </div>
            <iframe id="vnc-frame" src="${escapeHtml(input.vncUrl)}" title="Gemini VNC"></iframe>
          </section>
        </div>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h2 class="section-title">Apps</h2>
              <p class="section-copy">Create browser-facing app keys, edit origin/model scopes, and rotate or revoke keys.</p>
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
                  <button type="submit">Save App</button>
                  <button type="button" class="secondary" id="app-reset">Reset Form</button>
                </div>
                <div id="app-status" class="status"></div>
              </form>
            </div>
            <div style="overflow:auto">
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
              <h2 class="section-title">Interactions</h2>
              <p class="section-copy">Recent prompts, outputs, token counts, and manual quality labeling.</p>
            </div>
          </div>
          <div style="overflow:auto">
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

        <section class="panel section">
          <div class="section-head">
            <div>
              <h2 class="section-title">Runtime</h2>
              <p class="section-copy">Current display/headless state, Chrome profile status, and service wiring.</p>
            </div>
          </div>
          <div class="runtime-grid" id="runtime-grid"></div>
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
        summary: null,
      };

      const authStatus = document.getElementById('auth-status');
      const loginForm = document.getElementById('login-form');
      const authActions = document.getElementById('auth-actions');
      const dashboard = document.getElementById('dashboard');
      const refreshButton = document.getElementById('refresh-button');
      const logoutButton = document.getElementById('logout-button');
      const promptForm = document.getElementById('prompt-form');
      const promptStatus = document.getElementById('prompt-status');
      const promptResponse = document.getElementById('prompt-response');
      const appForm = document.getElementById('app-form');
      const appStatus = document.getElementById('app-status');
      const appsTable = document.getElementById('apps-table');
      const statsGrid = document.getElementById('stats-grid');
      const runtimeGrid = document.getElementById('runtime-grid');
      const interactionsTable = document.getElementById('interactions-table');
      const promptApp = document.getElementById('prompt-app');
      const promptModel = document.getElementById('prompt-model');
      const appReset = document.getElementById('app-reset');

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

      function resetAppForm() {
        appForm.reset();
        appForm.elements.id.value = '';
        appStatus.textContent = '';
      }

      function fillModelOptions(models) {
        promptModel.innerHTML = models
          .map((model) => '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>')
          .join('');
      }

      function fillAppOptions(apps) {
        promptApp.innerHTML = apps
          .filter((app) => !app.revokedAt)
          .map((app) => '<option value="' + escapeHtml(app.id) + '">' + escapeHtml(app.name) + ' · ' + escapeHtml(app.id) + '</option>')
          .join('');
      }

      function renderStats(summary, runtime) {
        const totals = summary.totals;
        const feedback = summary.feedback;
        statsGrid.innerHTML = [
          ['Requests', fmtNumber(totals.requests), totals.succeeded + ' ok / ' + totals.failed + ' failed'],
          ['Tokens', fmtNumber(totals.totalTokens), fmtNumber(totals.promptTokens) + ' prompt / ' + fmtNumber(totals.completionTokens) + ' completion'],
          ['Average Latency', fmtNumber(totals.avgLatencyMs) + ' ms', 'Based on completed interaction logs'],
          ['Feedback', feedback.good + ' good / ' + feedback.bad + ' bad', feedback.unrated + ' unrated'],
        ].map(([label, value, sub]) => (
          '<div class="card"><div class="label">' + label + '</div><div class="metric">' + escapeHtml(value) + '</div><div class="metric-sub">' + escapeHtml(sub) + '</div></div>'
        )).join('');

        runtimeGrid.innerHTML = [
          ['Display', runtime.display || 'none', runtime.headless ? 'Headless mode active' : 'Headed Playwright mode active'],
          ['Chrome Profile', runtime.profileDir, runtime.executableExists ? 'browser path found' : 'browser path missing'],
          ['Apps', String(runtime.apps), runtime.auditLogPath],
          ['NoVNC', bootstrap.vncUrl, 'Used for manual Gemini login recovery'],
        ].map(([label, value, sub]) => (
          '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="metric mono">' + escapeHtml(value) + '</div><div class="metric-sub">' + escapeHtml(sub) + '</div></div>'
        )).join('');
      }

      function renderApps(apps) {
        appsTable.innerHTML = apps.map((app) => {
          const revoked = app.revokedAt ? '<span class="pill bad">revoked</span>' : '<span class="pill good">active</span>';
          return '<tr>' +
            '<td><div><strong>' + escapeHtml(app.name) + '</strong></div><div class="mono">' + escapeHtml(app.id) + '</div><div>' + revoked + '</div></td>' +
            '<td>' + escapeHtml(app.allowedOrigins.join(', ') || 'none') + '<div class="footer-note">models: ' + escapeHtml(app.allowedModels.join(', ')) + '</div></td>' +
            '<td><div>rpm: ' + escapeHtml(String(app.rateLimitPerMinute)) + '</div><div>conc: ' + escapeHtml(String(app.maxConcurrency)) + '</div><div class="mono">' + escapeHtml(app.keyPreview) + '</div></td>' +
            '<td><div class="button-row">' +
              '<button type="button" class="secondary" data-action="edit" data-id="' + escapeHtml(app.id) + '">Edit</button>' +
              '<button type="button" class="warn" data-action="rotate" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Rotate</button>' +
              '<button type="button" class="bad" data-action="revoke" data-id="' + escapeHtml(app.id) + '"' + (app.revokedAt ? ' disabled' : '') + '>Revoke</button>' +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      function renderInteractions(summary) {
        interactionsTable.innerHTML = summary.recent.map((item) => {
          const usage = item.usage
            ? item.usage.prompt_tokens + ' / ' + item.usage.completion_tokens + ' / ' + item.usage.total_tokens
            : 'n/a';
          const feedback = item.feedback
            ? '<span class="pill ' + item.feedback + '">' + item.feedback + '</span>'
            : '<span class="pill warn">unrated</span>';
          return '<tr>' +
            '<td>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '<div class="footer-note">' + escapeHtml(item.route) + '</div></td>' +
            '<td><strong>' + escapeHtml(item.appName) + '</strong><div class="mono">' + escapeHtml(item.appId) + '</div></td>' +
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

      async function loadDashboard() {
        const data = await request('/admin/summary');
        state.apps = data.apps;
        state.summary = data.stats;
        authStatus.textContent = 'Authenticated.';
        loginForm.classList.add('hidden');
        authActions.classList.remove('hidden');
        dashboard.classList.remove('hidden');
        fillModelOptions(data.models);
        fillAppOptions(data.apps);
        renderStats(data.stats, data.runtime);
        renderApps(data.apps);
        renderInteractions(data.stats);
      }

      async function refreshAuth() {
        try {
          await request('/admin/me');
          await loadDashboard();
        } catch {
          authStatus.textContent = 'Admin session required.';
          loginForm.classList.remove('hidden');
          authActions.classList.add('hidden');
          dashboard.classList.add('hidden');
        }
      }

      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        authStatus.textContent = 'Opening admin session…';
        const form = new FormData(loginForm);
        try {
          await request('/admin/login', {
            method: 'POST',
            body: JSON.stringify({ token: form.get('token') }),
          });
          loginForm.reset();
          await loadDashboard();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      refreshButton.addEventListener('click', () => {
        loadDashboard().catch((error) => {
          authStatus.textContent = error.message;
        });
      });

      logoutButton.addEventListener('click', async () => {
        try {
          await request('/admin/logout', { method: 'POST', body: JSON.stringify({}) });
        } finally {
          await refreshAuth();
        }
      });

      promptForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        promptStatus.textContent = 'Sending prompt through the live Gemini session…';
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
          await loadDashboard();
        } catch (error) {
          promptStatus.textContent = error.message;
        }
      });

      appForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(appForm);
        const id = String(form.get('id') || '').trim();
        appStatus.textContent = id ? 'Updating app…' : 'Creating app…';
        const payload = {
          name: form.get('name'),
          allowedOrigins: String(form.get('allowedOrigins') || '').split(',').map((item) => item.trim()).filter(Boolean),
          allowedModels: String(form.get('allowedModels') || '').split(',').map((item) => item.trim()).filter(Boolean),
          sessionNamespace: form.get('sessionNamespace'),
          rateLimitPerMinute: Number(form.get('rateLimitPerMinute') || 0),
          maxConcurrency: Number(form.get('maxConcurrency') || 0),
        };
        try {
          const response = await request(id ? '/admin/apps/' + encodeURIComponent(id) : '/admin/apps', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(payload),
          });
          appStatus.textContent = id
            ? 'App updated.'
            : ('App created. Save this key now: ' + response.apiKey);
          resetAppForm();
          await loadDashboard();
        } catch (error) {
          appStatus.textContent = error.message;
        }
      });

      appReset.addEventListener('click', resetAppForm);

      appsTable.addEventListener('click', async (event) => {
        const target = event.target.closest('button');
        if (!target) return;
        const id = target.dataset.id;
        const action = target.dataset.action;
        const app = state.apps.find((entry) => entry.id === id);
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
          await loadDashboard();
        } catch (error) {
          appStatus.textContent = error.message;
        }
      });

      interactionsTable.addEventListener('click', async (event) => {
        const target = event.target.closest('button');
        if (!target) return;
        const id = target.dataset.id;
        const feedback = target.dataset.feedback;
        if (!id || !feedback) return;
        try {
          if (feedback === 'clear') {
            await request('/admin/interactions/' + encodeURIComponent(id) + '/feedback', {
              method: 'DELETE',
            });
          } else {
            const notes = window.prompt('Optional note for this rating:', '') || '';
            await request('/admin/interactions/' + encodeURIComponent(id) + '/feedback', {
              method: 'POST',
              body: JSON.stringify({ feedback, notes }),
            });
          }
          await loadDashboard();
        } catch (error) {
          authStatus.textContent = error.message;
        }
      });

      refreshAuth().catch((error) => {
        authStatus.textContent = error.message;
      });
    </script>
  </body>
</html>`;
}
