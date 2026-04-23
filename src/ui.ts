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
}): string {
  const bootstrap = JSON.stringify(input).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.projectName)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #05060d;
        --bg-soft: #0a0d18;
        --panel: rgba(13, 15, 31, 0.9);
        --panel-soft: rgba(18, 22, 42, 0.82);
        --line: rgba(118, 98, 255, 0.2);
        --line-strong: rgba(118, 98, 255, 0.36);
        --text: #edf0ff;
        --muted: #98a0c4;
        --accent: #8f7cff;
        --accent-soft: #5aa4ff;
        --good: #8ab4ff;
        --warn: #ffb870;
        --bad: #ff7b8f;
        --shadow: 0 24px 90px rgba(0, 0, 0, 0.4);
        --radius: 20px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        font-size: 14px;
        background:
          radial-gradient(circle at top left, rgba(90, 164, 255, 0.12), transparent 26%),
          radial-gradient(circle at top right, rgba(143, 124, 255, 0.16), transparent 28%),
          linear-gradient(180deg, #05060d 0%, #070914 42%, #05060d 100%);
        color: var(--text);
      }
      a { color: inherit; text-decoration: none; }
      h1, h2, h3, h4, p { margin: 0; }
      .shell {
        width: min(1420px, calc(100vw - 24px));
        margin: 16px auto 28px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .hidden { display: none !important; }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(118, 98, 255, 0.24);
        background: rgba(118, 98, 255, 0.08);
        color: #b8b0ff;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .landing {
        max-width: 520px;
        margin: 56px auto 0;
        padding: 24px;
      }
      .landing h1 {
        margin-top: 14px;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      .lede {
        margin-top: 12px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .model-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--muted);
        font-size: 11px;
      }
      .pill.good {
        color: #c1d6ff;
        border-color: rgba(138, 180, 255, 0.22);
      }
      .pill.warn {
        color: #ffd0a6;
        border-color: rgba(255, 184, 112, 0.24);
      }
      .pill.bad {
        color: #ffc0cb;
        border-color: rgba(255, 123, 143, 0.28);
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
        letter-spacing: 0.03em;
      }
      input, textarea, select, button {
        border-radius: 14px;
        border: 1px solid rgba(118, 98, 255, 0.18);
        background: rgba(5, 8, 19, 0.76);
        color: var(--text);
        padding: 11px 13px;
        font: inherit;
      }
      textarea {
        min-height: 126px;
        resize: vertical;
      }
      button {
        cursor: pointer;
        background: linear-gradient(135deg, rgba(118, 98, 255, 0.26), rgba(90, 164, 255, 0.22));
        border-color: rgba(118, 98, 255, 0.28);
      }
      button.secondary {
        background: rgba(255, 255, 255, 0.03);
      }
      button.warn {
        background: rgba(255, 184, 112, 0.1);
      }
      button.bad {
        background: rgba(255, 123, 143, 0.12);
      }
      .status {
        min-height: 18px;
        color: var(--muted);
        font-size: 12px;
      }
      .topbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 20px;
        margin-bottom: 16px;
      }
      .topbar h2 {
        margin-top: 8px;
        font-size: 22px;
        letter-spacing: -0.03em;
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .section {
        margin-top: 16px;
        padding: 18px;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .section-title {
        font-size: 17px;
        letter-spacing: -0.02em;
      }
      .section-copy {
        color: var(--muted);
        font-size: 12px;
      }
      .stats-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .card {
        border-radius: 16px;
        border: 1px solid rgba(118, 98, 255, 0.16);
        background: var(--panel-soft);
        padding: 14px;
      }
      .label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-size: 10px;
      }
      .metric {
        margin-top: 8px;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .metric-sub {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .shell-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: 1fr 1fr;
      }
      .response-box {
        white-space: pre-wrap;
        line-height: 1.6;
        min-height: 220px;
        border-radius: 16px;
        border: 1px solid rgba(118, 98, 255, 0.14);
        background: rgba(255, 255, 255, 0.025);
        padding: 16px;
        font-size: 13px;
      }
      iframe {
        width: 100%;
        min-height: 430px;
        border: 0;
        border-radius: 16px;
        background: #02030a;
      }
      .table-wrap {
        overflow: auto;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th, .table td {
        padding: 11px 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        text-align: left;
        vertical-align: top;
        font-size: 12px;
      }
      .table th {
        color: var(--muted);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      .muted {
        color: var(--muted);
      }
      .footer-note {
        margin-top: 6px;
        color: var(--muted);
        font-size: 11px;
      }
      @media (max-width: 1100px) {
        .stats-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .shell-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 720px) {
        .shell {
          width: min(100vw - 12px, 100%);
          margin: 10px auto 18px;
        }
        .landing {
          margin-top: 22px;
          padding: 18px;
        }
        .topbar, .section {
          padding: 16px;
        }
        .stats-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section id="landing" class="panel landing">
        <span class="eyebrow">Private Admin</span>
        <h1>${escapeHtml(input.projectName)}</h1>
        <p class="lede">
          OpenAI-compatible Gemini frontend router. Use the admin secret to unlock the prompt lab, app management,
          recent interactions, and the noVNC operator view.
        </p>
        <div class="model-row">
          ${input.modelIds.map((modelId) => `<span class="pill">${escapeHtml(modelId)}</span>`).join('')}
        </div>
        <div style="margin-top:20px">
          <div id="auth-status" class="status">Checking session…</div>
          <form id="login-form" class="hidden" style="margin-top:10px">
            <label>
              Admin secret
              <input type="password" name="token" autocomplete="current-password" placeholder="Paste admin token" required />
            </label>
            <button type="submit">Unlock Dashboard</button>
          </form>
        </div>
      </section>

      <section id="dashboard" class="hidden">
        <header class="panel topbar">
          <div>
            <span class="eyebrow">Authenticated</span>
            <h2>${escapeHtml(input.projectName)} Dashboard</h2>
            <div id="runtime-pills" class="meta-row"></div>
          </div>
          <div class="button-row">
            <button id="refresh-button" type="button" class="secondary">Refresh</button>
            <button id="logout-button" type="button" class="warn">Log Out</button>
          </div>
        </header>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Overview</h3>
              <p class="section-copy">Requests, tokens, latency, and manual quality feedback.</p>
            </div>
          </div>
          <div id="stats-grid" class="stats-grid"></div>
        </section>

        <div class="shell-grid">
          <section class="panel section">
            <div class="section-head">
              <div>
                <h3 class="section-title">Prompt Lab</h3>
                <p class="section-copy">Runs through the live Playwright Gemini session using the selected app policy.</p>
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
                <textarea name="prompt" placeholder="Write the prompt to test" required></textarea>
              </label>
              <label>
                Session hint
                <input type="text" name="sessionHint" placeholder="Optional stateful session id" />
              </label>
              <div class="button-row">
                <label class="pill">
                  <input type="checkbox" name="stateful" style="margin-right:8px" />
                  Keep session open
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
                <h3 class="section-title">Operator View</h3>
                <p class="section-copy">Manual Gemini recovery and visual inspection through noVNC.</p>
              </div>
              <a id="open-vnc-link" class="pill good" href="#" target="_blank" rel="noreferrer">Open noVNC</a>
            </div>
            <iframe id="vnc-frame" src="about:blank" title="Gemini noVNC"></iframe>
          </section>
        </div>

        <section class="panel section">
          <div class="section-head">
            <div>
              <h3 class="section-title">Apps</h3>
              <p class="section-copy">Create and rotate frontend-facing API keys without using curl.</p>
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
              <p class="section-copy">Prompt excerpts, output excerpts, token estimates, latency, and manual good/bad labels.</p>
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
        vncUrl: '',
      };

      const landing = document.getElementById('landing');
      const dashboard = document.getElementById('dashboard');
      const authStatus = document.getElementById('auth-status');
      const loginForm = document.getElementById('login-form');
      const refreshButton = document.getElementById('refresh-button');
      const logoutButton = document.getElementById('logout-button');
      const runtimePills = document.getElementById('runtime-pills');
      const statsGrid = document.getElementById('stats-grid');
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

      function setAuthenticatedView(enabled) {
        if (enabled) {
          landing.classList.add('hidden');
          dashboard.classList.remove('hidden');
          return;
        }
        dashboard.classList.add('hidden');
        landing.classList.remove('hidden');
      }

      function fillModelOptions(models) {
        promptModel.innerHTML = models
          .map((model) => '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>')
          .join('');
      }

      function fillAppOptions(apps) {
        promptApp.innerHTML = apps
          .filter((app) => !app.revokedAt)
          .map((app) => '<option value="' + escapeHtml(app.id) + '">' + escapeHtml(app.name) + '</option>')
          .join('');
      }

      function resetAppForm() {
        appForm.reset();
        appForm.elements.id.value = '';
        appStatus.textContent = '';
      }

      function renderRuntimePills(data) {
        const runtime = data.runtime || {};
        const pills = [
          bootstrap.modelIds.map((model) => '<span class="pill">' + escapeHtml(model) + '</span>').join(''),
          '<span class="pill ' + (runtime.headed ? 'good' : 'warn') + '">' + (runtime.headed ? 'Headed mode' : 'Headless mode') + '</span>',
          '<span class="pill ' + (runtime.profileReady ? 'good' : 'bad') + '">' + (runtime.profileReady ? 'Profile ready' : 'Profile needs attention') + '</span>',
          '<span class="pill">Apps ' + escapeHtml(String(runtime.apps || 0)) + '</span>',
        ];
        runtimePills.innerHTML = pills.join('');
      }

      function renderStats(summary) {
        const totals = summary.totals;
        const feedback = summary.feedback;
        statsGrid.innerHTML = [
          ['Requests', fmtNumber(totals.requests), totals.succeeded + ' ok / ' + totals.failed + ' failed'],
          ['Tokens', fmtNumber(totals.totalTokens), fmtNumber(totals.promptTokens) + ' prompt / ' + fmtNumber(totals.completionTokens) + ' completion'],
          ['Avg latency', fmtNumber(totals.avgLatencyMs) + ' ms', 'Across logged interactions'],
          ['Feedback', feedback.good + ' good / ' + feedback.bad + ' bad', feedback.unrated + ' unrated'],
        ].map(([label, value, sub]) => (
          '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="metric">' + escapeHtml(value) + '</div><div class="metric-sub">' + escapeHtml(sub) + '</div></div>'
        )).join('');
      }

      function renderApps(apps) {
        appsTable.innerHTML = apps.map((app) => {
          const badge = app.revokedAt ? '<span class="pill bad">revoked</span>' : '<span class="pill good">active</span>';
          return '<tr>' +
            '<td><strong>' + escapeHtml(app.name) + '</strong><div class="footer-note">' + badge + '</div></td>' +
            '<td>' + escapeHtml(app.allowedOrigins.join(', ') || 'none') +
              '<div class="footer-note">models: ' + escapeHtml(app.allowedModels.join(', ')) + '</div></td>' +
            '<td><div>rpm: ' + escapeHtml(String(app.rateLimitPerMinute)) + '</div>' +
              '<div>conc: ' + escapeHtml(String(app.maxConcurrency)) + '</div>' +
              '<div class="footer-note mono">' + escapeHtml(app.keyPreview) + '</div></td>' +
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
            '<td>' + escapeHtml(new Date(item.createdAt).toLocaleString()) +
              '<div class="footer-note">' + escapeHtml(item.route) + '</div></td>' +
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
        state.vncUrl = data.vncUrl || '';
        fillModelOptions(data.models);
        fillAppOptions(data.apps);
        renderRuntimePills(data);
        renderStats(data.stats);
        renderApps(data.apps);
        renderInteractions(data.stats);
        openVncLink.href = state.vncUrl || '#';
        vncFrame.src = state.vncUrl || 'about:blank';
        setAuthenticatedView(true);
      }

      async function refreshAuth() {
        try {
          await request('/admin/me');
          await loadDashboard();
        } catch {
          authStatus.textContent = 'Admin session required.';
          loginForm.classList.remove('hidden');
          setAuthenticatedView(false);
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
          authStatus.textContent = 'Admin session required.';
          loginForm.classList.remove('hidden');
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
          appStatus.textContent = id ? 'App updated.' : ('App created. Save this key now: ' + response.apiKey);
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
        loginForm.classList.remove('hidden');
        setAuthenticatedView(false);
      });
    </script>
  </body>
</html>`;
}
