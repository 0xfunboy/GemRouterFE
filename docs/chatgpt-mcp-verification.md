# Verifica gateway ChatGPT MCP — registro delle prove

## 16 settembre 2026: preparazione del primo login reale

Letto integralmente l'incarico di onboarding reale. Il checkout rimane sul commit
`30873b7` con tutte le modifiche precedenti, inclusi file non tracciati, preservate.
Nessun nuovo mock viene usato per dichiarare il collegamento all'account.

- Il servizio effettivo è `gemrouter.service`, utente `funboy`, porta `4024`.
  Il timer già esistente lo ha riavviato alle **03:30 UTC**, prima di questa
  attività. Il codice base control/admission/outbox è già nel `dist` caricato,
  ma `GEMROUTER_CHATGPT_CONTROL_ENABLED` non è impostata: feature disabilitata.
  Le correzioni attuali sono solo sorgenti; `dist` non è stato sovrascritto.
- Verifica DB effettuata con `DatabaseSync(..., {readOnly:true})`, senza store,
  migrazioni, recovery o seconda istanza. Ownership coerente col Node live,
  schema 4, worker/alias/risorsa richiesti confermati, grant unico non revocato,
  nessun job o completion. La vecchia run è **released** dal riavvio notturno:
  serve bootstrap esplicito successivo, non nuovo pairing MCP.
- La catena sorgente è `control → runControl → thread/start + turn/start →
  item/tool/call → closure → BrowserUiBridge`. Corretto il mascheramento degli
  errori del bridge nel caso di tool fallito; questo controllo del codice non
  equivale ancora a un turno autenticato realmente eseguito.
- Predisposta e avviata una pagina **reale** di onboarding su loopback `8796`,
  senza gateway né coda, con Codex `0.154.0-alpha.6.2` e il profilo persistente
  `/home/OPERATOR/.local/share/gemrouter-personal-control/codex`. Avvio runtime e
  `account/read` riusciti; account inizialmente non autenticato. Il link privato
  è nel file `onboarding-access.txt` owner-only; nessun codice/token è registrato
  qui. Il device login va iniziato e completato dalla pagina dell'operatore.
- Aggiornamento dopo l'intervento dell'operatore: il login è stato completato.
  Il processo di onboarding effettivo conferma `authenticated: true`, account
  ChatGPT, `modelAvailable: true`, `reasonCode: null`, nel profilo dedicato.
  Nessuna identità personale o credenziale viene copiata in questo registro.
  Questo verifica l'accesso Codex, non un turno del controllore sul browser.
- Verifiche sul server di onboarding effettivamente in esecuzione: GET status
  anonimo **401**, mutazione anonima **401**, origine estranea **403**, sintassi
  dello script frontend valida. Nessun account simulato in queste verifiche.
- Xvfb e Chrome sono presenti; il viewer interattivo richiedeva tre pacchetti
  mancanti (`x11vnc novnc websockify`). L'operatore ne ha autorizzato
  l'installazione e l'avvio temporaneo su loopback. Il tentativo effettivo con
  `sudo -n` si è fermato con **sudo: a password is required**; nessun pacchetto
  è stato installato dall'agente. Il comando con password nel terminale remoto
  è stato consegnato all'operatore, senza richiederla nella conversazione.
  Il controllo successivo `dpkg-query` conferma ora tutti e tre installati;
  Node applicativo resta `24.18.0`, PID/avvio di produzione invariati.
- Il primo avvio del display **:95** risultava pronto ma non è sopravvissuto
  alla chiusura della sessione di comando. Il controllo successivo ha rilevato
  PID assente e nessun listener X11: lo stato iniziale non provava persistenza.
  Rimossi solo lock/socket effimeri di quel PID già terminato, dopo controllo
  di proprietà e assenza di listener; nessun profilo o credenziale account rimosso.
  Aggiunta modalità `--foreground` al launcher, che mantiene aperta la sessione
  di supervisione e rilascia il lock operativo. Nuovo display avviato con Xauth
  privato, senza TCP: verifiche separate `status` e `xdpyinfo` confermano **:95**
  vivo con risoluzione 1440×1000. Login browser e calibrazione ancora da verificare.
- Corretto l'onboarding: messaggi di avanzamento/errore accanto ai pulsanti,
  blocco dei clic concorrenti, spiegazione del visualizzatore remoto e controllo
  preventivo browser/profilo/runtime. La diagnostica priva di browser restituisce
  realmente **422 browser_not_started**, senza turno Codex e con evidenza nulla.
  Riavviato **solo il processo temporaneo su 8796**, non GemRouter; il runtime
  successivo conferma login Codex e modello ancora disponibili nel medesimo profilo.
  Il link di accesso alla pagina è stato ruotato; resta nel file privato dedicato.
- Il bridge reale ha aperto Chrome con risposta **200 operator_login_required**
  e stato **browserOpen: true**, senza screenshot, tracing o lettura di credenziali.
  Corretto il riconoscimento della finestra: Chrome crea anche una finestra helper
  non mappata; il viewer accetta solo l'unica finestra normale realmente visibile.
  Viewer **127.0.0.1:8795**, VNC **127.0.0.1:5975**, nessun listener pubblico.
  Verificati HTTP pagina noVNC **200** e handshake WebSocket→RFB 3.8 con sola
  autenticazione password offerta; handshake interrotto prima dell'autenticazione,
  nessun framebuffer acquisito. L'operatore ha ricevuto URL, porta da inoltrare e
  percorso del file password privato. Questo non verifica ancora login ChatGPT,
  visibilità dal dispositivo dell'operatore o controllo della chat tramite Codex.
- Regressioni: `pnpm test` **202/202** passati, 28 suite, zero skip/fallimenti.
  Typecheck sorgenti e dello script onboarding passati; build eseguita in
  `/tmp/gemrouter-onboarding-build.RBGb33`, non in `dist`. `bash -n` del launcher
  e `git diff --check` passati. Sono verifiche di codice, non prove ChatGPT live.

### Aggiornamento browser dopo il blocco di login Google

L'operatore ha segnalato il rifiuto Google «browser non sicuro». La diagnosi ha
rilevato Chrome **141.0.7390.54**; il repository Google configurato proponeva
**153.0.8010.36**. Dopo l'aggiornamento eseguito dall'operatore, è stato chiuso
soltanto il processo Chrome identificato dal profilo dedicato e riaperto tramite
il medesimo bridge, senza cambiare flag di sicurezza o copiare credenziali.
Verificata la versione **153.0.8010.36 del binario del nuovo processo in esecuzione**,
risposta login bridge HTTP 200 e `browserOpen: true`. Viewer riagganciato alla nuova
finestra sulla stessa porta loopback 8795, con password effimera rigenerata.
Il processo onboarding non è stato riavviato; login Codex ancora valido, profili
preservati, processo/avvio GemRouter invariati. L'esito del nuovo tentativo di
  login Google resta da verificare dall'operatore: aggiornare Chrome non dimostra
  che il provider accetti un browser controllato da automazione. Nessuna diagnostica
  Codex→chat o completion MCP è stata eseguita in questo passaggio.
- Il viewer è poi terminato dal gestore della sessione che aveva lanciato il
  comando. Nessun crash del browser o errore VNC è stato osservato: un avvio
  `x11vnc` controllato ha raggiunto la fase di ascolto. Per renderlo utilizzabile
  anche quando il runner chiude i figli, è stato avviato come unità **systemd
  utente transiente** `gemrouter-control-viewer` (`--collect`), senza `enable` e
  senza servizio di sistema. `status` e HTTP noVNC **200** restano attivi dopo
  la chiusura del comando; produzione e profili non sono stati toccati.

Non ancora verificati: turno Codex sul bridge reale, UI della chat esatta,
inventario MCP in quella destinazione, `gateway_status`
provocato da Codex, prima completion e wake dopo idle. La pagina preparata rende
concreto il prossimo passaggio umano; non costituisce accettazione end-to-end.
I comandi di accesso sono nella
[guida onboarding](chatgpt-personal-control.md#onboarding-interattivo-reale-senza-secondo-gateway).

Nessun deploy o riavvio **di produzione**, nuovo pairing, revoca, ordine finanziario
o nuova chat effettuato durante questa attività. Riavviato solo l'onboarding
temporaneo; avviati display/browser/viewer utente autorizzati. Il timer resta invariato; prossima
esecuzione osservata **17 settembre, 03:30 UTC**. Un intervento per cambiarlo o
distribuire le correzioni deve essere autorizzato separatamente.

## 15 settembre 2026: controllo personale, implementazione locale

È stato aggiunto il controllo opt-in della chat personale esistente tramite
Codex App Server e bridge UI locale ristretto. La destinazione non è un Workspace
Agent o un thread Codex sostitutivo; soltanto una completion valida del gateway
MCP può soddisfare la richiesta del client. Binding versionati, outbox SQLite,
coordinamento/deadline, azioni amministrative separate, wizard e test locali sono
descritti nella [guida del controllo personale](chatgpt-personal-control.md).

La feature rimane disabilitata per default e i binding non vengono armati
dall'installazione. L'aggiornamento attuale **non è stato distribuito, non ha
riavviato servizi e non ha modificato il grant MCP preesistente**. I deploy
menzionati nelle sezioni storiche sotto riguardano il gateway del 14 settembre,
non questo nuovo controllore.

| Livello di prova | Risultato e limite |
|---|---|
| Implementazione locale | Percorso Codex → tool limitato → bridge browser → chat personale; nessun backend privato ChatGPT o browser generalista esposto |
| Test automatici correnti | **200 test / 28 suite passati**, zero fallimenti o test saltati; typecheck e build passati. Chromium richiede permessi di processo/loopback non concessi dal sandbox iniziale: riesecuzione isolata autorizzata riuscita |
| Lockfile e diff | Validazione `pnpm install --lockfile-only --offline --frozen-lockfile --ignore-scripts` e `git diff --check` passate; nessun aggiornamento di dipendenze scaricato |
| Smoke HTTP/MCP gateway | Passato sul server compilato isolato: ingressi reali testo/JSON/SSE, OAuth e tre tool MCP; worker deterministico, non ChatGPT |
| Smoke controller | Passato: Fastify/admin/MCP HTTP reali, Codex e UI simulati, ingresso inferenza fixture autenticato. Due completion MCP, **89 ms e 103 ms**, stessa run e grant; tempi locali, non latenza ChatGPT |
| Smoke frontend | Passato su Chromium e server locali: cinque fasi, bootstrap, gateway collassato, privacy guest, pulizia dati/codici al logout, layout desktop/mobile e nessun errore JS; device login e worker simulati |
| Runtime ufficiale | `codex-cli 0.154.0-alpha.6.2`: schema installato ispezionato; avvio stdio, initialize, audit configurazione e account/read verificati realmente su profilo isolato |
| OAuth Codex | Non completato live; probe restituisce `controller_auth_required`. Login, cancellazione e scadenza coperti con simulatore |
| Trasporto nativo verso chat personale | Non verificato; thread/start/turn/start sono usati solo per il controllore Codex |
| Browser della chat personale | Non verificato live: host Linux senza `DISPLAY`/`WAYLAND_DISPLAY`, nessuna sessione autenticata o calibrazione UI dell'account disponibile |
| Chat esatta e tre tool MCP | Non verificati dalla nuova catena di controllo; codice registrato o grant attivo non prova inventario/app della chat |
| Wake, completion e ripresa dopo idle | Da verificare sull'account reale; simulazioni non equivalgono a successo live |
| Creazione altre chat | Percorso UI implementato con worker/risorsa separati; nessuna nuova conversazione personale reale creata in questa verifica |
| Video da 05:00 | Consultata trascrizione secondaria: 05:21–06:20 descrive thread Codex; segmento audiovisivo non ispezionato |
| Produzione e MCP preesistente | Controllo SQLite in sola lettura prima/dopo: grant esistente ancora attivo, stesso worker e stessa risorsa. Nessun nuovo pairing per autenticare Codex; nessun deploy/restart |

I comandi di verifica del nuovo percorso sono nella
[guida operativa](chatgpt-personal-control.md#verifiche-riproducibili-e-limiti-delle-prove).
I test del runtime sono stati eseguiti con trasporto stdio deterministico,
senza chiamate all'account. I conteggi e gli smoke del 14 settembre riportati
di seguito sono **storici**, non il totale della suite corrente né una nuova
certificazione live. I risultati correnti nella tabella sopra distinguono
HTTP/MCP simulato e chat reale; non certificano la compatibilità della UI dell'account.

Il prossimo passaggio operativo necessario è rendere disponibile una sessione
grafica autorizzata sullo stesso host del controllore, completare i login separati
e calibrare i descrittori sui controlli realmente osservati. Un browser aperto su
un altro dispositivo non viene raggiunto automaticamente. Non è stato sostituito
questo prerequisito con un account Codex già autenticato per lo sviluppo.

## Registro storico — 14 settembre 2026

Le sezioni seguenti conservano gli esiti del gateway precedente e del relativo
deploy autorizzato. Non descrivono il rilascio in produzione del controllo UI.

## Implementazione

Gateway reverse-RPC nativo dentro GemRouter: tre tool MCP, OAuth/PKCE, registry
multi-worker, coda SQLite persistente, claim protetti da generazione e token,
idempotenza HTTP e replay MCP vincolato a grant/run/claim ancora validi.
Nessun Pi Agent, runtime PiLink o provider HTTP intermedio.

L'area riservata comprende il wizard **Prepara → Autorizza → Avvia la chat**,
con creazione del worker, consenso all'uso della conversazione persistente,
permessi esatti per l'app selezionata, URL/istruzioni copiabili, ripresa,
scadenza pairing e stato osservato dal gateway. La sezione parte collassata; il
passaggio di autorizzazione segue dall'alto verso il basso tutti i campi della
finestra **New Plugin** e offre valori suggeriti copiabili. La gestione avanzata
rimane disponibile separatamente. Il dominio di riferimento è
`https://gemrouter.example.com`; la produzione è stata abilitata soltanto dopo
l'autorizzazione esplicita dell'operatore.

I modelli upstream confermati come ritirati vengono filtrati centralmente da
configurazione, cache, discovery, cataloghi account, policy persistita e routing.
La gestione app mostra **Activate** e **Remove app** soltanto sui record revocati:
l'attivazione emette una chiave nuova mostrata una sola volta, mentre la rimozione
richiede conferma. La revoca invalida inoltre gli eventuali binding ChatGPT.

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

Esito finale: **132 test superati, 23 suite, zero fallimenti o test saltati**;
typecheck, build e installazione frozen superati. La suite comprende i test precedenti dei provider e del router e nuovi test
per protocollo, registry, OAuth/trasporto, claim/race/replay, privacy,
backup, dashboard, esclusione dei modelli ritirati e ciclo di vita delle app.
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
grant, sezione collassata di default, ripresa dopo reload, istruzioni complete e
nello stesso ordine della GUI ChatGPT, schermata disabilitata e layout desktop
e mobile a 390 px. Verifica inoltre via UI il ciclo creazione → revoca → Activate
con chiave nuova → revoca → Remove app. Non sono ammessi errori JavaScript o
console. Il polling e la schermata feature-off sono simulati esplicitamente nel
browser.

Le schermate del wizard sono state ispezionate visivamente. Per rigenerarle,
impostare `GEMROUTER_UI_SCREENSHOT_DIR` su una directory esistente. Non occorre
installare automaticamente un browser: usare Chrome/Chromium disponibile o
`GEMROUTER_BROWSER_EXECUTABLE`.

## Collegamento live con ChatGPT: non verificato

Il gateway, il wizard e il successivo hardening sono stati pubblicati in
produzione il 14 settembre 2026. Dopo il riavvio controllato, sia
`gemrouter.service` sia `cloudflared-gemrouter.service` risultano attivi. La
discovery OAuth pubblica risponde HTTP 200 con issuer, registrazione DCR, PKCE
S256, resource e scope coerenti con `https://gemrouter.example.com`; il boundary
MCP pubblico risponde `401` senza Bearer e pubblica nel `WWW-Authenticate` l'URL
dei metadati della risorsa attesa.

Il riepilogo amministrativo autenticato conferma gateway abilitato, un worker
`ExampleTradeWorker` abilitato e un grant OAuth attivo. Dopo il riavvio il worker
è nello stato osservato `released`: non è quindi una prova che una chat sia in
polling o stia elaborando richieste. Lo smoke browser autenticato sul dominio di
produzione conferma inoltre sezione **ChatGPT MCP Gateway** collassata di default,
wizard visibile dopo l'espansione, istruzioni ordinate e complete, nessun overflow
a 390 px e nessun errore JavaScript/console.

Lo stesso controllo post-deploy conferma che
`gemini-3.1-flash-live-preview` non appare in riepilogo, alert, policy persistita
o configurazione di produzione. L'app revocata `runchktest` è stata rimossa via
nuova API ed è assente sia dal riepilogo sia da `data/apps.json`; prima della
rimozione è stata salvata una copia con permessi `0600` in
`backups/deploy-20260914T165443Z/apps.before-revoked-removal.json`.

Queste verifiche provano che frontend, discovery, OAuth e gateway sono live, ma
non che la conversazione ChatGPT stia eseguendo il reverse-RPC: non è stata
inviata e completata una richiesta reale dell'app attraverso quella chat.

Nel percorso manuale qui verificato, conferma OAuth e avvio della conversazione
nell'interfaccia ChatGPT restano necessari. Il controllo UI opt-in aggiunto il
15 settembre può predisporre l'avvio limitato soltanto dopo setup e verifiche
proprie; non risulta live in questo registro. Disponibilità della modalità sviluppatore, approvazioni
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

Il successivo hardening di modelli, app revocate e onboarding è stato integrato
direttamente su `main` e pubblicato senza force-push. Lo stato persistente di
produzione (`.env`, app e database runtime) resta intenzionalmente escluso da Git.
