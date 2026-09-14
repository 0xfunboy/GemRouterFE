# Verifica gateway ChatGPT MCP — 14 settembre 2026

## Implementazione

Gateway reverse-RPC nativo dentro GemRouter: tre tool MCP, OAuth/PKCE, registry
multi-worker, coda SQLite persistente, claim protetti da generazione e token,
idempotenza HTTP e replay MCP vincolato a grant/run/claim ancora validi.
Nessun Pi Agent, runtime PiLink o provider HTTP intermedio.

L'area riservata comprende il wizard **Prepara → Autorizza → Avvia la chat**,
con creazione del worker, consenso all'uso della conversazione persistente,
permessi esatti per l'app selezionata, URL/istruzioni copiabili, ripresa,
scadenza pairing e stato osservato dal gateway. La gestione avanzata rimane
disponibile separatamente. Il dominio di riferimento è
`https://gemr.airewardrop.xyz`; la produzione è stata abilitata soltanto dopo
l'autorizzazione esplicita dell'operatore.

La revisione ha corretto isolamento dei grant concorrenti, replay di claim
scaduti/rilasciati, revoca del binding precedente, token refresh e scope,
errori del worker potenzialmente privati, startup/shutdown SQLite, limiti
persistenti, audit soltanto dopo commit, fallback improprio verso alias worker,
validazione input e persistenza dei permessi del bootstrap.

Le protezioni browser distinguono CORS delle app dalla gestione riservata;
le app con origine wildcard non ottengono accesso alle sessioni admin. Il
consenso OAuth ha CSP limitata al callback registrato e referrer policy
compatibile con l'invio del form. Le risposte SSE mantengono CORS e metadati
del gateway. Le dipendenze runtime e di sviluppo sono state aggiornate e
verificate, incluso Fastify 5.12.4.

## Test automatici

Comandi riproducibili:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm audit --audit-level=low
git diff --check
```

Esito finale: **127 test superati, 22 suite, zero fallimenti o test saltati**;
typecheck, build e installazione frozen superati. La suite comprende i test precedenti dei provider e del router e nuovi test
per protocollo, registry, OAuth/trasporto, claim/race/replay, privacy,
backup e dashboard.
L'audit delle dipendenze aggiornate ha restituito zero vulnerabilità note;
questo non equivale a una garanzia di assenza di difetti.

## Smoke HTTP/MCP simulato

Esito: **superato** sul server compilato dopo la verifica automatica finale.

`pnpm smoke:chatgpt-mcp` avvia soltanto processi locali isolati, con credenziali
generate, directory temporanee e nessuna eredità delle credenziali provider o
del `.env` del checkout. Usa il client ufficiale MCP e il server compilato.

Verifica feature off/on, OAuth DCR/PKCE, separazione delle credenziali,
onboarding e permessi app, protezioni CORS/CSRF/Host/Origin, catalogo tool,
testo/JSON, SSE buffered e metadati, release/revoca, alias dormienti e assenza
di fallback. Il client che svolge il lavoro è un simulatore deterministico,
non ChatGPT.

## Smoke browser e UX

Esito: **superato** su Chromium, desktop e mobile.

`pnpm smoke:chatgpt-ui` usa Chromium e un GemRouter locale isolato. Verifica
login, creazione/abilitazione reale del worker, permessi dell'app, OAuth con
callback su un'origine locale distinta, consenso, progressione vincolata al
grant, ripresa dopo reload, istruzioni, schermata disabilitata e layout desktop
e mobile a 390 px. Non sono ammessi errori JavaScript o console. Il polling e
la schermata feature-off sono simulati esplicitamente nel browser.

Le schermate del wizard sono state ispezionate visivamente. Per rigenerarle,
impostare `GEMROUTER_UI_SCREENSHOT_DIR` su una directory esistente. Non occorre
installare automaticamente un browser: usare Chrome/Chromium disponibile o
`GEMROUTER_BROWSER_EXECUTABLE`.

## Collegamento live con ChatGPT: non verificato

Il gateway e il wizard sono stati pubblicati in produzione il 14 settembre
2026. Dopo il riavvio controllato, il servizio systemd risulta attivo; la
discovery OAuth pubblica risponde HTTP 200 con issuer e endpoint coerenti con
`https://gemr.airewardrop.xyz`, mentre l'area riservata servita dal dominio
contiene il wizard **Prepara → Autorizza → Avvia la chat**. Il riepilogo
amministrativo locale autenticato conferma gateway abilitato, profilo
`compatibility`, streaming `buffered` e `workerCount: 0`. Il database del
gateway è stato creato con permessi `0600`.

Queste verifiche provano che frontend, discovery e gateway sono live, ma non
che ChatGPT sia già collegato: non è stata autenticata una sessione ChatGPT
reale e al momento della verifica non risultava alcun worker registrato.

La conferma OAuth e l'avvio della conversazione nell'interfaccia ChatGPT
restano necessari. Disponibilità della modalità sviluppatore, approvazioni
tool e limiti della chat dipendono dall'account/workspace. Una risposta del
simulatore, un grant OAuth o un contatto MCP non provano l'identità di ChatGPT.
Il modello resta dichiarato dall'operatore, i token non sono misurabili e lo
streaming è buffered. Per la verifica live usare la checklist della
[guida operativa](chatgpt-mcp-gateway.md#verification) dopo un deploy autorizzato.

## Consegna Git

Il checkout iniziale conteneva l'implementazione non ancora committata.
Le modifiche sono state conservate. Il remoto aveva una cronologia riscritta
e aggiornamenti alla licenza: il branch `feat/native-chatgpt-mcp-onboarding`
è basato sul nuovo `origin/main` (`0904fb6`), preservando tali aggiornamenti
senza force-push. Dopo il riallineamento, sorgenti, test, script e lockfile
sono identici a quelli verificati; il branch è stato integrato in `main` con
avanzamento fast-forward e pubblicato sul remoto.
