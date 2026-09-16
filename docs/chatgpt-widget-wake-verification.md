# NO-GO NELLE CONDIZIONI TESTATE — sessione 24 ore

Aggiornato il **16 settembre 2026, 10:04 UTC**. Microtest corrente `widget-wake-0.1.3`, nel checkout `main` a partire da `30873b7352b9730e14d46fd2d4f31f03e6aee37e`, con modifiche preesistenti conservate.

**L’estensione a 24 ore non ha risolto il wake nel test reale della 0.1.3.** La baseline manuale restituisce il worker atteso e `released` secondo l’operatore. L’evento remoto arriva alla card e l’alias `openai.sendFollowUpMessage` termina senza errore rilevato, ma l’operatore non osserva alcun nuovo turno/tool. A circa **80 secondi dall’emissione il listener era ancora connesso**, con scadenza sessione al giorno successivo e nessuno stop. L’evento era stato ricevuto entro il proprio TTL. Il test è stato fermato **solo dopo** il resoconto negativo, alle **10:03:33.373 UTC**, con causa `negative_observation`: non confondere questo stop deliberato con una scadenza spontanea.

Il verdetto è **NO-GO nelle condizioni testate** per l’alias senza nuovo gesto nell’host/account provato, non una conclusione su ogni superficie o versione di ChatGPT. La causa interna del mancato messaggio resta sconosciuta; non è dimostrato un requisito generale di user gesture. Nessun fallback allo standard per lo stesso evento, seconda emissione, riarmo, polling modello, job o chiamata diretta al gateway. **C non eseguita**, perché B non ha superato il criterio. Non è un test di permanenza continuativa di 24 ore.

### Stato della prova corrente — 0.1.3

| Voce | Evidenza |
| --- | --- |
| Target / fonte | Chat `00000000-0000-0000-0000-b40c114d0582`, confermata operativamente dall’utente; UI non controllata dall’agente |
| Build / SDK | `widget-wake-0.1.3`; MCP SDK 1.30.0, MCP Apps 1.7.5, dipendenze invariate |
| Metodo / capability | `openai.sendFollowUpMessage`; `message.text` non dichiarato nelle precedenti diagnostiche della stessa app; metodo reale registrato in ogni ricevuta |
| A manuale | `probe_fixture_8c1411d4f33a`: operatore riporta worker atteso `worker-000000007c41d5e30ad0`, stato `released`; osservazione registrata alle 10:00:01.733 UTC |
| B remoto ≥30 s | `probe_fixture_14df0103ff3b`, 10:01:44.546 UTC; evento ricevuto, alias invocato; operatore riporta nessun nuovo turno/tool |
| C dopo idle ≥120 s | Non eseguita per esito negativo B; nessun riarmo o secondo evento |
| Clic / approvazioni | Un clic iniziale per armare; dopo conferma attesa aggiuntiva 32 s, nessuna azione UI dell’agente. Nessuna approvazione per B riferita |
| Persistenza / visibilità | `visible` nelle ricevute; `armed/connected` senza stop ancora al controllo delle 10:03:04 UTC. Nessuna prova background/offscreen/browser chiuso |
| Tempi individuali | A: ingresso→richiesta 0,1 ms, ingresso→risoluzione 133,7 ms. B: 163,7 ms e 166,1 ms, con check TTL incluso; emissione→ricevuta finale server 679,74 ms. Generazione/MCP n/d |
| Fonti live | Ricevute/connessione/stato del processo letti direttamente; risultati della chat riferiti dall’operatore, `modelInvocationVerifiedByServer: false` |
| Automatici / simulati | Ultima verifica build 0.1.3: 26 test + 6 scenari DOM superati; non ripetuti come sostituto di questa prova live |
| HTTP/MCP pubblico | Smoke risorsa/CORS/auth descritto sotto; solo trasporto, non modello |
| Grant / produzione | Intatti, nessun restart in questa prova, nessun accesso DB/job/open/exchange/status diretto |
| Verdetto | **NO-GO NELLE CONDIZIONI TESTATE**; scadenza della sessione e TTL di consegna non spiegano questo evento |

## Precedente prova live — 0.1.1: NO-GO NELLE CONDIZIONI TESTATE

**Il clic manuale ha prodotto una chiamata al tool secondo la traccia riportata dall’operatore; l’evento remoto senza clic NON ha prodotto alcun nuovo messaggio o risposta, secondo la successiva osservazione dello stesso operatore.** Il server ha verificato le ricevute reali della card per B: evento ricevuto e Promise di `openai.sendFollowUpMessage` risolta, classificata `accepted` dal prototipo. Questo non certifica l’accettazione di un turno da parte del modello. Il listener è poi risultato chiuso prima della scadenza; la causa precisa non è registrata. Test fermato con **un solo evento remoto**, nessun retry e nessuna prova C, perché B non ha superato il criterio. Il verdetto riguarda questo host/account, build, metodo e condizioni: non dimostra un divieto generale della piattaforma né esclude altri metodi/versioni.

### Stato delle prove della 0.1.1

| Voce | Evidenza attuale |
| --- | --- |
| Target esatto / verifica | `https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582`; card visibile riferita dall’operatore, URL/DOM non osservati direttamente dall’agente |
| Connettore / worker atteso | Example - Trade / `worker-000000007c41d5e30ad0`; nessuna nuova lettura del tool effettuata dall’agente |
| Build / SDK | `widget-wake-0.1.1`; MCP SDK `1.30.0`; MCP Apps SDK `1.7.5`; Fastify `5.12.4`; Zod `4.6.5`; lockfile isolato |
| Metodo bridge / capability | Initialize riuscita, `message.text` non dichiarato, alias presente secondo la card riportata; le ricevute reali attestano `openai.sendFollowUpMessage`, risultato `accepted` |
| Baseline manuale A | Bridge accettato; nuovo messaggio/turno e `Called tool` con worker corretto riferiti dall’operatore; osservazione registrata alle 09:26:30 UTC circa |
| Evento remoto B, turno concluso, ≥30 s | Emesso alle 09:28:24.552 UTC dopo attesa di 32 s successiva alla conferma dell’armamento; ricevuto, Promise risolta, **nessun nuovo messaggio/turno riferito dall’operatore** |
| Secondo evento C, ≥120 s idle, nessun riarmo | **Non eseguito**: B fallita e listener fermato; nessun riarmo o fallback |
| Tool invocato dal modello / worker restituito | Baseline manuale: riferito dall’operatore / `worker-000000007c41d5e30ad0`, `released`. Nessuna osservazione diretta dell’agente né attestazione server |
| Clic o approvazioni per evento | A: clic manuale. B: nessun nuovo clic previsto/eseguito dall’agente; non è stata riferita una richiesta di approvazione. Nessun consenso automatizzato |
| Persistenza widget / foreground / background | B: visibilità `visible` nelle ricevute, connessione presente subito dopo l’invio ma già chiusa al controllo delle 09:30 UTC, prima del TTL sessione. Causa non determinata; background, browser chiuso, sospensione e cambio chat non provati |
| Tempi individuali live | A: ingresso→richiesta 0,1 ms; ingresso→risoluzione bridge 98,5 ms. B: 178,3 ms e 181,1 ms rispettivamente, incluso controllo TTL; ritorno ricevuta finale al server 718,23 ms. Generazione/tool n/d; C non eseguita; nessun percentile/SLA |
| Test automatici | **20/20**, più **5/5 scenari bootstrap DOM** precedentemente eseguiti, tutti host/turni **SIMULATI**; smoke HTTP/MCP e SSE su loopback incluso |
| Trasporto pubblico reale | Initialize, discovery, lettura della card e renderer statico riusciti via HTTPS; non è un test dell’host ChatGPT |
| ChatGPT live osservato direttamente / riferito | Ricevute card e connessione lette direttamente dal server; A con `Called tool`/risultato e B senza nuovo messaggio/risposta riferiti dall’operatore. UI non controllata dall’agente. Stato successivo del badge «CSP off» non confermato |
| Grant AIR3 e produzione | Nessun accesso al DB, pairing/OAuth/release/run/job o chiamata diretta ai tre tool. Pubblicato solo il prototipo; aggiunta ingress e riavvio autorizzato del solo tunnel. Processo GemRouter invariato |
| Verdetto / blocco concreto | **NO-GO NELLE CONDIZIONI TESTATE**: B non avvia messaggio/turno secondo l’operatore nonostante Promise risolta; listener successivamente chiuso. Nessuna prova di wake riutilizzabile |

## Verifica documentale e scelte

Le guide OpenAI descrivono l’associazione tool→risorsa con `_meta.ui.resourceUri`, l’inizializzazione del bridge e i due percorsi di messaggistica. Qui vengono usati `registerAppTool`, `registerAppResource`, MIME `text/html;profile=mcp-app` e `App.connect()`. L’alias `openai/outputTemplate` è presente per compatibilità. [UI ChatGPT](https://developers.openai.com/plugins/build/chatgpt-ui), [server MCP](https://developers.openai.com/plugins/build/mcp-server).

Lo schema effettivamente installato in `@modelcontextprotocol/ext-apps@1.7.5` è:

```ts
app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] })
// result: { isError?: boolean, ... }
// hostCapabilities.message.text è un oggetto opzionale, NON un booleano.
```

La [specifica MCP Apps della revisione SDK scelta](https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/specification/2026-01-26/apps.mdx), raggiunta dalla guida OpenAI, e i tipi installati distinguono il messaggio dall’invocazione di un tool. Un risultato accettato **non certifica** una generazione. Eventuali consensi e lifecycle vanno osservati nell’host. Il codice non usa `ui/update-model-context` come trigger, sampling, `callTool` o `callServerTool`.

L’alternativa documentata è `window.openai.sendFollowUpMessage({ prompt })`. Viene mostrata solo se lo standard non è dichiarato e la funzione è presente; la scelta viene bloccata all’enrollment. Nessun fallback dopo invio, rifiuto o timeout. Il rilevamento viene aggiornato anche all’evento documentato `openai:set_globals`; il pulsante «Ricontrolla bridge» rilegge solo la disponibilità, non invia messaggi e non ripete initialize. [Reference OpenAI](https://developers.openai.com/plugins/reference).

Precisazione 0.1.1: nel SDK installato `hostCapabilities.message` è opzionale; `App.sendMessage` richiede initialize completata ma non impone quella capability opzionale. Se il campo è omesso, non viene più confuso con un rifiuto: in assenza di alias si permette **la sola baseline manuale** con etichetta «capacità non dichiarata». Initialize fallita senza alias, o capability esplicita priva di modalità testo, mantengono il pulsante disabilitato. Nessuna capability viene inventata e non viene presunto il successo del metodo.

CSP del componente: `connectDomains: ["https://gemrouter.example.com"]`, nessun asset remoto, nessun frame aggiuntivo. CORS ora ammette **esclusivamente** `https://asdk_app_fixture_4e9e3f37063f.web-sandbox.oaiusercontent.com`, origine effettiva riportata dall’operatore e configurata via `WIDGET_WAKE_IFRAME_ORIGIN`. L’origin generica iniziale, le app sorelle, wildcard e `null` non sono ammesse. La documentazione descrive un default generico: non va assunto come origin effettiva di ogni installazione. [Reference](https://developers.openai.com/plugins/reference), [sicurezza](https://developers.openai.com/plugins/guides/security-privacy).

La guida di collegamento propone una nuova conversazione e può richiederla per refresh. **Non è prova che una nuova app sia aggiungibile al target già esistente.** Se la selezione nella chat richiesta non è disponibile, fermare la prova e riportare il vincolo; non creare altre chat. [Collegamento a ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Implementazione isolata

Tutto il nuovo codice vive in `experiments/chatgpt-widget-wake/`; dipendenze e build sono indipendenti dalla build di produzione. Non importa moduli di GemRouter, non apre database e non contiene controller Codex/browser.

- Un tool pubblico **statico** `render_wake_probe`, nessun parametro, nessuna lettura privata e nessuna attivazione. Una risorsa UI. Nessuna modifica ai tre tool AIR3.
- Enrollment con codice casuale 256 bit, monouso, scadenza **24 ore dall’emissione nella 0.1.2** (prima: 2 minuti), digitato esclusivamente nella card. L’estensione della finestra è esplicitamente richiesta dall’operatore; il codice resta una credenziale privata e il primo utilizzo lo consuma. File operatore `0600` in directory `0700`, fuori dal repository. Nessun codice viene stampato dai comandi.
- Capability casuale distinta, associata a sessione e mount; solo memoria dell’iframe. Nessun token in URL, stato widget persistito, bundle, risultati MCP o log.
- **Un solo trasporto push: fetch SSE**, header Authorization e `X-Probe-Mount`. Endpoint `/check` per la validità monotona dell’evento, `/receipt` per evidenze di trasporto, `/stop` per chiusura. Nessun endpoint di emissione esposto al widget.
- Sessione massima **24 ore dall’emissione del codice nella 0.1.2** (prima: 15 minuti), senza rinnovo all’enrollment, massimo **6 eventi remoti**, TTL evento **60 secondi** invariato. Massimo 8 sessioni in memoria, retention **30 minuti dallo stop**, indipendente dalla durata estesa. I limiti sono del microtest, non attribuiti a ChatGPT. Le 24 ore non garantiscono che un iframe/browser rimanga attivo: Stop, teardown o disconnect interrompono subito.
- Un listener per sessione; disconnect, teardown, Stop o scadenza interrompono. Nessun reconnect, replay, retry, riarmo su mount o invio da heartbeat.
- Il prompt fisso e il worker atteso vengono restituiti solo dopo enrollment. Evento remoto strettamente validato: marker casuale, tipo e timestamp; niente prompt o istruzioni libere.
- La chiamata manuale entra nel bridge nello stesso stack del clic, senza attendere prima una richiesta HTTP. Per il remoto, il server ricontrolla il TTL e il client usa un termine conservativo con `performance.now()`.
- Ricevute serializzate e timeout bridge **15 s**; rifiuto o ambiguità fermano il test, senza cambiare metodo. Il widget non legge il DOM della chat e non modifica bozze. L’operatore deve non avviare altri turni durante la finestra sperimentale: il widget non può attestare autonomamente che il modello sia inattivo.
- Per armare serve un’osservazione esterna della baseline; ogni nuova emissione richiede l’osservazione del turno precedente e le attese minime. `observe` è **un resoconto dell’operatore**, non una prova verificata dal server: `modelInvocationVerifiedByServer` rimane `false`.
- Dalla 0.1.3, il clic Attiva legge prima `/readiness`, protetto da stessa origin/capability/mount. Se la baseline non è registrata mostra attesa, senza armare l’engine, aprire SSE, inviare Stop o ripetere il messaggio. Dopo la registrazione serve un nuovo clic esplicito. Nessun polling automatico, riarmo, concessione di osservazioni dal widget o bypass del controllo server su `/events`.
- Il report 0.1.2 conserva il primo `stopReason` e `stoppedAt`: `session_expired`, `event_expired`, `sse_closed`, `sse_write_failed`, `widget_stop`, `operator_stop`, `bridge_failed`, `negative_observation`, `event_limit`, `delivery_ambiguous` o `server_shutdown`. Un successivo sweep/close/observe non lo sovrascrive. `widget_stop` non distingue da solo clic, teardown o errore client; `sse_closed` non attribuisce la chiusura a ChatGPT. Nessun motivo retroattivo viene inventato per la 0.1.1.

## Comandi locali verificati

Non eseguire il build nella root del progetto per questa prova.

```bash
cd /home/OPERATOR/INFRA/gem-router/experiments/chatgpt-widget-wake
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check
pnpm test
```

`--ignore-workspace` è necessario perché questo pacchetto è deliberatamente fuori dal workspace root. Test/build non avviano il gateway live. Esito corrente 0.1.3: build card e typecheck riusciti, **26 test riusciti**, `git diff --check` riuscito. Le quattro regressioni durata usano clock simulati: codice valido a 23 ore e monouso; listener oltre 15 minuti e fino al confine esatto delle 24 ore; un evento già consegnato non chiude il listener al proprio TTL e un nuovo evento può essere emesso ore dopo; prima causa/timestamp di stop preservati e retention indipendente. Due regressioni ulteriori verificano readiness non mutante e protetta, e gate non aggirabile. Lo smoke SSE verifica inoltre `sse_closed` dopo disconnessione effettiva del client locale. **Non sono 24 ore osservate nell’host ChatGPT.** Sono state corrette durante la verifica precedente una inclusione involontaria del worker nel bundle pubblico e la chiusura incompleta delle connessioni dello smoke SSE; i test le coprono. La regressione CORS verifica origine specifica, rifiuto di origin generica/sorelle/suffissi contraffatti e leggibilità dell’errore autenticazione soltanto dall’origine autorizzata.

Regressione bootstrap facoltativa, usando `playwright-core` già presente nel checkout e Chrome locale, **mai un profilo/account autenticato**:

```bash
pnpm smoke:bootstrap
```

I **6 scenari simulati** verificano assenza di `randomUUID`, host senza capability opzionale, modalità testo esplicitamente assente, alias tardivo/Stop, assenza completa di CSPRNG e clic Attiva anticipato. Quest’ultimo usa un alias e risposte HTTP/SSE fittizi in memoria: una sola chiamata al falso alias per la baseline, nessuna seconda chiamata quando readiness passa da false a true, un solo listener dopo approvazione simulata, Stop definitivo. Tutta la rete reale del browser di test è bloccata; nessun invio `ui/message`, tool call o sampling reale. Questo browser è solo un test del componente, non un controller e non un prerequisito del percorso live dell’utente.

Smoke del comando operatore effettuato realmente su loopback il 16/09 alle 06:15 UTC: avvio, `report` senza sessioni, emissione di un codice locale, `shutdown`. **Non è uno smoke di ChatGPT**: nessun codice è stato inserito in una card reale e nessun evento bridge è stato emesso. Il processo è stato fermato e la capability amministrativa rimossa.

Avvio temporaneo alternativo (foreground, senza servizi permanenti). **Non eseguirlo adesso: l’istanza è già attiva come unità utente transitoria**, descritta sotto:

```bash
WIDGET_WAKE_ENABLED=1 \
WIDGET_WAKE_IFRAME_ORIGIN=https://asdk_app_fixture_4e9e3f37063f.web-sandbox.oaiusercontent.com \
pnpm start
```

Ascolta **solo** `127.0.0.1:8807` (MCP/canale card) e `127.0.0.1:8808` (amministrazione). Senza flag rimane inerte. Nessun tunnel viene creato automaticamente. Il file `operator.json` è esclusivo: una seconda istanza fallisce invece di sostituire credenziali. Se un crash lascia il file, accertare prima che il processo non esista; non cancellare file del controller precedente.

Da un secondo terminale nella stessa directory:

```bash
pnpm operator report
pnpm operator issue
# Aprire nel proprio editor il codeFile stampato: non copiarne il contenuto nella chat.
# SESSION_ID ed EVENT_ID sotto sono i marker restituiti, non segreti.
pnpm operator observe SESSION_ID EVENT_ID model-tool worker-000000007c41d5e30ad0 foreground --target-confirmed --turn-ended
pnpm operator emit SESSION_ID
pnpm operator report
pnpm operator stop SESSION_ID
pnpm operator shutdown
```

Non eseguire `observe ... model-tool` prima di aver realmente visto la chiamata e il risultato. Per esiti diversi: `message-only`, `no-turn`, `approval`, `tool-missing`, `worker-mismatch`; usare `unknown` al posto del worker se non restituito. Un esito negativo ferma la sessione. L’osservazione dopo il timeout bridge può essere registrata, entro la scadenza della sessione, ma non riabilita il listener. `report` è redatto; si può conservarne l’output per correlare i marker. Non riusare il codice dello smoke locale già arrestato.

## Pubblicazione autorizzata — applicata il 16/09 alle 07:32 UTC

Prima dell’intervento, tutti i percorsi dell’host andavano a `127.0.0.1:4024`. È stata preservata quella regola, aggiungendo solo la route qui sotto. La porta 8797, occupata da un processo precedente, non è stata toccata.

Interventi eseguiti dopo l’autorizzazione:

1. Avviato il prototipo su loopback 8807/8808, processo `2951629`, in una **unità utente transitoria**, non abilitata al boot. Nessun servizio di produzione nuovo:

   ```bash
   systemd-run --user --unit=gemrouter-widget-wake-probe \
     --description='Temporary GemRouter widget wake microtest' --collect \
     --property=Type=exec \
     --property=WorkingDirectory=/home/OPERATOR/INFRA/gem-router/experiments/chatgpt-widget-wake \
     --property=UMask=0077 --property=NoNewPrivileges=yes \
     --setenv=WIDGET_WAKE_ENABLED=1 \
     --setenv=WIDGET_WAKE_IFRAME_ORIGIN=https://asdk_app_fixture_4e9e3f37063f.web-sandbox.oaiusercontent.com \
     /home/OPERATOR/.local/bin/node --import tsx main.ts
   ```

2. Inserita **prima** della regola generica esistente la seguente regola in `ops/cloudflared/gemrouter.yml`:

   ```yaml
   - hostname: gemrouter.example.com
     path: ^/widget-wake-probe/.*
     service: http://127.0.0.1:8807
   ```

3. Validata la configurazione e la selezione delle regole: prototipo→8807; percorso AIR3→4024. Riavviato **solo** il tunnel. `sudo` e `systemctl restart --no-ask-password` richiedevano autenticazione interattiva; verificati proprietario `funboy`, eseguibile, PID e `Restart=always`, è stato inviato **SIGTERM ordinato al solo PID 2381** alle 07:32:33 UTC. Il supervisore ha riavviato il tunnel alle 07:32:38, nuovo PID `2951919`. Non copiare il vecchio PID per interventi futuri: va risolta e verificata ogni volta l’identità corrente.

   ```bash
   /usr/local/bin/cloudflared tunnel --config /home/OPERATOR/INFRA/gem-router/ops/cloudflared/gemrouter.yml ingress validate
   ```

Durante la riconnessione è stata osservata una risposta **HTTP 530**, poi `/health` è tornato **HTTP 200**. La durata esatta dell’indisponibilità non è misurata: i circa 5 secondi fra segnale e avvio servizio non certificano il tempo di ripristino edge. **Nessun restart di `gemrouter.service`**: PID `2891750`, attivo dal 16/09 alle 03:30:06 UTC, invariato prima/dopo. Nessun rebuild della sua `dist`, DNS nuovo, esposizione della porta 8808 o cambio grant.

URL MCP **pubblicato e verificato**, da inserire nella configurazione del plugin (non è una pagina di onboarding da aprire direttamente):

```text
https://gemrouter.example.com/widget-wake-probe/mcp
```

La route inoltra solo `/widget-wake-probe/*`; emissione, osservazione e shutdown sono sull’altro listener. GET sul percorso MCP risponde 405 per design: MCP usa POST. Il GET senza credenziali sul percorso AIR3 restituisce 401 (autenticazione preservata, nessun tool invocato). POST pubblico su `/widget-wake-probe/emit` restituisce 404. Entrambi i listener risultano legati esclusivamente a `127.0.0.1`.

Stato/arresto del solo prototipo:

```bash
systemctl --user status gemrouter-widget-wake-probe.service --no-pager
# Solo a fine prova, dopo avere salvato il report:
pnpm operator shutdown
# Oppure: systemctl --user stop gemrouter-widget-wake-probe.service
```

Il prototipo è lasciato attivo; le sessioni 0.1.1/0.1.2 sono concluse e una nuova prova 0.1.3 è predisposta sotto. Non è un servizio permanente né una promessa di disponibilità continua. Il rollback consiste nel rimuovere **solo** la regola/commento sperimentale dal file ingress, validare e riavviare nuovamente il solo tunnel; preservare tutte le altre regole e GemRouter. Non arrestare semplicemente il prototipo lasciando credere che il suo endpoint sia ancora utilizzabile.

### Smoke pubblico del solo trasporto — 07:33:34 UTC

Client MCP SDK reale verso l’HTTPS pubblicato, **non ChatGPT, non modello e non un widget montato**. Nessun enrollment né evento emesso. Sono stati chiamati esclusivamente discovery, risorsa e renderer statico del prototipo; nessuno dei tre tool AIR3.

| Operazione | Esito | Tempo individuale dal client |
| --- | --- | ---: |
| Initialize | GemRouter Wake Probe / widget-wake-0.1.0 | 417,87 ms |
| tools/list | Solo `render_wake_probe` | 136,27 ms |
| resources/list | Una card | 84,19 ms |
| resources/read | MIME corretto, corrispondenza esatta con build locale | 373,97 ms |
| Renderer statico | Risposta senza errore, nessuna attivazione | 117,53 ms |
| OPTIONS canale SSE | 204, origine consentita esatta | 63,71 ms |
| GET SSE senza capability | 401 | 71,18 ms |

Card pubblica: 529082 byte, SHA-256 `bb4239276e0f4673e45f28911902665d30d71e3d35b2d2216e2eea44be646471`. Le misure sono singoli round trip con clock monotono nello stesso client; **non** sono latenze di wake. CORS è stato verificato a livello di risposta HTTP; CSP applicata dal browser, enrollment della card e connessione SSE dall’iframe **restano da provare nell’host reale**.

### Aggiornamento 0.1.1 dopo «Autorizza questa card» disabilitato — 08:20 UTC

L’operatore ha riferito la presenza della card e il pulsante disabilitato. La sessione `session_fixture_6c48ca1af541`, emessa alle 08:09:47, è rimasta `issued`, con zero eventi/ricevute e nessun listener: il codice non è stato consumato. Il suo TTL di enrollment era già scaduto. La sessione è stata esplicitamente fermata prima dell’aggiornamento; **quel codice non è più utilizzabile**.

Un test isolato del bundle 0.1.0 ha riprodotto un errore non gestito, `crypto.randomUUID is not a function`, prima di initialize, in un contesto che non espone quel metodo. Questa è una causa **riprodotta nel test**, non ancora confermata nel browser dell’operatore. Ora l’ID del mount usa `crypto.getRandomValues` come alternativa crittografica; senza CSPRNG la card mostra un errore e resta bloccata, senza fallback debole. L’avvio ha un errore visibile invece di lasciare pulsanti immobili senza spiegazione.

È stato inoltre corretto il requisito troppo rigido sulla capability opzionale, come descritto sopra. La card mostra build, stato initialize, metodo effettivo e origine del proprio iframe, senza leggere l’URL della chat o credenziali. Il rilevamento tardivo dell’alias non riattiva Stop e non cambia metodo dopo enrollment.

Alle **08:20:32 UTC** è stata riavviata **soltanto l’unità utente transitoria del prototipo**, nuovo PID `2962695`. Nessun nuovo riavvio del tunnel (`2951919`) né di GemRouter (`2891750`). `/health` risponde 200. La lettura HTTPS alle **08:21:07 UTC** ha verificato build `widget-wake-0.1.1`, risorsa `ui://gemrouter-wake-probe/card-0.1.1.html`, 531126 byte e SHA-256 `a472359107584c5a3f6b6027da5e751af38ad98bc877116b6db0d32a37d884c3` uguale al build locale.

Tempi individuali dello smoke di trasporto aggiornato: initialize **579,12 ms**, tools/list **162,63 ms**, resources/read **368,10 ms**. Nessun tool è stato invocato da questo smoke. Rimane **INCONCLUDENTE** per il wake: nessuna chiamata `gateway_status` dal modello è stata dimostrata.

Per caricare questa correzione, aggiornare/Refresh **solo GemRouter Wake Probe**, non AIR3, e richiamare il renderer nella **stessa chat esatta**, senza creare un’altra conversazione. Verificare nel titolo `widget-wake-0.1.1`; se l’host non applica il refresh alla conversazione esistente, riportare il vincolo senza aggirarlo. Il reload qui precede interamente la baseline A: non è una prova di persistenza B/C. Generare un nuovo codice solo dopo aver verificato che il pulsante di enrollment sia utilizzabile.

### Origin effettiva dell’app: CORS corretto — 09:15 UTC

L’operatore ha fornito la diagnostica **della card reale**: build 0.1.1, initialize riuscita, contesto sicuro, alias presente, origin `https://asdk_app_fixture_4e9e3f37063f.web-sandbox.oaiusercontent.com`, sessione `nessuna`, errore `connection_or_bridge_error`. Il testo incollato aveva il pulsante «Ricontrolla» unito alla punteggiatura dopo l’origin: non è parte dell’hostname. L’App ID riportato nella connessione corrisponde al prefisso del dominio.

La richiesta OPTIONS pubblica di enrollment con quell’Origin ha restituito **403 `origin_denied`** alle 09:13:56 UTC. La configurazione runtime ammetteva soltanto `https://web-sandbox.oaiusercontent.com`. Questo mismatch è stato quindi riprodotto sul server; spiega perché un browser non può leggere la risposta di enrollment e mostra un errore di rete generico. Il report amministrativo non conteneva sessioni: nessun enrollment valido, wake o tool call.

È stata ricreata solo l’unità utente transitoria del prototipo con l’esatta `WIDGET_WAKE_IFRAME_ORIGIN` osservata, PID `2973008`. Nessun codice runtime/bundle, metadato MCP, grant, route di produzione, servizio GemRouter o tunnel modificato in questo intervento; nessuna nuova app o chat creata. Il titolo resta **0.1.1**: non serve un altro refresh della connessione o reinstallare l’app, ma la card fermata deve essere ricaricata prima di usare un nuovo codice. Alla ricreazione del plugin, se cambia App ID, questa allowlist va aggiornata esplicitamente: non autorizzare tutte le app con una wildcard.

Verifica pubblica alle **09:16:14 UTC**, clock monotono dello stesso client, senza account o bridge simulati:

| Richiesta | Esito | Tempo |
| --- | --- | ---: |
| Preflight dall’origine effettiva dell’app | 204, `Access-Control-Allow-Origin` esattamente uguale | 257,62 ms |
| Preflight dall’origine generica | 403, nessun allow-origin | 180,08 ms |
| Preflight da app sorella | 403, nessun allow-origin | 60,47 ms |
| Enrollment con codice deliberatamente invalido dall’origine ammessa | 401 `invalid_or_expired_code`, errore leggibile tramite CORS | 96,02 ms |

Queste prove certificano risposte HTTP/configurazione, non l’enrollment della card o un wake ChatGPT. Nessun codice valido è stato usato dallo smoke, nessun evento emesso. La CSP dichiarata resta invariata; `/health` resta 200.

**Badge «CSP off»:** riferito dall’operatore, non osservato direttamente. Le pagine ufficiali consultate descrivono CSP e dominio del componente ma non definiscono questa specifica etichetta. Non è corretto dedurne la causa del 403 (riprodotto nel controllo CORS del nostro server), né affermare che il sandbox stia applicando la policy. Non è stato richiesto o implementato alcun bypass/disattivazione CSP. Verificare separatamente il controllo nell’host; se commutabile, mantenerlo attivo per la baseline. L’avviso «unique domain required for app submission» riguarda la submission, non dimostra un prerequisito mancante di questo test in developer mode. [Reference](https://developers.openai.com/plugins/reference), [diagnostica widget](https://developers.openai.com/plugins/deploy/troubleshooting).

### Baseline manuale reale — 09:20 UTC

Sessione `session_fixture_41070ae77ecc`, scadenza 09:33:51.785 UTC. Evento manuale `probe_fixture_1c942f4265b3`, creato all’enrollment alle 09:19:58.960 UTC. Il server ha ricevuto queste ricevute dalla card autorizzata, con visibilità dichiarata `visible`:

| Ricevuta | Timestamp server UTC | Tempo dal widget | Emissione→ricevuta server |
| --- | --- | ---: | ---: |
| `received` | 09:20:04.164 | 0,1 ms | 5204,12 ms |
| `bridge_requested` | 09:20:04.351 | 0,1 ms | 5391,54 ms |
| `bridge_resolved`, `accepted` | 09:20:04.565 | 98,5 ms | 5604,85 ms |

Il tempo dall’emissione include l’attesa del clic dopo enrollment e il ritorno delle ricevute: **non è una latenza del modello o di MCP**. I 98,5 ms misurano la risoluzione del bridge dal momento di ingresso nel widget, non la completion.

L’operatore ha incollato la card con lo stesso marker, poi `Called tool` e `probe_fixture_1c942f4265b3 — workerId: worker-000000007c41d5e30ad0 — stato: released.` Questa è evidenza riferita dalla chat, non una risposta inventata dal widget né una chiamata di Codex. È stata registrata con `observe ... model-tool ... foreground --target-confirmed --turn-ended`; la risposta conferma `source: operator_reported`, `serverVerified: false`. La traccia espansa completa del tool non è stata acquisita e i tempi di generazione/invocazione rimangono n/d. Il solo `released` non è un fallimento di questo microtest e non autorizza `gateway_open` o polling.

Al controllo precedente alla registrazione, `connected: false`, `state: authorized`, `remoteCount: 0`: nessun evento remoto ancora inviato. È stato richiesto all’operatore il singolo clic di attivazione del listener; nessun riavvio del prototipo o di produzione effettuato in questa fase.

### Primo evento remoto B — 09:28 UTC

L’operatore ha confermato «Armato, SSE connesso»; il server ha riscontrato `armed`, `connected: true`, `remoteCount: 0`. Dopo ulteriori **32 s** senza interventi sulla chat da parte dell’agente, è stato eseguito una sola volta `pnpm operator emit session_fixture_41070ae77ecc`. Evento `probe_fixture_3581de462d98`, emesso alle **09:28:24.552 UTC**, scadenza 09:29:24.552 UTC.

| Ricevuta | Timestamp server UTC | Tempo dall’ingresso nel widget | Emissione→ricevuta server |
| --- | --- | ---: | ---: |
| `received` | 09:28:24.920 | 178,3 ms | 367,81 ms |
| `bridge_requested` | 09:28:25.098 | 178,3 ms | 545,63 ms |
| `bridge_resolved`, `accepted` | 09:28:25.271 | 181,1 ms | 718,23 ms |

Metodo `openai.sendFollowUpMessage`; visibilità dichiarata `visible`; listener ancora connesso al primo controllo dopo le ricevute, `remoteCount: 1`. Il tempo prima dell’invio include la validazione autenticata TTL dell’evento; l’attesa della Promise bridge è circa **2,8 ms** nello stesso clock browser. Non misura l’inizio della generazione. Nessuna chiamata diretta al gateway da Codex/prototipo.

**Esito osservato:** l’operatore ha prima riferito «non vedo altri called tools», poi, alla domanda distinta su messaggio e generazione, ha confermato «Nessun nuovo messaggio o risposta: è ferma al risultato precedente». Osservazione `no-turn` registrata alle **09:30:54.592 UTC**, 150,04 s dopo l’emissione; questo intervallo arriva alla registrazione del resoconto e non è una misura continua del browser. Worker e latenza MCP per B: **n/d**, non riusare il risultato `released` di A.

Al controllo server delle **09:30 UTC** la sessione risultava già `stopped`, `connected: false`, prima della scadenza 09:33:51.785 UTC e prima del comando `observe ... no-turn`. Nessun comando Stop, shutdown o restart era stato eseguito dall’agente in quell’intervallo. Il prototipo non conserva la causa/timestamp di ogni stop: non possiamo attribuire la chiusura a teardown dell’host, rete o altra azione. Le tre ricevute erano già arrivate prima della chiusura. Non è stato effettuato alcun reconnect, riarmo, secondo metodo o ulteriore evento per aggirare l’esito.

**C non eseguita:** senza successo B e senza listener non sarebbe la ripetizione richiesta dello stesso wake dopo idle. Nemmeno background/offscreen provati. Non sono state implementate integrazione coda, inferenza o nuove architetture dopo il verdetto. Il comportamento diverso fra clic e invio remoto è osservato in questo test, ma **non prova da solo un requisito di user gesture della piattaforma**. Lo stato successivo del badge «CSP off» resta non confermato.

GemRouter verificato ancora attivo con PID `2891750`, avviato alle 03:30:06 UTC; prototipo ancora PID `2973008`, avviato alle 09:15:18 UTC. Nessun riavvio o modifica runtime in questa prova, grant AIR3 intatto. La sessione di test è fermata; il servizio temporaneo resta attivo, non è stato eseguito rollback dell’ingress.

## Riprova 0.1.2 con durata 24 ore — 09:39 UTC

L’operatore ha richiesto «il codice ha un expire troppo breve, prova 24 ore». Sono stati estesi sia `CODE_MS` sia `SESSION_MS` a **86.400.000 ms**. Il codice già usato e la vecchia sessione fermata non vengono riutilizzati. TTL singolo evento 60 s, timeout bridge 15 s, massimo 6 eventi, gate A→B→C e stop su disconnect rimangono invariati. La card distingue i limiti e mostra la scadenza effettiva dopo enrollment.

Alle **09:38:50 UTC** è stata riavviata solo `gemrouter-widget-wake-probe.service`, unità utente temporanea, PID **2982093**. Non una seconda istanza e nessun database aperto. GemRouter resta PID `2891750` dal 16/09 03:30:06 UTC; `cloudflared-gemrouter.service` resta PID `2951919` dal 07:32:38 UTC. `/health` pubblico 200. Nessuna modifica a tunnel, grant, tool AIR3, routing o coda. L’origin specifica autorizzata è stata preservata.

Smoke pubblico **del solo trasporto, non ChatGPT**: initialize **494,11 ms**, resources/list **147,93 ms**, resources/read **396,05 ms**, preflight CORS dall’origine effettiva **204 in 61,56 ms**. Risorsa `ui://gemrouter-wake-probe/card-0.1.2.html`, **531435 byte**, SHA-256 `4a3caf47f6f4652507c9febec13305a98d12cacb502c6852f2556f656f26c732`, uguale alla build locale e con testo «24 ore». Nessun renderer/tool AIR3 invocato dallo smoke; nessun enrollment o evento fittizio sulla sessione live.

Nuova sessione predisposta alle **09:39:31.114 UTC**: `session_fixture_0eed9ca6d2e5`, scadenza **17/09/2026 09:39:31.114 UTC / 11:39 CEST**, `codeExpiresInSeconds: 86400`. Il segreto è solo nel file privato `~/.local/share/gemrouter-widget-wake/session_fixture_0eed9ca6d2e5.code`, mai in questo report. All’emissione: `issued`, nessun evento o listener.

Passaggio interattivo richiesto: aggiornare solo GemRouter Wake Probe, ottenere nella **stessa chat** la card `widget-wake-0.1.2`, inserire il nuovo codice nella card e premere Autorizza. Eseguire A una sola volta entro 60 s dall’enrollment e fornire la traccia tool; B/C seguiranno soltanto dopo la conferma. Non creare nuove chat, non aggiornare AIR3, non ripetere OAuth, non riarmare il vecchio test. **Pronto per la nuova prova, non wake live verificato né test di permanenza di 24 ore completato.**

### Prova 0.1.2: baseline riuscita, clic Attiva anticipato — 09:44–09:49 UTC

Sessione `session_fixture_0eed9ca6d2e5`, manuale `probe_fixture_92860447d65f`, emesso all’enrollment **09:44:15.388 UTC**, TTL fino alle 09:45:15.388. Ricevute reali, metodo alias, visibilità `visible`:

| Ricevuta | Timestamp server UTC | Tempo dall’ingresso widget | Emissione→ricevuta server |
| --- | --- | ---: | ---: |
| `received` | 09:44:26.896 | 0,1 ms | 11508,03 ms |
| `bridge_requested` | 09:44:27.116 | 0,1 ms | 11727,58 ms |
| `bridge_resolved`, `accepted` | 09:44:27.300 | 78,9 ms | 11911,29 ms |

L’operatore ha riferito `Called tool` e worker corretto; stato restituito non incollato in questo giro, quindi **n/d**, senza riusare quello della 0.1.1. Osservazione `model-tool`, worker atteso, registrata alle **09:49:27.212 UTC**, `source: operator_reported`, `serverVerified: false`.

Prima di quella registrazione aveva premuto Attiva: il server ha rifiutato correttamente `/events` con `manual_baseline_not_verified`, ma il client trattava erroneamente la precondizione non pronta come errore terminale. Ha quindi inviato Stop, cancellato il token in memoria e disabilitato la card. Il report registra **`widget_stop` alle 09:47:53.172 UTC**, scadenza sessione ancora al **17/09 09:39:31.114 UTC**, `remoteCount: 0`, `connected: false`. La registrazione tardiva non riapre la sessione fermata. Non è un timeout né un problema di dominio dedotto; il difetto di sequenza client è riprodotto/corretto nella 0.1.3.

**Avviso Widget domain:** la reference ufficiale verificata indica `_meta.ui.domain` come origine dedicata obbligatoria alla submission di un plugin con UI; non lo descrive come un mantenimento in vita dell’iframe. Il renderer/risorsa MCP del prototipo è già pubblico senza OAuth. I canali enrollment/eventi restano protetti e l’emissione resta sul listener amministrativo loopback. Nessun dominio aggiunto, wildcard CORS o rimozione di auth per inseguire l’avviso. [Reference OpenAI, metadati risorsa](https://developers.openai.com/plugins/reference).

### Pubblicazione correzione 0.1.3 — 09:53 UTC

Riavviata **solo** l’unità utente temporanea del prototipo alle **09:53:34 UTC**, PID **2986055**, dopo i test. GemRouter e tunnel ancora rispettivamente PID `2891750` e `2951919`, con orari di avvio invariati. Nessuna nuova route, dominio, apertura senza auth, concessione OAuth o tool AIR3 chiamato.

Smoke **HTTPS/MCP di trasporto, non chat**: initialize **405,84 ms**, resources/list **137,55 ms**, resources/read **378,51 ms**. Risorsa pubblica senza autenticazione `ui://gemrouter-wake-probe/card-0.1.3.html`, **531987 byte**, SHA-256 `9a46c5f3c3f39883b55571c2c86e4e5fd5ff24a36f519dbc49ce27c2b2cd05a7`, uguale alla build locale. Nuovo `/readiness` senza capability: **401 in 59,86 ms**; origine non ammessa: **403 in 70,43 ms**. Non è stato creato un enrollment fittizio nel processo live.

Nuovo codice/sessione `session_fixture_c3705f1074c7`, emesso alle **09:54:11.914 UTC**, scadenza **17/09 09:54:11.914 UTC / 11:54 CEST**; segreto nel solo file privato `~/.local/share/gemrouter-widget-wake/session_fixture_c3705f1074c7.code`. Al controllo delle 09:54:33: `issued`, zero eventi, nessun listener. Richiesto all’operatore refresh del solo prototipo, stessa chat, nuova baseline e invio del risultato prima dell’attivazione. La vecchia baseline rimane documentata ma non viene attribuita a questo nuovo marker/mount. Il tentativo 24 ore resta **INCONCLUDENTE** fino alla nuova prova remota; 26 test + 6 scenari DOM sono **SIMULATI** e non la sostituiscono.

### Baseline manuale 0.1.3 — 09:59 UTC

Sessione `session_fixture_c3705f1074c7`, scadenza invariata al **17/09 09:54:11.914 UTC**. Evento manuale `probe_fixture_8c1411d4f33a`, creato all’enrollment **16/09 09:59:18.820 UTC**, TTL fino alle 10:00:18.820 UTC. Metodo effettivo `openai.sendFollowUpMessage`, visibilità della card `visible`.

| Ricevuta | Timestamp server UTC | Tempo dall’ingresso widget | Emissione→ricevuta server |
| --- | --- | ---: | ---: |
| `received` | 09:59:23.025 | 0,1 ms | 4204,87 ms |
| `bridge_requested` | 09:59:23.324 | 0,1 ms | 4504,62 ms |
| `bridge_resolved`, `accepted` | 09:59:23.505 | 133,7 ms | 4685,45 ms |

L’operatore ha incollato `probe_fixture_8c1411d4f33a — workerId: worker-000000007c41d5e30ad0 — stato: released`. Esito registrato come `model-tool`, `source: operator_reported`, `serverVerified: false`: non è una chiamata diretta del prototipo/Codex e l’agente non ha controllato la UI della chat. L’ultimo controllo prima della registrazione mostra `authorized`, `connected: false`, `remoteCount: 0`, nessun motivo di stop. Richiesto il singolo clic Attiva dopo conferma; B/C ancora da eseguire. I tempi sopra non misurano generazione o chiamata MCP.

### Evento remoto B della 0.1.3 — 10:01 UTC

Dopo conferma dell’operatore «Armato, SSE connesso» e riscontro `armed/connected` nel server, trascorsi ulteriori **32 secondi** senza interazioni dell’agente con la chat, emesso una sola volta `probe_fixture_14df0103ff3b` alle **10:01:44.546 UTC / 12:01:44 CEST**. Scadenza dell’evento 10:02:44.546 UTC; la sessione resta valida fino al giorno successivo. Metodo `openai.sendFollowUpMessage`; visibilità dichiarata `visible`.

| Ricevuta | Timestamp server UTC | Tempo dall’ingresso widget | Emissione→ricevuta server |
| --- | --- | ---: | ---: |
| `received` | 10:01:44.896 | 163,7 ms | 349,65 ms |
| `bridge_requested` | 10:01:45.051 | 163,7 ms | 504,97 ms |
| `bridge_resolved`, `accepted` | 10:01:45.226 | 166,1 ms | 679,74 ms |

I primi 163,7 ms includono il controllo autenticato TTL; la Promise si è risolta dopo circa **2,4 ms** dalla richiesta nello stesso clock browser. Ricevuta finale al server entro 679,74 ms: include viaggio di ritorno e serializzazione, **non è latenza MCP o generazione**. `accepted` è la classificazione del prototipo per risoluzione senza errore rilevato, non un’attestazione host di turno avviato. Primo controllo dopo invio: `armed`, `connected: true`, `remoteCount: 1`, `stopReason: null`, `stoppedAt: null`.

L’operatore ha risposto «niente, la card no nfa niente e non arriva called tools». Un ulteriore controllo server alle **10:03:04 UTC**, circa **79,5 s dopo l’emissione**, mostra ancora `armed`, `connected: true`, nessuno stop. Quindi il listener non è caduto e la sessione non è scaduta durante questa finestra; anche il TTL evento era già trascorso senza chiudere il listener dopo la ricevuta positiva.

Esito `no-turn` registrato alle **10:03:33.373 UTC**, `source: operator_reported`, `serverVerified: false`. È **questo comando** ad aver fermato la prova: `stopReason: negative_observation`, `stoppedAt: 10:03:33.373 UTC`. L’intervallo emissione→registrazione è 108,827 s, non una latenza del modello e non una registrazione video continua del browser. Nessun worker restituito per B; il `released` di A non viene riciclato. Nessun secondo evento C emesso. Il servizio temporaneo resta attivo, la sessione è conclusa. GemRouter PID `2891750` e tunnel PID `2951919` verificati invariati; nessun deploy/restart in questa prova.

## Checklist live A → B → C

Endpoint ora pronto. I primi passaggi richiedono il normale browser autenticato dell’operatore; Codex non controlla quella UI:

1. Nel **tuo normale browser autenticato**, apri ChatGPT. Se necessario: Settings → Security and login → Developer mode. Plugins → `+` → New Plugin. Nome: **GemRouter Wake Probe**; descrizione: `Microtest diagnostico manuale del bridge`; Connection: **Server URL**, URL sopra; Authentication: **None / No authentication**. Nessuna credenziale AIR3 né Codex. Esamina e accetta solo i consensi necessari a questa app statica. I nomi possono variare; se la GUI non permette questa sequenza, riportare il punto senza aggirarlo.
2. Torna alla chat **`https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582`**. Conferma tu l’URL; l’iframe non può attestarlo. Mantieni **Example - Trade**, modello e impostazioni invariati; aggiungi **GemRouter Wake Probe** alla stessa conversazione. Se non è possibile, fermarsi: nessuna nuova chat autorizzata.
3. Unico messaggio iniziale manuale: `Mostra una sola volta la card render_wake_probe di GemRouter Wake Probe. Poi termina. Non chiamare gateway_open, gateway_exchange o altri tool.` Attendi la fine del turno. La card deve comparire **disarmata**, senza messaggi automatici.
4. Esegui `pnpm operator issue`, apri privatamente il `codeFile` stampato e incolla nella **card**, non nella chat, entro 24 ore dall’emissione nella 0.1.2. Premi **Autorizza questa card**. Leggi prompt, scadenza effettiva e limiti; annota metodo/capability. Il codice non è un login OpenAI e non tocca AIR3. Enrollment tardivo non rinnova la sessione: codice e sessione hanno la stessa scadenza assoluta.
5. **A — baseline**: entro 60 s dall’enrollment, con turno iniziale concluso, premi una sola volta **Prova manuale del bridge**. Osserva separatamente risposta bridge, nuovo messaggio, generazione, traccia `gateway_status` di AIR3 e worker restituito. Non basta il testo del modello che dice di averlo fatto: espandere la traccia tool. Annota il marker e, dopo fine turno, registra l’osservazione con il comando `observe`.
6. Solo con baseline completa e osservazione registrata: premi **Attiva ascolto di prova** una volta e verifica **Armato, SSE connesso**. Nella 0.1.3 un clic anticipato mostra «In attesa della verifica» senza fermare la sessione o aprire il listener: attendere la conferma dell’operatore, poi premere di nuovo Attiva; non ripetere la baseline. Dopo connessione, lasciare la chat in primo piano, non scrivere bozze e non interagire ulteriormente. Veri errori di trasporto restano terminali: nessun riarmo automatico.
7. **B — remoto**: dopo almeno **30 s** dall’ultimo gesto e dalla fine del turno, il server/operatore esegue `pnpm operator emit SESSION_ID` una sola volta. Codex può eseguire questo comando esterno, **non** il tool AIR3. Osserva la catena completa e le eventuali richieste di approvazione. Registra `observe` soltanto quando il turno è terminato. Nessun clic per aiutare l’evento.
8. **C — dopo idle**: senza reload, altri messaggi o riarmo, attendi almeno **120 s** dalla fine del turno B e dalla registrazione dell’osservazione. Emetti un secondo evento con lo stesso comando: avrà un nuovo marker. Richiedi la stessa catena. Il gate server applica le attese dopo l’osservazione/arm, in modo conservativo; non indovina il vero fine-turno.
9. Se il componente si smonta, SSE si chiude o serve una conferma a ogni evento, annotalo e fermati. Non automatizzare consensi né passare al metodo alternativo per lo stesso evento. Soltanto dopo A/B/C riusciti, eventuali prove distinte background/offscreen entro il budget; nessuna di esse è già effettuata.
10. Conserva `report`, evidenza della traccia tool senza credenziali/handle, condizioni e fonte. Stop/shutdown del prototipo; rollback pubblico solo secondo l’autorizzazione ricevuta.

## Misure della prova 0.1.1 e criterio finale

Per evento, il report conserva marker, modalità, timestamp emesso, ricevute e osservazione attribuita. `elapsedMs` è misurato **nel widget** da ingresso evento a richiesta/risposta bridge. `emissionToReceiptMs` è misurato **nel server** fino al ritorno della ricevuta: include il viaggio di ritorno, non è latenza esatta di ingresso widget né tempo del tool. Il controllo TTL remoto usa un’ulteriore chiamata autenticata e ne include il costo.

Emissione→ingresso widget esatta: **n/d** senza clock condiviso; emissione→invocazione MCP e inizio generazione: **n/d** finché manca una traccia confrontabile. `recordedAt` dell’osservazione è quando l’operatore la registra, non quando il tool è stato eseguito. Nessuna sottrazione browser/server viene venduta come misura precisa. `lastExchangeAt` e `lastSuccessfulCompletionAt` non attestano `gateway_status` e non sono usati per questo scopo.

| Fase live | Marker | Ricezione→richiesta bridge | Bridge | Nuovo turno / tool / worker | Fonte |
| --- | --- | --- | --- | --- | --- |
| A manuale | `probe_fixture_1c942f4265b3` | 0,1 ms | alias, `accepted` a 98,5 ms | Riferiti `Called tool`, worker atteso, `released` | Ricevute server + resoconto operatore, non verifica server del modello |
| B remoto ≥30 s | `probe_fixture_3581de462d98` | 178,3 ms (include check TTL) | alias, Promise risolta a 181,1 ms | **Nessun messaggio/turno**, worker n/d | Ricevute server + osservazione negativa dell’operatore |
| C remoto ≥120 s | n/d | n/d | non eseguito | B fallita, listener chiuso | nessuna |

**GO SPERIMENTALE** soltanto con due eventi remoti distinti B/C che avviano nuovi turni e invocano `gateway_status` dal modello nel target esatto, senza nuovi clic, riarmo o reload. **NO-GO NELLE CONDIZIONI TESTATE** soltanto dopo un impedimento realmente osservato nell’host. Per prerequisiti mancanti, setup non verificato o wake senza accesso AIR3 dimostrato: **INCONCLUDENTE**. Nessuno di questi esiti implementa già inferenza, completion HTTP o integrazione della coda.
