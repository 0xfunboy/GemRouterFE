import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { BUILD, CODE_MS, EVENT_MS, MAX_REMOTE, SESSION_MS } from './protocol.js';
const origin = new URL(process.env.WIDGET_WAKE_PUBLIC_ORIGIN ?? 'https://gemrouter.example.com');
if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/') throw new Error('exact_https_origin_required');
const result = await build({ entryPoints: ['widget.ts'], bundle: true, write: false, format: 'iife',
  platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  define: { PROBE_ORIGIN: JSON.stringify(origin.origin) } });
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GemRouter Wake Probe</title><style>
:root{color-scheme:light dark;font:15px/1.45 system-ui}body{margin:0;padding:20px;max-width:760px}h1{font-size:20px}button,input,select{font:inherit;padding:10px;border:1px solid #8888;border-radius:8px;margin:4px 4px 4px 0}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;padding:12px;border-radius:8px}small{display:block}#status{border-left:3px solid #548ee0;padding:12px}label{display:block;margin-top:12px}
</style><h1>GemRouter Wake Probe · sperimentale · ${BUILD}</h1>
<p>Nessun ascolto al caricamento. Questa card chiede un messaggio diagnostico: non verifica da sola né un nuovo turno né l’uso del connettore.</p>
<p>Limiti: codice monouso e sessione validi fino a ${SESSION_MS / 3_600_000} ore dall’emissione del codice; massimo ${MAX_REMOTE} eventi remoti, scadenza del singolo evento ${EVENT_MS / 1000} secondi. Un solo invio per evento, nessun retry. Chiudere, ricaricare o rimontare ferma il test anche prima delle 24 ore.</p>
<p id="capabilities">JavaScript non ancora avviato. Se questa scritta rimane, lo script è bloccato o non eseguito.</p>
<small id="diagnostics">${BUILD}; bridge non verificato.</small><button id="recheck">Ricontrolla bridge</button>
<label>Metodo effettivo <select id="method" aria-label="Metodo bridge"></select></label>
<label>Codice monouso (valido ${CODE_MS / 3_600_000} ore, solo qui, mai nella chat)<input id="code" type="password" autocomplete="off" spellcheck="false" maxlength="43"></label>
<button id="enroll" disabled>Autorizza questa card</button>
<p>Sessione: <code id="session">nessuna</code></p><p id="expiry">Scadenza: non ancora autorizzata</p><p id="connection">Disarmato</p>
<details open><summary>Messaggio che potrà essere inviato</summary><pre id="preview">Dopo l’autorizzazione verrà mostrato il template diagnostico fisso per il connettore già autorizzato, senza aprire run o elaborare job.</pre></details>
<button id="manual" disabled>Prova manuale del bridge</button><button id="arm" disabled>Attiva ascolto di prova</button><button id="stop">Disattiva ascolto</button>
<p id="status" role="status" aria-live="polite">Non inviare altri messaggi o modificare bozze durante la finestra di prova. Dopo la baseline serve la conferma dell’operatore prima dell’ascolto remoto.</p>
<script>${script}</script></html>`;
await mkdir('build', { recursive: true });
await writeFile('build/card.html', html);
await writeFile('build/manifest.json', JSON.stringify({ publicOrigin: origin.origin, bytes: Buffer.byteLength(html) }, null, 2));
console.log(`Built static card (${Buffer.byteLength(html)} bytes); no listeners started.`);
