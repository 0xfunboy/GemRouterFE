/** Static shell contains no private conversation URL, account or login code. */
export const personalControlHtml = `
<div id="personal-control" class="chatgpt-wizard" lang="it" aria-labelledby="personal-control-title">
  <h4 id="personal-control-title">Riattiva la tua chat personale</h4>
  <p class="section-copy">Codex controlla la chat; solo la chat restituisce l’inferenza tramite MCP. Il grant già esistente non viene sostituito.</p>
  <div id="personal-control-state" class="chatgpt-note" role="status" aria-live="polite">Verifica configurazione del controllore…</div>
  <ol class="chatgpt-instructions">
    <li><strong>Collega Codex</strong><p id="personal-control-account">Account non verificato.</p>
      <div class="button-row"><button type="button" class="secondary" data-personal-action="runtime/refresh">Controlla Codex</button><button type="button" class="secondary" data-personal-action="runtime/login">Accedi con codice dispositivo</button><button type="button" class="secondary" data-personal-action="runtime/login/cancel">Annulla login</button></div>
      <div id="personal-control-login" class="hidden" role="status"><a id="personal-control-login-url" target="_blank" rel="noopener noreferrer">Apri pagina di accesso</a><p>Codice temporaneo: <code id="personal-control-login-code"></code></p><p id="personal-control-login-expiry"></p></div>
    </li>
    <li><strong>Seleziona la chat esistente</strong>
      <form id="personal-control-form">
        <label>Worker GemRouter<select name="workerId" required><option value="">Seleziona il worker</option></select></label>
        <label>URL della chat personale<input name="chatgptConversationUrl" type="url" required autocomplete="off" /></label>
        <label>Identità account visibile nella chat<input name="expectedAccountLabel" required maxlength="160" autocomplete="off" /></label>
        <label>Connettore selezionato nella chat<input name="expectedConnectorLabel" required maxlength="120" /></label>
        <label>Risorsa MCP di questo worker<input name="expectedMcpResource" readonly /></label>
        <label class="chatgpt-consent"><input name="operatorResourceConfirmed" type="checkbox" required /><span>Ho confrontato la risorsa con il connettore in ChatGPT. Questa è una mia dichiarazione, non una verifica automatica.</span></label>
        <div class="button-row"><button type="submit" class="primary">Salva associazione disarmata</button><button type="button" class="secondary" data-personal-action="browser/login">Apri browser dedicato per il login</button></div>
      </form>
      <p class="footer-note">Il browser si apre sull’host del controllore, non sul dispositivo che mostra questa dashboard. Occorre una sessione grafica disponibile; nessun cookie viene copiato dal tuo browser abituale.</p>
    </li>
    <li><strong>Verifica connettore e tool</strong><p>Apri la chat esatta nel browser dedicato e seleziona l’app dal composer. Devono essere disponibili gateway_open, gateway_exchange e gateway_status. Non rifare OAuth MCP per una chat stale.</p>
      <div class="button-row"><button type="button" class="secondary" data-personal-worker-action="inspect">Verifica passiva destinazione</button><button type="button" class="secondary" data-personal-worker-action="diagnostic">Invia diagnostica solo status</button></div>
    </li>
    <li><strong>Prova il collegamento</strong><p>La diagnostica verifica lo status, non una completion. “Riprendi ascolto” conserva gli handle nel contesto della chat; non crea una nuova run né un pairing.</p>
      <div class="button-row"><button type="button" class="secondary" data-personal-worker-action="resume">Riprendi ascolto</button></div>
      <details><summary>Recovery: la run è stata rilasciata o il server è stato riavviato</summary><p>Solo in questo caso avvia esplicitamente una nuova run nella stessa chat. L’operazione conserva il grant MCP e non sostituisce una run attiva. Poi ripeti la diagnostica prima di abilitare il wake.</p><button type="button" class="secondary" data-personal-worker-action="bootstrap">Avvia nuova run nella chat associata</button></details>
    </li>
    <li><strong>Abilita wake su richiesta</strong><p>Disponibile solo dopo le verifiche effettive e con run attiva recuperabile. Browser e controllore devono restare disponibili. Non vengono inviati heartbeat senza lavoro.</p>
      <div class="button-row"><button type="button" class="primary" id="personal-control-arm" data-personal-worker-action="arm" disabled>Abilita wake</button><button type="button" class="secondary" data-personal-worker-action="disarm">Disabilita wake</button><button type="button" class="danger" data-personal-worker-action="stop">Ferma controllore per questa chat</button></div>
    </li>
  </ol>
  <div id="personal-control-evidence" class="chatgpt-note" role="status" aria-live="polite"></div>
  <details><summary>Crea e collega una nuova chat personale</summary><p>Prepara un worker e un connettore dedicati con la procedura manuale qui sotto. Seleziona qui quel worker, dopo il consenso MCP. Non riutilizzare Example - Trade o il suo worker per una seconda chat indipendente.</p><p>La creazione usa i controlli UI realmente configurati, conserva la modalità e il modello scelti dall’operatore e restituisce solo l’URL osservato dopo l’invio. Non viene eseguita automaticamente dopo errori o limiti.</p><button type="button" class="secondary" data-personal-worker-action="create">Crea la chat del worker selezionato</button></details>
  <details><summary>Accesso e diagnostica del controllore</summary><p id="personal-control-runtime"></p><p>Il profilo UI deve riflettere i nomi accessibili osservati sull’account. Configurarlo non costituisce una prova live. Il login Codex, il login browser e il grant MCP sono tre accessi separati.</p><button type="button" class="danger" data-personal-action="runtime/logout">Scollega solo Codex</button></details>
  <div id="personal-control-message" role="status" aria-live="polite"></div>
</div>`;

// Runs inside the dashboard closure, reusing its authenticated request/CSRF helper.
export const personalControlScript = String.raw`
      let personalControlData = null;
      let personalControlBusy = false;
      let personalLoginTimer = null;
      let personalLoginExpiryTimer = null;
      const personalControlForm = document.getElementById('personal-control-form');
      const personalControlPanel = document.getElementById('personal-control');
      function personalControlReason(code) {
        const reasons = {
          controller_disabled: 'Il wake è disabilitato nella configurazione del server.',
          controller_not_started: 'Premi Controlla Codex per verificare il runtime dedicato.',
          controller_auth_required: 'Completa il login Codex con il codice dispositivo.',
          controller_not_authenticated: 'Verifica login, modello Codex e associazione; non rifare il pairing MCP.',
          controller_requested_model_unavailable: 'Il modello o il reasoning Codex richiesto non è nel catalogo del tuo account. Il gestore deve verificare la configurazione.',
          ui_profile_required: 'Il gestore deve calibrare il profilo dei controlli sulla UI reale di ChatGPT. Il wake resta bloccato.',
          graphical_session_required: 'Su questo server manca una sessione grafica. Il gestore deve predisporla prima di aprire il browser dedicato.',
          browser_not_open: 'Apri il browser dedicato e completa il login ChatGPT.',
          browser_not_started: 'Apri prima il browser dedicato.',
          browser_open: 'Browser dedicato aperto; identità e tool richiedono ancora la verifica.',
          browser_not_authenticated: 'Apri il browser dedicato e controlla il login della chat personale.',
          browser_authentication_required: 'Completa il login ChatGPT nel browser dedicato.',
          browser_account_mismatch: 'L’account visibile non coincide con l’associazione. Correggilo senza inviare messaggi.',
          personal_chat_mode_required: 'Seleziona la modalità Chat personale, non Work.',
          required_tools_missing: 'Il connettore deve esporre tutti e tre i tool gateway. Controlla l’app selezionata nel composer.',
          tool_approval_required: 'Manca la prova delle approvazioni richieste dai tool. Verificale nella UI ChatGPT e ripeti la diagnostica.',
          binding_changed: 'L’associazione è cambiata durante l’operazione. Ricarica i dati e ripeti le verifiche.',
          bootstrap_required: 'Non c’è una run da riprendere. Usa la recovery esplicita Avvia nuova run.',
          worker_not_enabled: 'Abilita il worker e verifica i permessi dell’app nella gestione avanzata.',
          worker_busy: 'La chat sta già elaborando o ascoltando. Attendi; non rilasciare la run per forzare l’operazione.',
          controller_busy: 'È in corso un’altra operazione del controllore. Attendi il suo esito.',
          delivery_ambiguous: 'Non è certo se il messaggio sia partito. Non reinviarlo: controlla la chat esatta e ripeti la verifica.',
          operator_stopped: 'Il controllore è stato fermato dall’operatore.',
          grant_revoked: 'Il grant MCP associato non è più valido. Controlla le autorizzazioni del worker.',
          separate_unused_worker_required: 'Per un’altra chat servono un worker mai usato e un connettore separato.',
          separate_connector_grant_required: 'Completa il consenso MCP del nuovo connettore separato.',
          personal_chat_creation_pending: 'Una creazione precedente ha esito da verificare. Controlla la chat nel browser e salva il suo URL osservato; non creare un duplicato.',
          ui_control_missing: 'Un controllo della UI non corrisponde al profilo verificato. Serve una nuova calibrazione del gestore.',
          ui_control_ambiguous: 'Più controlli corrispondono al profilo. Nessun invio eseguito: il gestore deve correggerlo.',
          composer_not_empty: 'La chat contiene una bozza. Inviala o conservala tu prima di riprovare; il controllore non la cancella.',
          chat_busy: 'La chat sta generando una risposta. Attendi la fine; il controllore non preme Stop.'
        };
        return reasons[code] || code || '';
      }
      function clearPersonalControl() {
        if (personalLoginTimer) clearTimeout(personalLoginTimer);
        if (personalLoginExpiryTimer) clearTimeout(personalLoginExpiryTimer);
        personalLoginTimer = personalLoginExpiryTimer = null;
        personalControlData = null;
        personalControlForm.reset();
        personalControlForm.elements.workerId.replaceChildren(new Option('Seleziona il worker', ''));
        ['personal-control-login-code','personal-control-login-expiry','personal-control-account','personal-control-evidence','personal-control-runtime','personal-control-message'].forEach(function(id) { document.getElementById(id).textContent = ''; });
        document.getElementById('personal-control-login-url').removeAttribute('href');
        document.getElementById('personal-control-login').classList.add('hidden');
        document.getElementById('personal-control-arm').disabled = true;
      }
      function renderPersonalBinding(fill) {
        if (!personalControlData) return;
        const id = personalControlForm.elements.workerId.value;
        const target = personalControlData.workers.find(function(w) { return w.id === id; });
        const binding = personalControlData.bindings.find(function(b) { return b.workerId === id; });
        if (fill) {
          personalControlForm.elements.chatgptConversationUrl.value = binding ? binding.chatgptConversationUrl : personalControlData.suggestedConversationUrl || '';
          personalControlForm.elements.expectedConnectorLabel.value = binding ? binding.expectedConnectorLabel : personalControlData.suggestedConnectorLabel || '';
          personalControlForm.elements.expectedAccountLabel.value = binding ? binding.expectedAccountLabel : '';
          personalControlForm.elements.operatorResourceConfirmed.checked = Boolean(binding && binding.operatorResourceConfirmed);
        }
        personalControlForm.elements.expectedMcpResource.value = target ? target.mcpResource : '';
        const yes = function(v) { return v ? 'verificato' : 'non verificato'; };
        document.getElementById('personal-control-evidence').textContent = binding
          ? 'Destinazione: ' + yes(binding.targetVerified) + ' · tre tool: ' + yes(binding.toolSetVerified) + ' · status MCP correlato: ' + yes(binding.gatewayStatusVerified) + ' · approvazioni write: ' + yes(binding.writeApprovalVerified) + ' · wake: ' + (binding.wakeEnabled ? 'abilitato' : 'disarmato') + ' · ultima verifica: ' + (binding.lastTargetVerifiedAt || 'mai') + ' · ultimo wake: ' + (binding.lastWakeOutcome || 'nessuno') + ' · motivo: ' + (binding.lastWakeReason || 'nessuno') + ' · ultimo poll: ' + (binding.lastPollingObservedAt || 'mai') + ' · ultima completion: ' + (target && target.lastSuccessfulCompletionAt || 'mai')
          : 'Nessuna associazione verificata. Il grant MCP esistente resta invariato.';
        document.getElementById('personal-control-arm').disabled = personalControlBusy || !(binding && binding.targetVerified && binding.toolSetVerified && binding.gatewayStatusVerified && binding.writeApprovalVerified && personalControlData.ready);
      }
      async function loadPersonalControl() {
        if (!state.authenticated) return clearPersonalControl();
        try {
          const data = await request('/admin/chatgpt/control');
          if (!state.authenticated) return clearPersonalControl();
          const first = personalControlData === null;
          personalControlData = data;
          const selected = personalControlForm.elements.workerId.value;
          const select = personalControlForm.elements.workerId;
          select.replaceChildren(new Option('Seleziona il worker', ''));
          data.workers.forEach(function(w) { select.add(new Option(w.label + ' · ' + w.id, w.id)); });
          select.value = selected || data.suggestedWorkerId || '';
          document.getElementById('personal-control-state').textContent = data.enabled ? 'Controllo UI sperimentale. ' + (personalControlReason(data.reason) || 'Configurazione disponibile; verifiche live distinte sotto.') : 'Wake disabilitato sul server. Il gestore può predisporre il controllore locale senza modificare il pairing MCP.';
          document.getElementById('personal-control-account').textContent = data.account.authenticated ? 'Codex autenticato: ' + (data.account.email || 'account verificato') : 'Login Codex richiesto. Nessuna API key da incollare.';
          document.getElementById('personal-control-runtime').textContent = 'Codex: ' + (data.account.runtimeVersion || 'non rilevato') + ' · modello richiesto: ' + data.account.requestedModel + ' (' + (data.account.modelAvailable ? 'disponibile' : 'non verificato o non disponibile') + ') · modalità: browser · nativo: non verificato · host: ' + personalControlReason(data.hostState);
          renderPersonalBinding(first);
        } catch (error) { document.getElementById('personal-control-state').textContent = personalControlReason(error.message); }
      }
      async function pollPersonalLogin() {
        if (!state.authenticated) return clearPersonalControl();
        try {
          const login = await request('/admin/chatgpt/control/runtime/login');
          if (!state.authenticated) return clearPersonalControl();
          const pending = login.status === 'pending';
          const region = document.getElementById('personal-control-login');
          region.classList.toggle('hidden', !pending);
          document.getElementById('personal-control-login-code').textContent = pending ? login.userCode || '' : '';
          const link = document.getElementById('personal-control-login-url');
          link.removeAttribute('href');
          if (pending) {
            const url = new URL(login.verificationUrl || login.authUrl);
            if (url.protocol === 'https:' && ['auth.openai.com','chatgpt.com','openai.com'].includes(url.hostname) && !url.username && !url.password) link.href = url.href;
            document.getElementById('personal-control-login-expiry').textContent = 'Scade: ' + new Date(login.expiresAt).toLocaleString();
            if (personalLoginExpiryTimer) clearTimeout(personalLoginExpiryTimer);
            personalLoginExpiryTimer = setTimeout(function() { document.getElementById('personal-control-login-code').textContent = ''; link.removeAttribute('href'); region.classList.add('hidden'); }, Math.max(0, new Date(login.expiresAt).getTime() - Date.now()));
            personalLoginTimer = setTimeout(pollPersonalLogin, 2000);
          } else await loadPersonalControl();
        } catch (error) { document.getElementById('personal-control-login-code').textContent = ''; document.getElementById('personal-control-login-url').removeAttribute('href'); document.getElementById('personal-control-login').classList.add('hidden'); document.getElementById('personal-control-message').textContent = personalControlReason(error.message); }
      }
      async function personalControlAction(action, body) {
        if (personalControlBusy || !state.authenticated) return;
        personalControlBusy = true;
        personalControlPanel.setAttribute('aria-busy','true');
        personalControlPanel.querySelectorAll('button').forEach(function(button) { button.disabled = true; });
        try {
          const result = await request('/admin/chatgpt/control/' + action, { method: 'POST', body: JSON.stringify(body || {}) });
          if (!state.authenticated) return;
          document.getElementById('personal-control-message').textContent = result.message || 'Operazione conclusa. Consulta le prove separate: un messaggio consegnato non è una completion.';
          if (result.evidence && result.evidence.evidenceSource === 'accessible_ui') {
            document.getElementById('personal-control-message').textContent += ' Osservazione UI: ' + result.evidence.chatgptConversationUrl + ' · account: ' + result.evidence.observedAccountLabel + ' · tool: ' + result.evidence.observedTools.join(', ') + '. L’associazione viene verificata e salvata solo dalla diagnostica MCP correlata.';
          }
          if (action === 'runtime/login') await pollPersonalLogin();
          await loadPersonalControl();
        } catch (error) { document.getElementById('personal-control-message').textContent = personalControlReason(error.message); }
        finally { personalControlBusy = false; personalControlPanel.removeAttribute('aria-busy'); personalControlPanel.querySelectorAll('button').forEach(function(button) { button.disabled = false; }); renderPersonalBinding(false); }
      }
      personalControlForm.elements.workerId.addEventListener('change', function() { renderPersonalBinding(true); });
      personalControlForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        if (personalControlBusy) return;
        personalControlBusy = true;
        try {
          const f = personalControlForm.elements;
          const existing = personalControlData && personalControlData.bindings.find(function(b) { return b.workerId === f.workerId.value; });
          await request('/admin/chatgpt/control/bindings/' + encodeURIComponent(f.workerId.value), {method:'PUT',body:JSON.stringify({chatgptConversationUrl:f.chatgptConversationUrl.value, expectedAccountLabel:f.expectedAccountLabel.value, expectedConnectorLabel:f.expectedConnectorLabel.value, operatorResourceConfirmed:f.operatorResourceConfirmed.checked, expectedBindingVersion:existing ? existing.bindingVersion : 0})});
          document.getElementById('personal-control-message').textContent = 'Associazione salvata disarmata. Il grant MCP non è stato modificato.';
          await loadPersonalControl();
        } catch (error) { document.getElementById('personal-control-message').textContent = personalControlReason(error.message); }
        finally { personalControlBusy = false; renderPersonalBinding(false); }
      });
      personalControlPanel.addEventListener('click', function(event) {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.personalAction) {
          const action = button.dataset.personalAction;
          if (action === 'runtime/logout' && !window.confirm('Scollegare solo il controllore Codex e disarmare i wake? Il grant MCP resta attivo.')) return;
          return personalControlAction(action, action === 'runtime/login' ? {mode:'device'} : {});
        }
        const action = button.dataset.personalWorkerAction;
        const id = personalControlForm.elements.workerId.value;
        if (!action || !id) return;
        if (['diagnostic','resume','bootstrap','arm','create','stop'].includes(action) && !window.confirm(action === 'create' ? 'Creare una vera chat personale con il worker separato selezionato? La prima chat non verrà modificata.' : action === 'bootstrap' ? 'Avviare una nuova run nella stessa chat? Usa questa recovery solo dopo release o riavvio; una run attiva non sarà sostituita.' : 'Confermi questa operazione amministrativa sulla chat associata? Non sarà modificato il grant MCP.')) return;
        const body = {confirm:true};
        if (action === 'create') {
          body.expectedAccountLabel = personalControlForm.elements.expectedAccountLabel.value;
          body.expectedConnectorLabel = personalControlForm.elements.expectedConnectorLabel.value;
          body.operatorResourceConfirmed = personalControlForm.elements.operatorResourceConfirmed.checked;
        } else {
          const binding = personalControlData && personalControlData.bindings.find(function(b) { return b.workerId === id; });
          if (!binding) { document.getElementById('personal-control-message').textContent = 'Salva prima l’associazione disarmata.'; return; }
          body.expectedBindingVersion = binding.bindingVersion;
        }
        personalControlAction('bindings/' + encodeURIComponent(id) + '/' + action, body);
      });
`;
