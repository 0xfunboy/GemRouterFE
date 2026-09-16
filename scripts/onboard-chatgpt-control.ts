/** Real, temporary operator onboarding. Does NOT import/start a gateway/store,
 * read worker credentials, own a queue, or provide an inference endpoint. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { readPersonalControlConfig } from '../src/llm/providers/chatgpt/control/config.js';
import { CodexRuntime } from '../src/llm/providers/chatgpt/control/codexRuntime.js';
import { BrowserUiBridge, browserUiProfileSchema, type BrowserDeliveryEvidence } from '../src/llm/providers/chatgpt/control/browserBridge.js';
import { controlInstruction, diagnosticPrompt } from '../src/llm/providers/chatgpt/control/prompts.js';
import type { ChatGptControlBinding } from '../src/llm/providers/chatgpt/control/types.js';

const config = readPersonalControlConfig({ ...process.env, GEMROUTER_CHATGPT_CONTROL_ENABLED: 'true' });
const port = Number(process.env.GEMROUTER_ONBOARDING_PORT || 8796);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid onboarding port.');
const origin = `http://127.0.0.1:${port}`;
const target = {
  workerId: 'worker-000000007c41d5e30ad0',
  chatgptConversationUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582',
  expectedConnectorLabel: 'Example - Trade',
  expectedMcpResource: 'https://gemrouter.example.com/mcp/chatgpt/worker-000000007c41d5e30ad0',
};
mkdirSync(config.privateDirectory, { recursive: true, mode: 0o700 });
const privateStat = statSync(config.privateDirectory);
if (privateStat.uid !== process.getuid?.() || (privateStat.mode & 0o077) !== 0 || realpathSync(config.privateDirectory) !== config.privateDirectory) throw new Error('Private onboarding directory must be owner-only, without symlinks.');
const uiProfilePath = config.uiProfilePath || path.join(config.privateDirectory, 'observed-ui-profile.json');
const runtime = new CodexRuntime({ enabled: true, command: config.command, profileDirectory: config.codexProfile,
  requestedModel: config.requestedModel, reasoningEffort: config.reasoningEffort,
  turnTimeoutMs: config.operationTimeoutMs, excludedDirectories: [process.cwd()] });
const browser = new BrowserUiBridge({ profileDirectory: config.browserProfile, executablePath: config.browserExecutable,
  operationTimeoutMs: config.operationTimeoutMs, excludedDirectories: [process.cwd()] });
const accessKey = randomBytes(32).toString('base64url');
const accessHash = createHash('sha256').update(accessKey).digest();
const accessFile = path.join(config.privateDirectory, 'onboarding-access.txt');
const receiptFile = path.join(config.privateDirectory, 'onboarding-evidence.json');
const sessions = new Map<string, { csrf: string; expires: number }>();
const expiresAt = Date.now() + 2 * 60 * 60_000;
let diagnosticBusy = false;
let lastEvidence: Record<string, unknown> | null = null;
const code = (error: unknown) => {
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'onboarding_operation_failed';
  return /^[a-z][a-z0-9_]{1,79}$/u.test(value) ? value : 'onboarding_operation_failed';
};
const fail = (reason: string): never => { throw Object.assign(new Error(), { code: reason }); };
function configuredDisplay(): { display: string; xauthority: string } | null {
  // Metadata is a configuration hint, never proof that Xvfb or a viewer is alive.
  // Read no cookies, Xauthority content or viewer credentials.
  const statePath = path.join(config.privateDirectory, 'display', 'state.json');
  try {
    const metadata = statSync(statePath);
    if (!metadata.isFile() || metadata.size > 4096 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0 || realpathSync(statePath) !== statePath) return null;
    const display = JSON.parse(readFileSync(statePath, 'utf8'));
    if (typeof display.display !== 'string' || !/^:[1-9][0-9]{1,3}$/u.test(display.display)
      || display.xauthority !== path.join(config.privateDirectory, 'display', 'Xauthority')) return null;
    return { display: display.display, xauthority: display.xauthority };
  } catch { return null; }
}
function observedProfileFileAvailable(): boolean {
  try { const metadata = statSync(uiProfilePath); return metadata.isFile() && metadata.size <= 32_768; }
  catch { return false; }
}
const app = Fastify({ logger: false, bodyLimit: 8192 });
app.addHook('onRequest', async (request, reply) => {
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache').header('referrer-policy', 'no-referrer')
    .header('x-frame-options', 'DENY').header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) return reply.code(403).send({ error: 'host_not_allowed' });
  if (request.method !== 'GET' && request.headers.origin !== origin && request.headers.origin !== `http://localhost:${port}`) return reply.code(403).send({ error: 'origin_not_allowed' });
  if (Date.now() >= expiresAt) return reply.code(410).send({ error: 'onboarding_expired' });
  if (request.url === '/' || request.url === '/session' && request.method === 'POST') return;
  const sessionId = /(?:^|;\s*)gemrouter_onboarding=([a-zA-Z0-9_-]{43})(?:;|$)/u.exec(request.headers.cookie ?? '')?.[1];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.expires <= Date.now()) return reply.code(401).send({ error: 'operator_login_required' });
  if (request.method !== 'GET' && request.headers['x-onboarding-csrf'] !== session.csrf) return reply.code(403).send({ error: 'csrf_required' });
  (request as typeof request & { operatorId: string; csrf: string }).operatorId = sessionId!;
  (request as typeof request & { csrf: string }).csrf = session.csrf;
});
app.setErrorHandler((error, _request, reply) => reply.code(422).send({ error: code(error) }));
const owner = (request: unknown) => (request as { operatorId: string }).operatorId;
app.post('/session', async (request, reply) => {
  const candidate = (request.body as { key?: unknown })?.key;
  const hash = createHash('sha256').update(typeof candidate === 'string' && candidate.length < 256 ? candidate : '').digest();
  if (!timingSafeEqual(hash, accessHash)) return reply.code(401).send({ error: 'invalid_operator_key' });
  if (sessions.size >= 4) return reply.code(429).send({ error: 'operator_session_limit' });
  const id = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
  sessions.set(id, { csrf, expires: expiresAt });
  reply.header('set-cookie', `gemrouter_onboarding=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);
  return { csrf };
});
app.get('/session', async (request) => ({ csrf: (request as typeof request & { csrf: string }).csrf }));
app.get('/status', async () => ({ mode: 'REAL_ONBOARDING_NO_LOCAL_GATEWAY', queueOwner: 'production; not this process', target,
  account: runtime.cachedStatus(), browserOpen: browser.launched, uiProfileConfigured: browser.uiProfileConfigured,
  runtimeReady: runtime.readyCached, diagnosticBusy,
  graphicalSessionConfigured: Boolean(configuredDisplay() || process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  observedProfileFileAvailable: observedProfileFileAvailable(),
  viewer: { url: 'http://127.0.0.1:8795/vnc.html?autoconnect=false&resize=scale', availability: 'not_checked' },
  codexProfile: config.codexProfile, browserProfile: config.browserProfile, uiProfilePath, expiresAt, lastEvidence }));
app.post('/runtime/refresh', async () => ({ account: await runtime.status(), models: runtime.cachedStatus().authenticated ? await runtime.models() : [] }));
app.post('/runtime/login', async (request) => runtime.startLogin(owner(request), 'device'));
app.get('/runtime/login', async (request) => await runtime.loginStatus(owner(request)) ?? { status: 'not_started' });
app.post('/runtime/login/cancel', async (request) => { await runtime.cancelLogin(owner(request)); return { ok: true }; });
app.post('/browser/login', async () => {
  // This file is produced only by the dedicated display launcher, not by HTTP/model arguments.
  const display = configuredDisplay();
  if (display) {
    process.env.DISPLAY = display.display; process.env.XAUTHORITY = display.xauthority;
  }
  return browser.launchLogin();
});
app.post('/browser/profile', async () => {
  if (!browser.launched) fail('browser_not_started');
  try {
    if (!observedProfileFileAvailable()) fail('ui_profile_required');
    browser.configureObservedProfile(browserUiProfileSchema.parse(JSON.parse(readFileSync(uiProfilePath, 'utf8'))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') fail('ui_profile_required');
    if (code(error) === 'onboarding_operation_failed') fail('ui_profile_invalid');
    throw error;
  }
  return { configured: true, liveVerified: false };
});
app.post('/diagnostic', async (request) => {
  const input = request.body as { confirmed?: unknown; expectedAccountLabel?: unknown };
  if (input?.confirmed !== true || typeof input.expectedAccountLabel !== 'string' || !input.expectedAccountLabel.trim() || input.expectedAccountLabel.length > 160) throw Object.assign(new Error(), { code: 'explicit_target_confirmation_required' });
  if (diagnosticBusy) throw Object.assign(new Error(), { code: 'controller_busy' });
  // Reject missing prerequisites before starting any real Codex turn. These
  // flags do not attest browser login, chat identity or a working MCP binding;
  // those remain checked by the restricted bridge during the diagnostic.
  if (!browser.launched) fail('browser_not_started');
  if (!browser.uiProfileConfigured) fail('ui_profile_required');
  if (!runtime.readyCached) fail(runtime.cachedStatus().reasonCode || 'controller_not_ready');
  diagnosticBusy = true;
  const operationId = randomUUID(); const marker = `[gemrouter-diagnostic:${operationId}]`;
  const binding = { ...target, expectedAccountLabel: input.expectedAccountLabel.trim(), operatorResourceConfirmed: true };
  const startedAt = Date.now(); const deadlineAt = startedAt + config.operationTimeoutMs;
  let evidence: BrowserDeliveryEvidence | undefined;
  let bridgeError: unknown;
  let effect: Promise<unknown> | undefined;
  let invokedAt: number | undefined;
  try {
    const result = await runtime.runControl(controlInstruction('diagnostic'), {
      name: 'gemrouter_personal_control', description: 'Perform the single operator-confirmed status-only diagnostic in the bound existing personal ChatGPT conversation. No arguments or arbitrary browser access.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async (args, signal) => {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Object.assign(new Error(), { code: 'invalid_control_arguments' });
        effect ??= (async () => {
          invokedAt = Date.now();
          try {
            await browser.inspectConfiguredTarget(binding, { signal });
            evidence = await browser.sendBoundedWake(binding, { operationId, marker, deadlineAt, diagnostic: true,
              prompt: diagnosticPrompt(binding as ChatGptControlBinding, marker) }, { signal });
            return { observed: true, inferenceCompletion: false };
          } catch (error) { bridgeError = error; throw error; }
        })();
        return effect;
      },
    }, AbortSignal.timeout(config.operationTimeoutMs));
    if (bridgeError) throw bridgeError;
    if (!evidence || !invokedAt || evidence.statusWorkerId !== target.workerId || result.toolInvocations !== 1) throw Object.assign(new Error(), { code: 'diagnostic_evidence_incomplete' });
    lastEvidence = { operationId, marker, target: target.chatgptConversationUrl, workerId: evidence.statusWorkerId,
      actualControllerModel: result.model, controllerThreadId: result.codexControllerThreadId, controllerToolInvocations: result.toolInvocations,
      startedAt: new Date(startedAt).toISOString(), bridgeInvokedAt: new Date(invokedAt).toISOString(), completedAt: new Date().toISOString(),
      statusEvidence: 'new_structured_status_observed_in_exact_chat_UI', gatewayServerCorrelation: 'not_asserted_by_standalone_onboarding',
      inferenceCompletion: false, automaticWake: false };
    writeFileSync(receiptFile, JSON.stringify(lastEvidence, null, 2) + '\n', { mode: 0o600 });
    return lastEvidence;
  } catch (error) {
    lastEvidence = { operationId, target: target.chatgptConversationUrl, outcome: 'not_verified', reasonCode: code(bridgeError ?? error),
      bridgeInvoked: Boolean(invokedAt), inferenceCompletion: false, automaticWake: false };
    throw bridgeError ?? error;
  } finally { diagnosticBusy = false; }
});
app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GemRouter — onboarding reale</title>
<style>body{font:16px/1.6 system-ui;background:#101624;color:#edf2fa;max-width:900px;margin:40px auto;padding:0 20px}section{border:1px solid #37465b;border-radius:14px;padding:20px;margin:18px 0}button,input{font:inherit;padding:10px;margin:5px;border-radius:6px}button{cursor:pointer;min-height:44px}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #65ead6;outline-offset:3px}a{color:#65ead6}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}input{max-width:90%}.feedback:not(:empty){padding:12px;border-left:3px solid #65ead6;background:#172738;border-radius:5px}.feedback[data-error="true"]{border-color:#ffa6a6;color:#ffd2d2}.readiness{color:#bacce1}.viewer{padding:14px;border:1px solid #526578;border-radius:8px}#message:not(:empty){position:sticky;top:8px;z-index:2;background:#243346;padding:12px;border-radius:8px}details{margin-top:12px}[hidden]{display:none}@media(max-width:600px){body{padding:0 12px;margin-top:20px}section{padding:16px}button{margin:5px 0;width:100%}}</style>
<h1>Onboarding reale del controllore</h1><p>Pagina temporanea privata. Nessuna coda locale, nessun deploy. Il grant Example - Trade non viene modificato.</p>
<p id="message" role="status" aria-live="polite"></p>
<section id="unlock"><h2>Accesso operatore</h2><p>Apri il link privato presente nel file onboarding-access.txt dell’host oppure incolla qui soltanto la chiave di accesso di questa pagina.</p><input id="key" type="password" autocomplete="off" aria-label="Chiave onboarding"><button id="unlockButton">Accedi alla pagina</button></section>
<main id="private" hidden><section id="runtime-section"><h2>1. Login Codex nel profilo effettivo</h2><p id="runtime-readiness" class="readiness"></p><p id="profile"></p><button data-action="runtime/refresh" data-feedback="runtime-feedback">Verifica account reale</button><button data-action="runtime/login" data-feedback="runtime-feedback">Avvia login con codice dispositivo</button><button data-action="runtime/login/cancel" data-feedback="runtime-feedback" disabled>Annulla login</button><p id="runtime-feedback" class="feedback" role="status" aria-live="polite"></p><div id="login" hidden><a id="loginUrl" target="_blank" rel="noopener noreferrer">Apri login ufficiale</a><p>Codice temporaneo: <code id="loginCode"></code></p><p id="loginExpiry"></p></div><details><summary>Dettagli del runtime</summary><pre id="account"></pre></details></section>
<section id="browser-section"><h2>2. Login nel browser dedicato</h2><p>Il browser viene aperto sul server, non in una nuova scheda di questo dispositivo. Usa un profilo distinto dal login Codex.</p><p id="browser-readiness" class="readiness"></p><button data-action="browser/login" data-feedback="browser-feedback" disabled>Apri il browser del bridge sul server</button><p id="browser-feedback" class="feedback" role="status" aria-live="polite"></p><div class="viewer"><strong>Come vedere la finestra del browser</strong><p>In VS Code → Porte inoltra la porta <strong>8795</strong> del server, mantenendo la visibilità <strong>Privata</strong>. Dopo che il gestore ha avviato il visualizzatore, apri <a href="http://127.0.0.1:8795/vnc.html?autoconnect=false&amp;resize=scale" target="_blank" rel="noopener noreferrer">il visualizzatore locale del browser</a>.</p><p>Questo link è l'indirizzo previsto, non una conferma che il visualizzatore sia disponibile. Se VS Code assegna un'altra porta locale, usa il suo comando «Apri nel browser». Inserisci l'eventuale password del visualizzatore soltanto nella sua finestra.</p><p>Login ChatGPT, MFA e consensi vanno completati personalmente nella pagina ufficiale del browser dedicato. Non inviare password qui o nella conversazione.</p></div><p id="target"></p></section>
<section id="diagnostic-section"><h2>3. Calibrazione e diagnostica reale</h2><p>Prima completa il login nel browser, apri la chat indicata e verifica Example - Trade. Il gestore deve ricavare il profilo UI dai controlli reali: questo pulsante carica un profilo già preparato, non lo crea.</p><p id="calibration-readiness" class="readiness"></p><button data-action="browser/profile" data-feedback="diagnostic-feedback" disabled>Carica il profilo UI osservato</button><p><label>Identità account visibile nella chat <input id="expectedAccount" autocomplete="off" maxlength="160"></label></p><p id="diagnostic-readiness" class="readiness"></p><button id="diagnostic" disabled>Confermo chat e connettore: Codex invia solo gateway_status</button><p id="diagnostic-feedback" class="feedback" role="status" aria-live="polite"></p><p>Questo comando avvia un turno Codex reale; solo la sua chiamata al tool ristretto può azionare il bridge. Browser aperto non significa login verificato. La diagnostica non è una prova di completion.</p></section>
<section><h2>Stato verificato</h2><pre id="status"></pre></section></main>
<script>
let csrf='',timer,loginTimer,busy=false,lastStatus=null,refreshing=false,loginState='not_started';
const $=id=>document.getElementById(id);
const errors={
  graphical_session_required:'Il display del browser non è ancora disponibile sul server. Attendi la predisposizione del gestore; non occorre ripetere il login Codex.',
  browser_not_started:'Apri prima il browser dedicato al passaggio 2. La diagnostica Codex non è stata avviata.',
  ui_profile_required:'Manca il profilo UI osservato della chat reale. Il gestore deve prepararlo dopo il login nel browser; non ripetere il login Codex.',
  ui_profile_invalid:'Il profilo UI osservato non è valido o leggibile. Chiedi al gestore di correggerlo prima della diagnostica.',
  controller_not_ready:'Il runtime Codex non è pronto. Premi «Verifica account reale» e controlla lo stato nel passaggio 1.',
  controller_auth_required:'Completa il login Codex del passaggio 1, poi verifica l’account reale.',
  controller_requested_model_unavailable:'Il modello richiesto del controllore non è disponibile per questo account. Il gestore deve verificare la configurazione; nessun modello alternativo viene selezionato.',
  controller_login_in_progress:'Il login Codex è ancora in corso. Completa la pagina ufficiale prima di continuare.',
  controller_busy:'È già in corso un’operazione Codex. Attendi il suo esito senza ripetere la richiesta.',
  browser_busy:'Il browser sta completando un’operazione. Attendi il suo esito prima di riprovare.',
  explicit_target_confirmation_required:'Inserisci l’identità dell’account che vedi nella chat dedicata e conferma il target prima della diagnostica.',
  invalid_operator_key:'Chiave di accesso non valida. Usa il link privato corrente dell’onboarding.',
  operator_login_required:'La sessione di questa pagina è terminata. Riapri il link privato corrente; il login Codex nel profilo dedicato non viene cancellato.',
  onboarding_expired:'La pagina temporanea è scaduta. Chiedi al gestore di riaprire l’onboarding, conservando i profili autenticati.',
  onboarding_operation_failed:'Operazione non riuscita. Il gestore deve controllare il prerequisito di questo passaggio. Non ripetere login o diagnostiche a tentativi.'
};
function feedback(id,text,error=false){const node=$(id||'message');node.textContent=text;node.dataset.error=String(error)}
function updateControls(){
  const s=lastStatus||{},pending=busy||s.diagnosticBusy===true;
  document.querySelectorAll('[data-action],#diagnostic').forEach(b=>{b.disabled=pending;b.setAttribute('aria-busy',String(busy))});
  $('unlockButton').disabled=busy;
  document.querySelector('[data-action="runtime/login"]').disabled=pending||loginState==='pending'||s.account?.authenticated===true;
  document.querySelector('[data-action="runtime/login/cancel"]').disabled=pending||loginState!=='pending';
  document.querySelector('[data-action="browser/login"]').disabled=pending||!(s.graphicalSessionConfigured||s.browserOpen);
  document.querySelector('[data-action="browser/profile"]').disabled=pending||!s.browserOpen||!s.observedProfileFileAvailable;
  $('diagnostic').disabled=pending||!s.runtimeReady||!s.browserOpen||!s.uiProfileConfigured||!$('expectedAccount').value.trim();
}
async function api(route,body){const r=await fetch('/'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-onboarding-csrf':csrf},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||'request_failed');return value}
function wipeLogin(){$('login').hidden=true;$('loginCode').textContent='';$('loginUrl').removeAttribute('href');$('loginExpiry').textContent=''}
async function loginStatus(){clearTimeout(loginTimer);const login=await api('runtime/login');loginState=login.status;wipeLogin();if(login.status==='pending'&&login.expiresAt>Date.now()){const u=new URL(login.verificationUrl);if(u.protocol!=='https:'||!['auth.openai.com','chatgpt.com','openai.com'].includes(u.hostname))throw Error('invalid_login_origin');$('login').hidden=false;$('loginUrl').href=u.href;$('loginCode').textContent=login.userCode;$('loginExpiry').textContent='Scade alle '+new Date(login.expiresAt).toLocaleTimeString();loginTimer=setTimeout(()=>loginStatus().catch(e=>showError(e,'runtime-feedback')),1500)}else if(login.status==='completed'){feedback('runtime-feedback','Login Codex completato e verificato dal runtime. Passa al browser dedicato: il suo login è separato.');await refresh()}updateControls()}
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try{
    const s=await api('status');lastStatus=s;
    $('profile').textContent='Profilo persistente: '+s.codexProfile;
    $('account').textContent=JSON.stringify(s.account,null,2);
    $('target').textContent='Chat da verificare personalmente: '+s.target.chatgptConversationUrl+' — '+s.target.expectedConnectorLabel;
    $('runtime-readiness').textContent=s.runtimeReady?'Account Codex verificato e runtime pronto. Non serve ripetere il login.':s.account?.authenticated?'Account Codex autenticato; verifica disponibilità del modello e stato del runtime.':'Login Codex ancora da completare.';
    $('browser-readiness').textContent=s.browserOpen?'Finestra del browser aperta sul server. Apri il visualizzatore e completa personalmente il login ChatGPT; l’autenticazione del browser non è ancora attestata.':s.graphicalSessionConfigured?'Configurazione grafica presente. Premi il pulsante per tentare l’apertura del browser sul server; la configurazione da sola non dimostra che display o visualizzatore siano in esecuzione.':'Display non predisposto: il gestore deve avviare la sessione grafica dedicata. Il pulsante si abiliterà dopo la predisposizione; il login Codex resta valido.';
    $('calibration-readiness').textContent=s.uiProfileConfigured?'Profilo UI caricato. La chat e il connettore devono ancora essere verificati dalla diagnostica.':!s.browserOpen?'Prima apri il browser dedicato e completa il login.':s.observedProfileFileAvailable?'File del profilo osservato presente: puoi caricarlo e validarlo.':'Il profilo UI osservato non è ancora presente. Il gestore deve calibrarlo sui controlli della chat reale; questo passaggio non può essere saltato.';
    $('diagnostic-readiness').textContent=s.diagnosticBusy?'Diagnostica in corso sul server. Attendi l’esito; non è necessario premere di nuovo.':!s.browserOpen||!s.uiProfileConfigured||!s.runtimeReady?'La diagnostica resta disabilitata finché runtime, browser e profilo UI non sono pronti. Nessun turno Codex viene avviato per verificare questi prerequisiti.':!$('expectedAccount').value.trim()?'Inserisci l’identità dell’account che vedi nel browser, poi conferma chat e connettore.':'Prerequisiti tecnici pronti. Conferma il target soltanto dopo averlo verificato personalmente.';
    $('status').textContent=JSON.stringify({browserOpen:s.browserOpen,graphicalSessionConfigured:s.graphicalSessionConfigured,viewerAvailability:s.viewer?.availability||'not_checked',uiProfileConfigured:s.uiProfileConfigured,runtimeReady:s.runtimeReady,diagnosticBusy:s.diagnosticBusy,queueOwner:s.queueOwner,lastEvidence:s.lastEvidence},null,2);
    updateControls();
  }finally{refreshing=false}
}
function showError(e,id){const reason=String(e?.message||'onboarding_operation_failed');const known=/^[a-z][a-z0-9_]{1,79}$/.test(reason);const text=errors[reason]||(known?'Operazione non completata ('+reason+'). Chiedi al gestore di verificare questo passaggio.':'Connessione alla pagina temporanea non disponibile. Verifica l’inoltro della porta e attendi il ripristino; non ripetere la diagnostica a tentativi.');feedback(id||'message',text,true);feedback('message',text,true);if(['operator_login_required','onboarding_expired'].includes(reason)){clearInterval(timer);clearTimeout(loginTimer);wipeLogin();lastStatus=null;loginState='not_started';$('private').hidden=true;$('unlock').hidden=false;$('key').value='';csrf='';updateControls()}}
function startPolling(){clearInterval(timer);timer=setInterval(()=>refresh().catch(e=>showError(e)),4000)}
async function unlock(){if(busy)return;busy=true;updateControls();feedback('message','Accesso alla pagina in corso…');try{const s=await api('session',{key:$('key').value});$('key').value='';csrf=s.csrf;$('unlock').hidden=true;$('private').hidden=false;feedback('message','');await refresh();startPolling();await loginStatus()}catch(e){showError(e)}finally{busy=false;updateControls()}}
$('unlockButton').onclick=unlock;
const progress={'runtime/refresh':'Verifica dell’account Codex in corso…','runtime/login':'Preparazione del login Codex nel profilo dedicato…','runtime/login/cancel':'Annullamento del login in corso…','browser/login':'Apertura del browser sul server in corso. La finestra si vedrà nel visualizzatore, non in questa scheda.','browser/profile':'Caricamento e validazione del profilo UI osservato…'};
const success={'runtime/refresh':'Verifica account terminata: leggi lo stato aggiornato qui sopra.','runtime/login':'Login predisposto: completa la pagina ufficiale con il codice temporaneo mostrato qui sotto.','runtime/login/cancel':'Login in corso annullato. Le altre sessioni non sono state disconnesse.','browser/login':'Browser aperto sul server. Inoltra la porta 8795 in VS Code e apri il visualizzatore locale indicato qui sotto. Se non risponde, il gestore deve avviare il viewer: non occorre ripetere il login Codex.','browser/profile':'Profilo UI caricato e validato. Non è ancora una verifica della chat reale; completa ora la conferma del target.'};
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{if(busy||b.disabled)return;busy=true;updateControls();feedback('message','');feedback(b.dataset.feedback,progress[b.dataset.action]);try{await api(b.dataset.action,{});feedback(b.dataset.feedback,success[b.dataset.action]);await refresh();if(b.dataset.action.startsWith('runtime/login'))await loginStatus()}catch(e){showError(e,b.dataset.feedback)}finally{busy=false;updateControls()}});
$('expectedAccount').addEventListener('input',()=>{updateControls();if(lastStatus?.runtimeReady&&lastStatus?.browserOpen&&lastStatus?.uiProfileConfigured)$('diagnostic-readiness').textContent=$('expectedAccount').value.trim()?'Prerequisiti tecnici pronti. Conferma il target soltanto dopo averlo verificato personalmente.':'Inserisci l’identità dell’account che vedi nel browser, poi conferma chat e connettore.'});
$('diagnostic').onclick=async()=>{if(busy||$('diagnostic').disabled||!confirm('Inviare tramite Codex una sola diagnostica gateway_status nella chat personale esatta? Nessun job o altra chat.'))return;busy=true;updateControls();feedback('message','');feedback('diagnostic-feedback','Diagnostica reale in corso: Codex sta eseguendo il controllo ristretto. Attendi l’esito senza ripetere il clic o modificare la chat.');try{await api('diagnostic',{confirmed:true,expectedAccountLabel:$('expectedAccount').value});feedback('diagnostic-feedback','Diagnostica conclusa: nuova evidenza osservata nella chat prevista. Non è una completion di inferenza.');await refresh()}catch(e){showError(e,'diagnostic-feedback');try{await refresh()}catch(refreshError){showError(refreshError)}}finally{busy=false;updateControls()}};
async function resumeSession(){const s=await api('session');csrf=s.csrf;$('unlock').hidden=true;$('private').hidden=false;await refresh();startPolling();await loginStatus()}
const key=new URLSearchParams(location.hash.slice(1)).get('key');history.replaceState(null,'',location.pathname);if(key){$('key').value=key;unlock()}else{resumeSession().catch(()=>{})}
window.addEventListener('pagehide',()=>{clearInterval(timer);clearTimeout(loginTimer);wipeLogin()});
window.addEventListener('pageshow',e=>{if(e.persisted)resumeSession().catch(error=>showError(error))});
</script></html>`));

await runtime.status();
await app.listen({ host: '127.0.0.1', port });
writeFileSync(accessFile, `${origin}/#key=${accessKey}\nExpires: ${new Date(expiresAt).toISOString()}\nForward port ${port} from airewebnode with VS Code before opening this link.\n`, { mode: 0o600 });
console.log(JSON.stringify({ state: 'real_onboarding_listening', origin, accessFile, codexProfile: config.codexProfile,
  runtimeVersion: runtime.cachedStatus().runtimeVersion, authenticated: runtime.cachedStatus().authenticated,
  queue: 'NONE', productionModified: false, expiresAt: new Date(expiresAt).toISOString() }));
let closing = false;
async function close() { if (closing) return; closing = true; await Promise.allSettled([runtime.close(), browser.close(), app.close()]); try { unlinkSync(accessFile); } catch {} }
const expiry = setTimeout(() => { void close().then(() => process.exit(0)); }, expiresAt - Date.now());
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { clearTimeout(expiry); void close().then(() => process.exit(0)); });
