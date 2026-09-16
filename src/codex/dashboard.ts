/** Static shells: no embedded identity, profile paths or login secrets. */
export const codexQuotaHtml = `
<section class="panel section" id="codex-quota-section" lang="en">
  <div class="section-head"><div><h3 class="section-title">Codex Token Quota</h3>
    <p class="section-copy">Reported account quota windows, including 5-hour usage when above zero. Shared with other Codex activity; remaining tokens and requests are not exposed.</p></div>
    <div class="meta-row" id="codex-quota-pills"></div></div>
  <div class="table-wrap"><table class="table responsive-table quota-table codex-quota-table">
    <thead><tr><th>Account / quota</th><th>Remaining</th><th>Next reset</th><th>Used / total</th><th>Usage</th></tr></thead>
    <tbody id="codex-quota-rows"><tr><td colspan="5" class="muted">Loading account quota…</td></tr></tbody>
  </table></div>
</section>`;

export const codexAccountHtml = `
<section class="panel section" id="codex-account-section" lang="en">
  <div class="section-head"><div><h3 class="section-title">Codex Backend Routing</h3>
    <p class="section-copy">Account-based text inference. Enable Codex per app, then choose a model and thinking level.</p></div>
    <div class="section-head-actions"><div class="meta-row" id="codex-account-pills"></div>
      <button type="button" class="secondary section-toggle" data-section-toggle="codex-account-panel" aria-controls="codex-account-panel" aria-expanded="false">
        <span class="section-toggle-label">Expand</span><span class="section-toggle-arrow" aria-hidden="true">▸</span>
      </button></div></div>
  <div id="codex-account-panel" class="section-body hidden">
    <div class="codex-account-controls">
      <label>Account to manage<select id="codex-account-select" aria-label="Account to manage"></select></label>
      <div class="button-row"><button type="button" class="secondary" data-codex-action="add">Add account</button>
        <button type="button" data-codex-action="select">Select account for routing</button></div>
    </div>
    <p id="codex-account-state" role="status" aria-live="polite">Loading account status…</p>
    <p class="footer-note">Selecting an account applies to new requests from all Codex-enabled apps. In-flight requests keep their original account. Both logins are stored separately; no login is needed when switching connected accounts.</p>
    <div class="button-row">
      <button type="button" class="secondary" data-codex-action="refresh">Verify account</button>
      <button type="button" class="secondary" data-codex-action="login">Connect with device code</button>
      <button type="button" class="secondary" data-codex-action="login/cancel">Cancel login</button>
      <button type="button" class="secondary" data-codex-action="usage">Read account usage</button>
      <button type="button" class="warn" data-codex-action="logout">Disconnect this account</button>
    </div>
    <div id="codex-account-login" class="mono-box hidden" role="status">
      <p>Open the official link in your own browser. Use the account you want to connect and enter the code there, never in a chat.</p>
      <a id="codex-account-login-url" class="codex-login-link" target="_blank" rel="noopener noreferrer">Open official login page ↗</a>
      <p>Temporary code: <code id="codex-account-login-code"></code></p><p id="codex-account-login-expiry"></p>
    </div>
    <div id="codex-account-provider" aria-live="polite"></div>
    <p class="footer-note">On quota exhaustion only, fallback uses the first authorized Gemini model in the configured order. Login errors and unavailable models do not trigger fallback. Account switching is manual, not an automatic quota-rotation policy.</p>
    <p class="footer-note">GemRouter token counts include the Codex internal context. Cached input and reasoning tokens are subsets, not extra tokens. Streaming is buffered.</p>
    <details class="codex-usage-details"><summary>Whole-account token activity · optional, not the remaining quota</summary>
      <div id="codex-account-usage" class="mono-box">Use “Read account usage” to fetch account-wide activity without blocking this page.</div></details>
    <p id="codex-account-message" role="status" aria-live="polite"></p>
  </div>
</section>`;

export const codexAccountScript = String.raw`
      const codexPanel = document.getElementById('codex-account-panel');
      const codexSelect = document.getElementById('codex-account-select');
      const codexText = function(id, value) { document.getElementById('codex-account-' + id).textContent = value; };
      const codexNumber = function(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : 'n/a'; };
      const codexDate = function(value) { return value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('en-GB') : 'not reported'; };
      function codexCountdown(resetAt) {
        const remaining = resetAt - Date.now();
        if (remaining <= 0) return 'Reset due · awaiting quota refresh';
        const minutes = Math.ceil(remaining / 60000), hours = Math.floor(minutes / 60);
        return hours + 'h ' + (minutes % 60) + ' min';
      }
      function codexReset(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime())) return 'not reported';
        const resetAt = seconds * 1000;
        return escapeHtml(codexDate(resetAt)) + '<div class="footer-note" data-codex-reset-at="' + resetAt + '">' + codexCountdown(resetAt) + '</div>';
      }
      setInterval(function() {
        document.querySelectorAll('[data-codex-reset-at]').forEach(function(node) {
          node.textContent = codexCountdown(Number(node.dataset.codexResetAt));
        });
      }, 1000);
      let codexLoginTimer = null, codexExpiryTimer = null, codexUsageTimer = null, codexBusy = false, codexEpoch = 0, codexSnapshot = null;
      function codexMeter(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '<span class="muted">Not reported</span>';
        const bounded = Math.max(0, Math.min(100, value));
        return '<div class="quota-meter ' + (bounded >= 100 ? 'bad' : bounded > 75 ? 'warn' : '') + '" role="progressbar" aria-label="Quota used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + bounded + '"><span style="width:' + bounded + '%"></span></div>';
      }
      function codexQuotaRows(accounts) {
        return accounts.map(function(account) {
          if (!account.quotas.length) return '<tr><td data-label="Account / quota"><strong>' + escapeHtml(account.alias) + '</strong></td><td colspan="4" class="muted">' + (!account.authenticated ? 'Not connected' : account.stale ? 'Quota unavailable / stale' : 'No non-zero 5-hour or other quota windows reported') + '</td></tr>';
          return account.quotas.map(function(quota) {
          const w = quota.window, used = w && w.usedPercent, known = typeof used === 'number';
          return '<tr><td data-label="Account / quota"><strong>' + escapeHtml(account.alias) + '</strong> <span class="chip">' + escapeHtml(quota.limitId) + '</span>'
            + '<div class="footer-note">' + (account.active ? 'Selected · ' : '') + (!account.authenticated ? 'Not connected' : account.stale ? 'Stale / unavailable' : 'Updated ' + escapeHtml(codexDate(account.observedAt))) + '</div></td>'
            + '<td data-label="Remaining">' + (known ? codexNumber(Math.max(0, 100 - used)) + '%' : 'n/a') + '</td>'
            + '<td data-label="Next reset">' + codexReset(w && w.resetsAt) + '</td>'
            + '<td data-label="Used / total">' + (known ? codexNumber(used) + '% / 100%' : 'n/a') + '<div class="footer-note">' + (w && w.windowDurationMins != null ? w.windowDurationMins === 10080 ? 'Weekly window' : codexNumber(w.windowDurationMins / 60) + ' hour window' : 'Window not reported') + '</div></td>'
            + '<td data-label="Usage">' + codexMeter(used) + '</td></tr>';
        }).join(''); }).join('');
      }
      async function loadCodexQuota() {
        try {
          const data = await request('/dashboard/codex-quota');
          document.getElementById('codex-quota-rows').innerHTML = codexQuotaRows(data.accounts || []);
          document.getElementById('codex-quota-pills').innerHTML = '<span class="chip">Accounts ' + (data.accounts || []).filter(function(a) { return a.authenticated; }).length + '/2</span>'
            + '<span class="chip ' + (data.enabled ? 'good' : 'warn') + '">' + (data.enabled ? 'Codex enabled' : 'Codex disabled') + '</span>';
        } catch { document.getElementById('codex-quota-rows').innerHTML = '<tr><td colspan="5" class="muted">Quota unavailable. Next automatic refresh will retry.</td></tr>'; }
      }
      function clearCodexLogin() {
        clearTimeout(codexLoginTimer); clearTimeout(codexExpiryTimer);
        codexLoginTimer = codexExpiryTimer = null;
        codexText('login-code', ''); codexText('login-expiry', '');
        document.getElementById('codex-account-login-url').removeAttribute('href');
        document.getElementById('codex-account-login').classList.add('hidden');
      }
      function clearCodexAccount() {
        codexEpoch++; clearCodexLogin(); clearTimeout(codexUsageTimer); codexSnapshot = null; codexSelect.innerHTML = '';
        ['state', 'usage', 'message', 'provider', 'pills'].forEach(function(id) { codexText(id, ''); });
      }
      function codexButtons() {
        const a = codexSnapshot && codexSnapshot.account;
        codexPanel.querySelectorAll('[data-codex-action]').forEach(function(button) {
          const action = button.dataset.codexAction;
          button.disabled = codexBusy || !a || !a.enabled
            || (action === 'add' && codexSnapshot.accounts.length >= 2)
            || (action === 'select' && (!a.inferenceAvailable || a.id === codexSnapshot.selectedAccountId))
            || (action === 'login' && a.authenticated) || (['logout','usage'].includes(action) && !a.authenticated);
        });
        codexSelect.disabled = codexBusy;
      }
      function renderCodexAccount(data) {
        codexSnapshot = data;
        codexSelect.innerHTML = data.accounts.map(function(a) { return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.alias) + (a.id === data.selectedAccountId ? ' · selected' : '') + '</option>'; }).join('');
        codexSelect.value = data.account.id;
        const a = data.account, connected = data.accounts.filter(function(a) { return a.authenticated; }).length;
        codexText('state', !a.enabled ? 'Codex is disabled on this server.' : a.alias + ' · ' + (a.authenticated ? 'Connected · plan ' + (a.planType || 'not reported') : 'Not connected') + (a.reasonCode ? ' · ' + a.reasonCode : ''));
        document.getElementById('codex-account-pills').innerHTML = '<span class="chip ' + (connected ? 'good' : 'warn') + '">Codex OAuth ' + (connected ? 'available' : 'not connected') + '</span><span class="chip">Accounts ' + connected + '/2</span>'
          + '<span class="chip">' + escapeHtml((data.accounts.find(function(a) { return a.id === data.selectedAccountId; }) || {}).alias || 'No selection') + '</span>';
        renderCodexProvider(data.provider); renderCodexUsage(data.usage); codexButtons();
      }
      async function loadCodexAccount() {
        if (!state.authenticated) return clearCodexAccount();
        const epoch = codexEpoch, id = codexSelect.value;
        try {
          const data = await request('/admin/codex/account' + (id ? '?accountId=' + encodeURIComponent(id) : ''));
          if (state.authenticated && epoch === codexEpoch) renderCodexAccount(data);
        } catch (error) { if (state.authenticated && epoch === codexEpoch) codexText('message', error.message); }
      }
      function renderCodexUsage(read) {
        if (!read || read.status === 'idle') { codexText('usage', 'Use “Read account usage” to fetch optional whole-account activity.'); return; }
        if (read.status === 'pending') { codexText('usage', 'Reading account activity in the background… Quota and inference remain independent.'); return; }
        const result = read.result, summary = result && result.usage && result.usage.summary;
        codexText('usage', (summary ? 'Lifetime tokens: ' + codexNumber(summary.lifetimeTokens) + ' · peak daily tokens: ' + codexNumber(summary.peakDailyTokens) + '\nObserved: ' + codexDate(result.observedAt) : 'Whole-account token activity is not available.')
          + ((read.error || result && result.usageError) ? '\nReason: ' + (read.error || result.usageError) + '. Quota bars and GemRouter request counters still work independently.' : ''));
      }
      function renderCodexProvider(provider) {
        const target = document.getElementById('codex-account-provider');
        if (!provider) { target.textContent = 'Provider not configured.'; return; }
        const n = codexNumber, totals = provider.metrics && provider.metrics.totals || {};
        let html = '<h4>Selected account quota windows</h4><div class="table-wrap"><table class="table responsive-table"><thead><tr><th>Quota bucket</th><th>Window</th><th>Remaining</th><th>Next reset</th><th>Usage</th></tr></thead><tbody>';
        (provider.quota && provider.quota.buckets || []).forEach(function(bucket) { ['primary','secondary'].forEach(function(key) {
          const w = bucket[key]; if (!w) return;
          html += '<tr><td data-label="Quota bucket">' + escapeHtml(bucket.limitId) + '</td><td data-label="Window">' + n(w.windowDurationMins) + ' minutes</td><td data-label="Remaining">' + (typeof w.usedPercent === 'number' ? n(Math.max(0,100-w.usedPercent)) + '%' : 'n/a') + '</td><td data-label="Next reset">' + codexReset(w.resetsAt) + '</td><td data-label="Usage">' + codexMeter(w.usedPercent) + '</td></tr>';
        }); });
        html += '</tbody></table></div><p class="footer-note">' + (provider.quotaStale ? 'Quota stale or unavailable. ' : '') + 'Buckets are service-reported quota identifiers, not selectable models. codex_bengalfox is shown separately; no model mapping is assumed.</p>';
        html += '<h4>GemRouter → Codex requests · this account</h4><div class="meta-row">'
          + [['Received',totals.received],['Completed',totals.succeeded],['Quota depleted',totals.quotaBlocked],['Errors',totals.failed],['Cancelled',totals.cancelled],['In progress',provider.inflight],['Queued',provider.queued]].map(function(pair) { return '<span class="chip">' + pair[0] + ' ' + n(pair[1]) + '</span>'; }).join('') + '</div>'
          + '<p>Measured tokens: <strong>' + n(totals.totalTokens) + '</strong> · input ' + n(totals.inputTokens) + ' · output ' + n(totals.outputTokens) + ' · cached input ' + n(totals.cachedInputTokens) + ' · reasoning ' + n(totals.reasoningOutputTokens) + '</p>'
          + '<p class="footer-note">Requests with usage: ' + n(totals.usageReportedRequests) + ' · usage unavailable: ' + n(totals.usageUnknownRequests) + ' · counted since ' + escapeHtml(codexDate(provider.metrics && provider.metrics.since)) + '</p>';
        if (provider.lastError || provider.metrics && provider.metrics.storageError) html += '<p role="status">' + escapeHtml(provider.lastError || provider.metrics.storageError) + '</p>';
        html += '<h4>Models verified on this account</h4><div class="table-wrap"><table class="table"><thead><tr><th>Model</th><th>Available thinking levels</th></tr></thead><tbody>';
        (provider.models || []).forEach(function(model) { html += '<tr><td>' + escapeHtml(model.model) + '</td><td>' + escapeHtml(model.supportedReasoningEfforts.join(', ')) + '</td></tr>'; });
        target.innerHTML = html + '</tbody></table></div>';
      }
      async function pollCodexUsage(epoch, id) {
        if (!state.authenticated || epoch !== codexEpoch) return;
        try {
          const read = await request('/admin/codex/account/usage?accountId=' + encodeURIComponent(id));
          if (!state.authenticated || epoch !== codexEpoch) return;
          renderCodexUsage(read);
          if (read.status === 'pending') codexUsageTimer = setTimeout(function() { pollCodexUsage(epoch,id); }, 1000);
        } catch (error) { if (state.authenticated && epoch === codexEpoch) codexText('message', error.message); }
      }
      async function pollCodexLogin(epoch, id) {
        if (!state.authenticated || epoch !== codexEpoch) return;
        try {
          const login = await request('/admin/codex/account/login?accountId=' + encodeURIComponent(id));
          if (!state.authenticated || epoch !== codexEpoch) return;
          clearCodexLogin();
          if (login.status !== 'pending' || login.expiresAt <= Date.now()) {
            codexText('message', 'Login: ' + login.status);
            if (login.status === 'completed') await request('/admin/codex/account/refresh', { method: 'POST', body: JSON.stringify({accountId:id}) });
            await loadCodexAccount(); await loadCodexQuota(); return;
          }
          const url = new URL(login.verificationUrl);
          if (url.protocol !== 'https:' || !['auth.openai.com','auth0.openai.com','chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Invalid login URL');
          document.getElementById('codex-account-login-url').href = url.href;
          codexText('login-code', login.userCode || ''); codexText('login-expiry', 'Expires: ' + codexDate(login.expiresAt));
          document.getElementById('codex-account-login').classList.remove('hidden');
          codexExpiryTimer = setTimeout(clearCodexLogin, Math.max(0, login.expiresAt - Date.now()));
          codexLoginTimer = setTimeout(function() { pollCodexLogin(epoch,id); }, 2000);
        } catch (error) { if (state.authenticated && epoch === codexEpoch) { clearCodexLogin(); codexText('message', error.message); } }
      }
      codexSelect.addEventListener('change', async function() {
        const epoch = ++codexEpoch, id = codexSelect.value;
        clearCodexLogin(); clearTimeout(codexUsageTimer); await loadCodexAccount();
        await pollCodexLogin(epoch,id); await pollCodexUsage(epoch,id);
      });
      codexPanel.addEventListener('click', async function(event) {
        const button = event.target.closest('[data-codex-action]');
        if (!button || !state.authenticated || codexBusy) return;
        const action = button.dataset.codexAction;
        if (action === 'logout' && !window.confirm('Disconnect this Codex account? Its saved login will be removed. The other account will not be changed.')) return;
        const epoch = ++codexEpoch;
        clearCodexLogin(); clearTimeout(codexUsageTimer); codexBusy = true; codexButtons();
        codexPanel.setAttribute('aria-busy', 'true'); codexText('message', 'Working…');
        let id = codexSelect.value;
        try {
          const result = await request(action === 'add' ? '/admin/codex/accounts' : '/admin/codex/account/' + action,
            { method: 'POST', body: JSON.stringify(action === 'add' ? {} : {accountId:id}) });
          if (!state.authenticated || epoch !== codexEpoch) return;
          if (action === 'add') {
            renderCodexAccount(result); id = result.account.id;
            await request('/admin/codex/account/login', { method:'POST', body:JSON.stringify({accountId:id}) });
          }
          if (!state.authenticated || epoch !== codexEpoch) return;
          await loadCodexAccount(); await loadCodexQuota();
          if (!state.authenticated || epoch !== codexEpoch) return;
          codexText('message', action === 'select' ? 'Account selected for new requests. No login needed.' : 'Done. No inference started.');
          if (action === 'usage') await pollCodexUsage(epoch,id);
          if (action === 'login' || action === 'add') await pollCodexLogin(epoch,id);
        } catch (error) { if (state.authenticated && epoch === codexEpoch) codexText('message', error.message); }
        finally { codexBusy = false; codexPanel.removeAttribute('aria-busy'); codexButtons(); }
      });
`;
