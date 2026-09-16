import { App } from '@modelcontextprotocol/ext-apps';
import { ProbeClient, type Method } from './client.js';
import { eventSchema, PREFIX, BUILD, type ProbeEvent } from './protocol.js';
import { createMountId, selectBridge } from './bridge.js';

declare const PROBE_ORIGIN: string;
declare global { interface Window { openai?: { sendFollowUpMessage?: (args: { prompt: string }) => Promise<unknown> } } }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => { $('status').textContent = text; };
async function boot() {
$('capabilities').textContent = 'JavaScript attivo. Inizializzazione del bridge…';
const manual = $<HTMLButtonElement>('manual'), arm = $<HTMLButtonElement>('arm');
const enrollButton = $<HTMLButtonElement>('enroll'), methodSelect = $<HTMLSelectElement>('method');
const recheck = $<HTMLButtonElement>('recheck');
const app = new App({ name: 'GemRouter Wake Probe', version: BUILD }, {});
const mount = createMountId(globalThis.crypto);
let token = '', sessionId = '', engine: ProbeClient | undefined;
let manualEvent: ProbeEvent, manualDeadline = 0, pendingRemote = false;
let lifetime: ReturnType<typeof setTimeout> | undefined;
let stream: AbortController | undefined;
let closed = false, initialized = false, enrolling = false;
let initState = 'in corso';

async function api(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(PROBE_ORIGIN + PREFIX + path, { method: body === undefined ? 'GET' : 'POST',
    mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token, 'X-Probe-Mount': mount } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(8000) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? `HTTP_${response.status}`); }
  return response;
}
function stop() {
  if (closed) return;
  closed = true; clearTimeout(lifetime); stream?.abort();
  manual.disabled = true; arm.disabled = true; enrollButton.disabled = true; recheck.disabled = true;
  window.removeEventListener('openai:set_globals', methods);
  $('connection').textContent = 'Fermato. Nessuna riconnessione: occorre un nuovo test autorizzato.';
  if (token) void api('/stop', {}).catch(() => {}).finally(() => { token = ''; });
}
function fail(error: unknown) {
  // Do not log full exceptions, requests, tokens, or host-supplied messages.
  const message = error instanceof Error && /^[a-zA-Z0-9_:-]{1,90}$/.test(error.message) ? error.message : 'connection_or_bridge_error';
  status(`Fermato: ${message}. Nessun retry e nessun cambio di metodo.`); engine?.disarm(); stop();
}
function methods() {
  if (closed || enrolling || token) return;
  const alias = typeof window.openai?.sendFollowUpMessage === 'function';
  const selection = selectBridge(initialized, app.getHostCapabilities(), alias);
  methodSelect.innerHTML = '';
  if (selection.method) methodSelect.add(new Option(selection.label, selection.method));
  $('capabilities').textContent = `ui/message + testo: ${selection.declared ? 'dichiarato' : 'non dichiarato'}; alias: ${alias ? 'presente' : 'assente'}. ${selection.label}. Non prova il wake.`;
  $('diagnostics').textContent = `${BUILD}; script attivo; initialize: ${initState}; contesto sicuro: ${globalThis.isSecureContext ? 'sì' : 'no'}; origin: ${location.origin}.`;
  // Enrollment authorizes only this card, not a model turn. In legacy hosts
  // with a valid handshake, the real manual baseline determines message support.
  enrollButton.disabled = initState === 'in corso' || !selection.method;
}
app.onteardown = async () => { engine?.disarm(); stop(); return {}; };
app.onhostcontextchanged = () => { /* Host lifecycle is not an authorization to send. */ };
window.addEventListener('pagehide', () => { engine?.disarm(); stop(); }, { once: true });
$('stop').addEventListener('click', () => { engine?.disarm(); stop(); status('Disattivato dall’operatore.'); });
recheck.addEventListener('click', methods);
window.addEventListener('openai:set_globals', methods);

enrollButton.addEventListener('click', async () => {
  methods();
  if (closed || enrolling || token || enrollButton.disabled) return;
  enrolling = true; recheck.disabled = true;
  enrollButton.disabled = true;
  const input = $<HTMLInputElement>('code'), code = input.value.trim(); input.value = '';
  const started = performance.now();
  try {
    const data = await (await api('/enroll', { code, mount })).json();
    token = data.token; sessionId = data.sessionId; manualEvent = eventSchema.parse(data.manualEvent);
    manualDeadline = started + data.remainingEventMs;
    lifetime = setTimeout(() => { status('Sessione scaduta.'); engine?.disarm(); stop(); }, Math.max(0, started + data.remainingSessionMs - performance.now()));
    const method = methodSelect.value as Method; methodSelect.disabled = true;
    engine = new ProbeClient({ now: () => performance.now(), visibility: () => document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      bridge: prompt => method === 'ui/message'
        ? app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] }, { timeout: 15_000 })
        : window.openai!.sendFollowUpMessage!({ prompt }),
      receipt: async receipt => { await api('/receipt', receipt); }, stop, show: status,
    }, data.promptTemplate, method);
    $('session').textContent = sessionId;
    $('expiry').textContent = `Scadenza sessione: ${new Date(data.expiresAt).toLocaleString('it-IT')}. Il codice usato non è riutilizzabile.`;
    $('preview').textContent = data.promptTemplate;
    $('connection').textContent = 'Autorizzato, NON in ascolto. Attendi la fine del turno iniziale.';
    manual.disabled = false;
    status('Entro 60 secondi premi una sola volta Prova manuale del bridge. Poi osserva il nuovo turno e il tool nella chat.');
  } catch (error) { fail(error); }
});
manual.addEventListener('click', () => {
  manual.disabled = true;
  if (engine?.invoke(manualEvent, 'manual', manualDeadline)) {
    arm.disabled = false;
    $('connection').textContent = 'Baseline inviata. Riporta il risultato all’operatore: prima dell’ascolto deve registrarlo. Il pulsante Attiva verifica questo requisito senza inviare altri messaggi.';
  }
});
arm.addEventListener('click', async () => {
  if (closed || arm.disabled) return;
  arm.disabled = true;
  try {
    const readiness = await (await api('/readiness')).json();
    if (closed) return;
    if (readiness.baselineVerified !== true) {
      $('connection').textContent = 'In attesa della verifica della baseline da parte dell’operatore. Sessione ancora valida, ascolto NON avviato.';
      status('Il clic non ha fermato la sessione. Riporta il risultato della prova manuale all’operatore; quando conferma la registrazione, premi di nuovo Attiva ascolto di prova. Non ripetere la prova manuale.');
      arm.disabled = false;
      return;
    }
    if (!engine?.arm()) { status('Bridge ancora in attesa o test fermato. Nessun ascolto avviato.'); arm.disabled = closed; return; }
    stream = new AbortController();
    const response = await api('/events', undefined, stream.signal);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) throw new Error('stream_closed');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16384) throw new Error('stream_too_large');
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const name = block.match(/^event: (.*)$/m)?.[1];
        if (name === 'heartbeat') continue;
        if (name === 'ready') { $('connection').textContent = 'Armato, SSE connesso. Non interagire più con la pagina durante i test remoti.'; continue; }
        if (name !== 'probe') throw new Error('unexpected_stream_event');
        const event = eventSchema.parse(JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? ''));
        if (pendingRemote) throw new Error('concurrent_event');
        pendingRemote = true;
        const ingress = performance.now();
        // Server-monotonic expiry check; subtract the entire RTT conservatively.
        const check = await (await api('/check', { eventId: event.eventId })).json();
        engine.invoke(event, 'remote', ingress + check.remainingMs, ingress);
        pendingRemote = false;
      }
    }
  } catch (error) { if (!closed) fail(error); }
});
// Handshake is not a send, enrollment, arm or tool invocation.
methods();
await app.connect(undefined, { timeout: 8000 }).then(() => {
  initialized = true; initState = 'riuscita'; methods();
}, error => {
  const code = typeof error?.code === 'number' && Number.isInteger(error.code) ? ` (${error.code})` : '';
  initState = 'non riuscita' + code; methods();
  status('Inizializzazione standard non riuscita. Nessun messaggio inviato; alias utilizzabile solo se rilevato. Ricontrolla bridge verifica soltanto la disponibilità, non invia messaggi.');
});
}
void boot().catch(error => {
  const reason = error instanceof Error && error.message === 'secure_random_unavailable' ? error.message : 'widget_boot_failed';
  $('capabilities').textContent = `Avvio card fallito: ${reason}. Nessun messaggio inviato.`;
  status('Il codice non è stato utilizzato. Riporta questo errore senza condividere il codice.');
  for (const id of ['enroll', 'manual', 'arm', 'recheck']) $<HTMLButtonElement>(id).disabled = true;
});
