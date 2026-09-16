/** Static admin shell: no embedded identity or login secrets. */
export const codexAccountHtml = `
<section class="panel section" id="codex-account-section" lang="it">
  <details id="codex-account-panel"><summary>Codex · login, token e quota</summary>
    <p class="section-copy">Inferenza testuale con il tuo account Codex. Nessun MCP, browser sul server o strumento di coding. Abilita Codex nelle singole app e scegli modello e thinking.</p>
    <p id="codex-account-state" role="status" aria-live="polite">Premi Verifica account.</p>
    <div class="button-row">
      <button type="button" class="secondary" data-codex-action="refresh">Verifica account</button>
      <button type="button" class="secondary" data-codex-action="login">Accedi con codice dispositivo</button>
      <button type="button" class="secondary" data-codex-action="login/cancel">Annulla login</button>
      <button type="button" class="secondary" data-codex-action="usage">Leggi token e quota</button>
      <button type="button" class="danger" data-codex-action="logout">Scollega solo Codex</button>
    </div>
    <div id="codex-account-login" class="hidden" role="status">
      <p>Apri il link nel tuo browser abituale e inserisci il codice. Non incollarlo in una chat.</p>
      <a id="codex-account-login-url" target="_blank" rel="noopener noreferrer">Pagina ufficiale di accesso</a>
      <p>Codice temporaneo: <code id="codex-account-login-code"></code></p>
      <p id="codex-account-login-expiry"></p>
    </div>
    <div id="codex-account-provider" aria-live="polite"></div>
    <p class="footer-note">Quota condivisa con gli altri utilizzi dell’account. Residuo in token/richieste: non esposto dal servizio. I token GemRouter includono il contesto interno Codex. Cache e reasoning sono sottoinsiemi: non vanno sommati di nuovo.</p>
    <details><summary>Consumi dell’intero account (lettura manuale)</summary><pre id="codex-account-usage" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>
    <p id="codex-account-message" role="status" aria-live="polite"></p>
  </details>
</section>`;
export const codexAccountScript = String.raw`
      const codexPanel = document.getElementById('codex-account-panel');
      const codexText = function(id, value) { document.getElementById('codex-account-' + id).textContent = value; };
      let codexLoginTimer = null, codexExpiryTimer = null, codexBusy = false, codexEpoch = 0;
      function clearCodexLogin() {
        clearTimeout(codexLoginTimer); clearTimeout(codexExpiryTimer);
        codexLoginTimer = codexExpiryTimer = null;
        codexText('login-code', ''); codexText('login-expiry', '');
        document.getElementById('codex-account-login-url').removeAttribute('href');
        document.getElementById('codex-account-login').classList.add('hidden');
      }
      function clearCodexAccount() {
        codexEpoch++; clearCodexLogin();
        ['state', 'usage', 'message', 'provider'].forEach(function(id) { codexText(id, ''); });
      }
      function renderCodexAccount(account) {
        codexText('state', !account.enabled ? 'Disabilitato sul server: abilita GEMROUTER_CODEX_ENABLED. CLI disponibile.'
          : (account.authenticated ? 'Codex autenticato: ' + (account.email || 'account verificato') + ' · piano ' + (account.planType || 'non disponibile') : 'Account non autenticato/verificato')
          + ' · modello ' + account.requestedModel + ': ' + (account.modelAvailable ? 'nel catalogo' : 'non verificato/disponibile')
          + (account.reasonCode ? ' · ' + account.reasonCode : ''));
      }
      async function loadCodexAccount() {
        if (!state.authenticated) return clearCodexAccount();
        const epoch = codexEpoch;
        try {
          const data = await request('/admin/codex/account');
          if (state.authenticated && epoch === codexEpoch) { renderCodexAccount(data.account); renderCodexProvider(data.provider); }
        } catch (error) { if (state.authenticated && epoch === codexEpoch) codexText('message', error.message); }
      }
      function renderCodexProvider(provider) {
        const target = document.getElementById('codex-account-provider');
        if (!provider) { target.textContent = 'Provider non configurato.'; return; }
        const number = function(value) { return typeof value === 'number' ? value.toLocaleString() : 'n/d'; };
        const totals = provider.metrics && provider.metrics.totals || {};
        const quota = provider.quota;
        let html = '<h4>Quota account</h4><p class="footer-note">' + (quota ? 'Rilevata: ' + escapeHtml(new Date(quota.observedAt).toLocaleString()) : 'Quota non disponibile') + (provider.quotaStale ? ' · dato assente o non aggiornato' : '') + '</p>';
        (quota && quota.buckets || []).forEach(function(bucket) {
          html += '<div class="panel section"><strong>' + escapeHtml(bucket.limitId) + '</strong>';
          ['primary', 'secondary'].forEach(function(key) {
            const w = bucket[key]; if (!w) return;
            const known = typeof w.usedPercent === 'number';
            html += '<p>Finestra ' + escapeHtml(number(w.windowDurationMins)) + ' minuti · usata ' + (known ? escapeHtml(number(w.usedPercent)) + '%' : 'n/d')
              + ' · residua ' + (known ? escapeHtml(number(Math.max(0, 100 - w.usedPercent))) + '%' : 'n/d')
              + ' · reset ' + (w.resetsAt != null ? escapeHtml(new Date(w.resetsAt * 1000).toLocaleString()) : 'n/d') + '</p>';
            if (known) html += '<progress max="100" value="' + Math.min(100, w.usedPercent) + '" aria-label="Quota usata"></progress>';
          }); html += '</div>';
        });
        html += '<h4>Richieste GemRouter → Codex</h4><p>Ricevute: ' + number(totals.received) + ' · completate: ' + number(totals.succeeded)
          + ' · quota esaurita: ' + number(totals.quotaBlocked) + ' · errori: ' + number(totals.failed) + ' · annullate: ' + number(totals.cancelled)
          + ' · in corso: ' + number(provider.inflight) + ' · in coda: ' + number(provider.queued) + '</p>'
          + '<p>Token misurati: <strong>' + number(totals.totalTokens) + '</strong> · input: ' + number(totals.inputTokens) + ' · output: ' + number(totals.outputTokens)
          + ' · input cached: ' + number(totals.cachedInputTokens) + ' · reasoning: ' + number(totals.reasoningOutputTokens) + '</p>'
          + '<p class="footer-note">Richieste con usage: ' + number(totals.usageReportedRequests) + ' · usage non disponibile: ' + number(totals.usageUnknownRequests)
          + ' · contatori dal ' + escapeHtml(provider.metrics && provider.metrics.since || 'n/d') + '. Stream: risposta bufferizzata.</p>';
        if (provider.lastError || provider.metrics && provider.metrics.storageError) html += '<p role="status">' + escapeHtml(provider.lastError || provider.metrics.storageError) + '</p>';
        html += '<h4>Modelli verificati sul tuo account</h4><div class="table-wrap"><table class="table"><thead><tr><th>Modello</th><th>Thinking disponibili</th></tr></thead><tbody>';
        (provider.models || []).forEach(function(model) { html += '<tr><td>' + escapeHtml(model.model) + '</td><td>' + escapeHtml(model.supportedReasoningEfforts.join(', ')) + '</td></tr>'; });
        html += '</tbody></table></div><p class="footer-note">Fallback: solo su quota esaurita, al primo Gemini autorizzato nell’ordine configurato. Non per errori di login o modelli inesistenti.</p>';
        target.innerHTML = html;
      }
      async function pollCodexLogin(epoch) {
        if (!state.authenticated || epoch !== codexEpoch) return;
        try {
          const login = await request('/admin/codex/account/login');
          if (!state.authenticated || epoch !== codexEpoch) return;
          clearCodexLogin();
          if (login.status !== 'pending' || login.expiresAt <= Date.now()) { codexText('message', 'Login: ' + login.status); await loadCodexAccount(); return; }
          const url = new URL(login.verificationUrl);
          if (url.protocol !== 'https:' || !['auth.openai.com','auth0.openai.com','chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Login URL non valido');
          document.getElementById('codex-account-login-url').href = url.href;
          codexText('login-code', login.userCode || '');
          codexText('login-expiry', 'Scade: ' + new Date(login.expiresAt).toLocaleString());
          document.getElementById('codex-account-login').classList.remove('hidden');
          codexExpiryTimer = setTimeout(clearCodexLogin, Math.max(0, login.expiresAt - Date.now()));
          codexLoginTimer = setTimeout(function() { pollCodexLogin(epoch); }, 2000);
        } catch (error) { if (state.authenticated && epoch === codexEpoch) { clearCodexLogin(); codexText('message', error.message); } }
      }
      codexPanel.addEventListener('click', async function(event) {
        const button = event.target.closest('[data-codex-action]');
        if (!button || !state.authenticated || codexBusy) return;
        const action = button.dataset.codexAction;
        if (action === 'logout' && !window.confirm('Scollegare Codex? Le nuove richieste GPT richiederanno un nuovo login.')) return;
        const epoch = ++codexEpoch;
        clearCodexLogin(); codexBusy = true;
        codexPanel.setAttribute('aria-busy', 'true');
        codexPanel.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
        codexText('message', 'Operazione in corso…');
        try {
          const result = await request('/admin/codex/account/' + action, { method: 'POST', body: '{}' });
          if (!state.authenticated || epoch !== codexEpoch) return;
          if (action === 'usage') codexText('usage', JSON.stringify(result, null, 2));
          if (action === 'logout') codexText('usage', '');
          if (action === 'login') await pollCodexLogin(epoch);
          await loadCodexAccount();
          if (state.authenticated && epoch === codexEpoch) codexText('message', 'Operazione conclusa. Nessuna inferenza avviata.');
        } catch (error) { if (state.authenticated && epoch === codexEpoch) codexText('message', error.message); }
        finally { codexBusy = false; codexPanel.removeAttribute('aria-busy'); codexPanel.querySelectorAll('button').forEach(function(b) { b.disabled = false; }); }
      });
`;
