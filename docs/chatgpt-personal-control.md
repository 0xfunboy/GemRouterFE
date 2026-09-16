# Controllo della chat personale e wake MCP

Aggiornamento del 16 settembre 2026. **Controllo della chat personale non verificato live.** Il timer di produzione preesistente ha riavviato il servizio alle 03:30 UTC caricando la baseline del controllore, ancora disabilitata; le correzioni del 16 settembre non sono state distribuite. Questa guida descrive codice eseguibile e prerequisiti reali, non una promessa di disponibilità permanente.

## Onboarding interattivo reale, senza secondo gateway

`pnpm onboard:chatgpt-control` avvia una pagina temporanea su **127.0.0.1:8796**, per massimo due ore, con il runtime Codex ufficiale e il bridge esistente. Non avvia `src/index.ts`, non importa lo store, non possiede una coda e non legge/copia token MCP. Si esegue come `funboy`, con gli stessi profili dedicati previsti dall'integrazione. Il device login è reale, non simulato; password/MFA restano all'operatore.

Sono due autenticazioni diverse e non intercambiabili: il login OAuth di Codex abilita il processo Codex App Server (`thread/start`/`turn/start`), mentre il grant OAuth MCP di Example - Trade abilita ChatGPT a chiamare GemRouter. Nessuno dei due è una sessione autenticata di `chatgpt.com` né autorizza un endpoint per inviare messaggi alla chat personale. Per questo il bridge richiede il browser dedicato autenticato dall'operatore; senza quel profilo il controllore non può raggiungere la chat.

1. In VS Code Remote SSH, inoltra la porta **8796** di `airewebnode`, mantenendola privata.
2. Nel terminale remoto esegui `cat /home/OPERATOR/.local/share/gemrouter-personal-control/onboarding-access.txt` e apri il link privato. Il file è `0600`; la chiave di accesso non compare nei log HTTP e non va copiata nella documentazione o nella chat.
3. Premi **Avvia login con codice dispositivo**. URL ufficiale e codice temporaneo vengono mostrati solo alla sessione della pagina che ha iniziato il login. La pagina verifica il completamento tramite il runtime. Se scade, avvia un nuovo login: non riutilizzare codici precedenti.
4. Il profilo persistente è `/home/OPERATOR/.local/share/gemrouter-personal-control/codex`; il browser usa la directory sorella `browser`. Chiudere l'onboarding non effettua logout né elimina questi profili.

Sul server sono presenti Xvfb, Chrome, Xauth e i tool X11. Dopo l'autorizzazione e l'intervento dell'operatore, il 16 settembre sono stati verificati anche `x11vnc`, `novnc`, `websockify`. Su un altro host l'installazione di sistema richiede autorizzazione distinta: `sudo env NEEDRESTART_MODE=l apt-get install --no-install-recommends x11vnc novnc websockify`. Nessun installer automatico è incluso.

Dopo l'installazione autorizzata:

```sh
bash ops/control-browser-display.sh start --foreground
# Lascia aperta questa sessione. Da un secondo terminale:
# Nella pagina privata: “Apri il browser del bridge”
bash ops/control-browser-display.sh viewer --foreground
# Lascia aperta anche la sessione viewer. Da un altro terminale:
bash ops/control-browser-display.sh status
```

Se il terminale/runner termina i processi figli (come osservato sul server),
supervisiona il viewer con una unità **utente transiente**, non persistente:

```sh
systemd-run --user --unit=gemrouter-control-viewer --collect \
  --working-directory=/home/OPERATOR/INFRA/gem-router \
  /usr/bin/bash ops/control-browser-display.sh viewer --foreground
```

`systemctl --user stop gemrouter-control-viewer.service` chiude solo il viewer;
`--collect` ne rimuove l'unità al termine. Non usare `enable`, non creare un
servizio di sistema e non inoltrare porte pubbliche.

Il launcher prepara il display privato **:95** con Xauth. `--foreground` mantiene la sessione di comando aperta: il solo `nohup` non protegge dalla terminazione dei discendenti da parte dell'host di esecuzione. Il bridge rimane headed nello stesso profilo. Il viewer condivide solo l'unica finestra Chrome osservata, non un desktop generalista: VNC **127.0.0.1:5975**, noVNC **127.0.0.1:8795**. Il comando `status` deve confermare processi e listener reali prima di usare l'indirizzo. Inoltra soltanto **8795** da VS Code e apri l'URL stampato; la password è nel file privato indicato da `status`, mai negli argomenti o nei log. Non esporre porte pubbliche. Finestre popup esterne possono non essere visibili nella condivisione della singola finestra: fermarsi e verificare, non estendere la condivisione di nascosto.

Durante login e MFA non si acquisiscono screenshot/tracing. Il launcher non installa servizi permanenti; `bash ops/control-browser-display.sh stop` termina esclusivamente i processi registrati, elimina le credenziali effimere del display/viewer e conserva i profili account. Arrestare il display chiude il browser: non farlo mentre serve al controllore. La compatibilità con il login ChatGPT deve essere verificata sull'account, non deriva dalla presenza di Xvfb.

Avanzamento reale del 16 settembre: browser del bridge aperto, viewer loopback attivo,
pagina noVNC HTTP 200 e handshake RFB protetto da password osservati. In VS Code
inoltrare **8795** come porta privata, aprire
`http://127.0.0.1:8795/vnc.html?autoconnect=false&resize=scale`, premere **Connect**
e leggere nel proprio terminale la password con
`cat /home/OPERATOR/.local/share/gemrouter-personal-control/display/viewer-password`.
Digitare le credenziali ChatGPT solo nel Chrome visualizzato, poi aprire la chat
esatta indicata sotto. Il login Codex è già stato conservato e verificato: non
va ripetuto per aprire il browser. Il viewer non acquisisce clipboard, screenshot
o registrazioni. Non inoltrare la porta VNC 5975 né renderla pubblica.

La pagina di onboarding ora mostra avanzamento/errori accanto a ogni comando,
disabilita i clic concorrenti e segnala i prerequisiti mancanti. **Apri il browser**
apre una finestra sul server, non una nuova scheda locale: serve il visualizzatore.
La diagnostica resta disabilitata finché il profilo UI reale non è stato calibrato.
Un riavvio della sola pagina ruota il suo link privato: riaprire quello corrente
da `onboarding-access.txt`, senza rifare il login Codex o cancellare profili.

La pagina consente di caricare `observed-ui-profile.json` dalla directory privata senza chiudere il browser autenticato. Questo file deve essere calibrato sulla UI reale; non viene creato da fixture. **Codex invia solo gateway_status** esegue `runControl` con un tool a zero argomenti: solo la vera chiamata del modello a quel tool attiva `inspectConfiguredTarget` e `sendBoundedWake`. Il codice conserva localmente l'errore del bridge e distingue tool invocato, nuovo risultato status osservato e completion. Un eventuale esito positivo salva solo una ricevuta operativa privata, non la cronologia né credenziali.

Google può rifiutare esplicitamente accessi da browser controllati da automazione, anche quando Chrome è aggiornato. Non è previsto né sicuro aggirare quel controllo con flag anti-rilevamento, cookie copiati o endpoint interni. Se il login Google continua a essere bloccato, usare nella pagina ChatGPT il metodo di autenticazione originario dell’account oppure un browser ufficiale manuale supportato; il collegamento del profilo a GemRouter resta sospeso finché non esiste una sessione dedicata realmente autenticata.

La diagnostica di questa pagina usa la risorsa MCP **di produzione** già selezionata nella chat. Non può armare la coda live, non crea chat, non apre run e non conferma una completion. La vecchia run è stata rilasciata dal timer notturno: dopo la diagnostica sarà necessario un bootstrap esplicito sul gateway proprietario della coda, conservando il grant. Abilitazione del controllo, aggiornamento del servizio e restart richiedono autorizzazione specifica; non ripristinare copie del DB per riattivare run/grant. Anche il timer nightly preesistente ricompila il checkout: qualsiasi sua sospensione o modifica va concordata.

## Destinazione e percorso implementato

La prima destinazione richiesta è la chat personale esistente:

```text
https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582
Connettore: Example - Trade
GemRouter: https://gemrouter.example.com
```

Il worker non viene dedotto dal nome del connettore: la dashboard lo legge dal registry e mostra la sua risorsa MCP. L'alias `air3-trade` è soltanto un suggerimento da confrontare. Nessun binding viene creato o abilitato durante l'installazione.

```text
Client autorizzato → job + intenzione wake nella stessa transazione SQLite
  → coordinatore → Codex App Server → unico tool di controllo limitato
  → bridge UI locale → chat personale esatta → gateway_exchange
  → completion MCP valida → risposta HTTP allo stesso client
```

Il trasporto implementato è **browser/UI sperimentale**, tramite `playwright-core` e Chrome visibile. Non è un endpoint pubblico di scrittura nelle chat. La destinazione resta Chat, non Work o un Workspace Agent. Il thread Codex effimero appartiene esclusivamente al controllore: non è l'ID `/c/...`, non riceve il job d'inferenza e non può consegnarne la completion.

La verifica dello schema installato ha trovato `thread/start`, `turn/start` e dynamic tools del [Codex App Server](https://learn.chatgpt.com/docs/app-server), ma non ha dimostrato una funzione nativa che scriva nella chat personale richiesta. La [documentazione Browser](https://learn.chatgpt.com/docs/browser) descrive capacità dipendenti dalla superficie: il solo login della CLI non prova che siano disponibili a GemRouter. Perciò non viene dichiarato supporto nativo verificato.

## Prerequisiti del gestore

- Stack del repository: Node `24.18.0`, pnpm `10.26.1`, dipendenze del lockfile. `playwright-core` non scarica un browser.
- Runtime ufficiale **`codex-cli 0.154.0-alpha.6.2`**, versione il cui schema è stato esaminato. Il codice rifiuta altre versioni finché il contratto non viene riesaminato; non effettua downgrade o aggiornamenti automatici.
- Chrome/Chromium installato, eseguibile configurato, sandbox del browser funzionante e sessione grafica autorizzata sullo **stesso host/processo utente che esegue GemRouter e Codex**. Il browser viene aperto soltanto dall'azione admin dedicata, non all'import o all'arrivo della prima richiesta.
- Account ChatGPT utilizzabile nel runtime Codex e accesso alla chat personale con l'app MCP corretta. Il catalogo `model/list` deve contenere esattamente il modello Astra richiesto e il reasoning selezionato; nessun fallback silenzioso.
- Profilo UI basato sui ruoli, nomi accessibili e stati realmente osservati nell'account. Un esempio inventato o il DOM di una fixture non è una calibrazione live.

Non è implementato un companion remoto. Un browser aperto sul portatile non è automaticamente controllabile dal GemRouter sul server. Non esporre CDP, porte di debug o desktop remoto generalista; non copiare cookie o profili del browser abituale. Il funzionamento su desktop bloccato o server headless non è stato dimostrato.

Il normale servizio non eredita una sessione grafica. Per l'onboarding è stato predisposto il display dedicato **:95**: il pulsante di login legge i metadati privati del launcher. Questo non modifica l'ambiente della produzione e non completa il login ChatGPT al posto dell'operatore. Display avviato, browser aperto e sessione autenticata sono tre verifiche distinte.

Verifiche locali non mutanti:

```sh
codex --version
pnpm check
pnpm exec tsc -p tsconfig.json --outDir /tmp/gemrouter-operator-build
```

Per predisporre una nuova installazione, usare `pnpm install --frozen-lockfile`; non sovrascrivere il `.env` esistente con il file di esempio. Avvio o restart di produzione richiedono un'autorizzazione distinta.

## Configurazione

| Variabile | Default / significato |
|---|---|
| `GEMROUTER_CHATGPT_CONTROL_ENABLED` | `false`; abilita solo la disponibilità del controllore, non i binding |
| `GEMROUTER_CHATGPT_CONTROL_CODEX` | `codex`; nome risolto una volta nel PATH dell'operatore oppure percorso assoluto |
| `GEMROUTER_CHATGPT_CONTROL_MODEL` | `gpt-6-astra`; verificato nel catalogo reale, distinto dal modello della chat |
| `GEMROUTER_CHATGPT_CONTROL_EFFORT` | `high`; deve essere supportato dal modello richiesto |
| `GEMROUTER_CHATGPT_CONTROL_TIMEOUT_MS` | `45000`; intero fra 1000 e 120000, mai prolunga la deadline del job |
| `GEMROUTER_CHATGPT_CONTROL_BROWSER` | `/usr/bin/google-chrome` |
| `GEMROUTER_CHATGPT_CONTROL_PRIVATE_DIR` | `.local/share/gemrouter-personal-control` nella home dell'utente del servizio |
| `GEMROUTER_CHATGPT_CONTROL_UI_PROFILE` | Percorso del JSON di descrittori UI osservati; assente significa controllo non pronto |

Il contenitore privato ha sottodirectory `codex` e `browser`. Va mantenuto fuori da repository, directory dati e radici di backup. Il profilo Codex richiede permessi privati `0700`, proprietario coerente e nessun symlink; non viene copiato o sovrascritto il profilo sviluppatore `.codex`. Il processo figlio riceve un ambiente minimo, non le chiavi GemRouter/provider del servizio. I profili possono contenere credenziali gestite dai rispettivi runtime: non archiviarli nei backup standard, report, ticket o Git.

### Profilo UI: cosa deve essere osservato

Il contratto è `browserUiProfileSchema` in `src/llm/providers/chatgpt/control/browserBridge.ts`. Il gestore prepara un JSON locale con `version: 1`, `operatorObservedAt` ISO e descrittori `{ "role": ..., "name": ... }`. I confronti sono esatti: zero o più controlli corrispondenti producono errore, non un click casuale.

| Campo | Evidenza da individuare nella UI reale |
|---|---|
| `accountIdentity` | Identità account visibile; il nome include il placeholder `{account}` |
| `personalMode` | Controllo Chat selezionato, con stato accessibile positivo; una voce di navigazione non basta |
| `selectedConnector` | App già selezionata nella conversazione; nome con `{connector}` |
| `composer`, `send`, `stop` | Editor, invio e indicatore generazione effettivi; la bozza utente non va sovrascritta |
| `userMessage` | Elementi dei messaggi utente, per cercare solo il marker della propria operazione |
| `tools` | Tre descrittori distinti: `gateway_open`, `gateway_exchange`, `gateway_status` |
| `toolInventoryOpen`, `toolInventoryClose` | Se necessari, entrambi i controlli per aprire/chiudere l'inventario |
| `connectorResourceLink` | Se disponibile, link della risorsa OAuth MCP da confrontare esattamente |
| `writeApprovalIndicator` | Stato accessibile positivo dell'approvazione effettiva: necessario per il wake |
| `statusResult` | Solo il nuovo risultato JSON di `gateway_status`, non il testo narrativo della chat |
| `newChat`, `selectConnectorPath` | Per creare una chat: controllo reale e sequenza selezione app, massimo quattro passaggi |

Uno stato positivo è `state: { "attribute": "aria-selected", "value": "true" }` oppure l'equivalente realmente osservato `aria-pressed`/`aria-checked`. Non impostarlo soltanto per far superare la validazione. Sono supportati i placeholder `{account}`, `{connector}` e `{mcpResource}`; niente selettori JavaScript o URL liberi inviati dai client.

Non viene distribuito un profilo dichiarato compatibile con l'account dell'operatore: quell'interfaccia non è stata osservata qui. Se la UI non rende identificabili inventario, approvazioni o risultato status con il contratto previsto, l'integrazione rimane non pronta e il bridge richiede un adattamento verificato. Il wizard non risolve questa calibrazione attraverso una dichiarazione arbitraria.

## Tre accessi indipendenti

| Accesso | Modalità | Non abilita |
|---|---|---|
| Codex | `account/login/start` ufficiale, preferibilmente device code | Sessione browser o MCP della chat |
| Browser ChatGPT | Login interattivo nel profilo dedicato visibile | Account Codex o grant GemRouter |
| OAuth MCP | Grant preesistente della chat, confrontato col worker | Controllo di account, browser o altre chat |

Il login Codex non chiama `codex mcp login`, non apre pairing del worker e non ruota/revoca il grant MCP. Device code e URL temporanei sono visibili soltanto alla sessione admin che ha avviato il login, rimossi a completamento, annullamento o scadenza locale di cinque minuti. I token restano nel runtime ufficiale. Il login browser OAuth di Codex, se scelto, richiede il callback loopback sull'host Codex: il device code evita di aprire `localhost` sul dispositivo sbagliato.

Scollegare Codex disarma il controllo, non cancella la conversazione e non revoca l'MCP. Revocare l'MCP non effettua logout globale. Limiti e consumo del controllore Codex sono distinti dall'inferenza nella chat; non sono promessi gratuità, quota illimitata o conteggi token inventati.

## Onboarding nell'area riservata

La sezione **ChatGPT MCP Gateway** resta collassata per default. Le informazioni della chat e dell'account si caricano solo dopo autenticazione admin. Le mutazioni usano i controlli admin/CSRF del progetto.

1. **Collega Codex.** Premi **Controlla Codex**, poi **Accedi con codice dispositivo**. Completa il consenso nella pagina ufficiale e attendi l'esito realmente osservato. Il login riuscito rende verde soltanto l'accesso Codex, non la chat o i tool.
2. **Seleziona la chat esistente.** Usa il vero worker del registry, l'URL precompilato indicato sopra, l'identità account visibile e **Example - Trade**. Confronta la risorsa MCP mostrata con la configurazione dell'app. La casella di conferma è etichettata come dichiarazione dell'operatore. **Salva associazione disarmata**. **Apri browser dedicato per il login** apre il browser sull'host del controllore; completa lì login/consensi e conserva modello e modalità Chat esistenti.
3. **Verifica connettore e tool.** Seleziona l'app nella conversazione, non soltanto fra le app installate. Esegui **Verifica passiva destinazione**, poi autorizza **Invia diagnostica solo status**. Devono coincidere URL, account, app e worker restituito dal nuovo `gateway_status`; la sequenza osservata dal gateway deve avanzare con il grant atteso. Solo `gateway_status` disponibile non significa pronto. Le approvazioni write restano un requisito separato.
4. **Prova il collegamento.** **Riprendi ascolto** chiede alla chat di riusare i propri handle e recuperare prima eventuali exchange ambigue. Non produce un nuovo `open_id`. **Avvia nuova run** è un bootstrap esplicito separato, idempotente per il binding, non un nuovo OAuth e non un takeover. Non usarlo per aggirare `worker_busy`. Osserva un poll effettivo; poi prova l'inferenza con un'app autorizzata, separatamente dalla diagnostica.
5. **Abilita wake su richiesta.** Arma soltanto dopo le verifiche e con run attiva recuperabile, worker abilitato, grant valido e host disponibile. **Disabilita wake** o **Ferma controllore per questa chat** deve prevalere su qualunque richiesta successiva. Nessun toggle generale arma da solo tutte le chat.

Il controllo ricontrolla destinazione/account/connettore prima dell'invio, non preme Stop e non cancella la bozza dell'utente. Una consegna ambigua viene segnalata e non ripetuta alla cieca: si cerca soltanto il marker già inviato nella chat corretta. Un marker non fornisce exactly-once né attestazione crittografica dell'identità della chat.

## Coda, limiti e ripresa

Con feature disabilitata resta l'ammissione precedente: un worker non disponibile non viene riattivato. Con binding verificato e armato, un worker stale può ricevere un job solo dopo autenticazione app, alias/backend esatti, allowlist worker, controlli stop/drain/grant e limiti. Job e intenzione wake sono atomici in SQLite; nessun processo Codex, browser o HTTP viene atteso dentro una transazione.

Il coordinatore legge soltanto l'outbox, serializza le operazioni di controllo e deduplica per worker/versione/generazione. Se il worker ha già poll o claim valido non invia un wake. Budget di tentativi, backoff, coda e deadline sono finiti; polling del coordinatore non significa invio di heartbeat. I job conservano la deadline originaria, comprensiva di wake/login/UI: i timeout degli altri backend non vengono aumentati.

L'ultimo consumer HTTP che si disconnette annulla il job; un singolo retry idempotente non annulla gli altri consumer. Se il lavoro valido scompare, il wake non inviato viene annullato. Un messaggio già consegnato non è ritirabile, ma nessun job scaduto viene per questo rimesso in circolo. URL/grant/account/binding cambiati invalidano le prove e bloccano le operazioni obsolete; i job non sono spostati su un'altra chat.

I 20 secondi di `GEMROUTER_CHATGPT_LONG_POLL_MS` rappresentano un singolo long-poll, non la durata della sessione OAuth. I template automatici terminano il turno su `idle`; non chiedono polling infinito. Un nuovo job può produrre una nuova attivazione limitata soltanto se il binding è ancora pronto e armato.

### Cessione dopo la completion

Il worker resta limitato ai tre tool esistenti. `gateway_open` annuncia l'estensione compatibile `yield_after_completion_v1`; `gateway_exchange` accetta `yield_after_completion: true` **insieme a una completion**. Conferma la completion e restituisce `state: "yielded"` con il nuovo cursore senza assegnare il job seguente. Una chat può così terminare il batch senza abbandonare un claim. `yielded` non significa coda vuota.

Il valore omesso conserva il comportamento precedente, incluso il possibile claim del job seguente nella risposta alla completion. Il replay comprende l'intera exchange e la nuova opzione: dopo una risposta persa ripetere gli stessi argomenti, non saltare il risultato usando un cursore ricostruito. Generation fencing, lease, timeout e completions tardive restano vincolanti.

### Restart e recovery

Al restart, richieste HTTP sincrone orfane falliscono, run precedenti vengono rilasciate e outbox obsoleta viene annullata. Binding e verifiche vengono disarmati; non parte una chat come effetto collaterale del riavvio. Il grant MCP non viene rifatto per questo motivo. L'operatore riapre il browser se necessario, ricontrolla account/target/tool ed esegue il bootstrap esplicito della nuova run prima di riarmare. Per run ancora attive usare invece la ripresa degli handle nel contesto. `worker_busy` richiede verifica/recovery amministrativa, non release automatica.

I backup standard non esportano credenziali Codex/browser, grant, claim, job o outbox operativa. Non usare la copia delle directory private come scorciatoia per un restore: l'installazione ripristinata richiede nuova verifica e armamento espliciti.

## Creare un'altra vera chat personale

La funzione è amministrativa e distinta dal wake; non si attiva per timeout, limite contesto o messaggio nel job.

1. Prepara un **worker nuovo e mai usato**, alias e allowlist espliciti, inizialmente disabilitato/non armato. Usa una risorsa MCP e un nome app univoci diversi da Example - Trade.
2. Completa il pairing di quel solo connettore, selezionando la richiesta OAuth esatta. Non cambiare l'endpoint dell'app della prima chat e non riutilizzarne il grant.
3. Seleziona il worker separato nella dashboard e conferma **Crea la chat del worker selezionato**. Servono i descrittori UI osservati per creazione/selezione app. Il bridge verifica Chat e account, invia il messaggio amministrativo limitato e acquisisce l'URL reale `/c/...` dopo la persistenza: non costruisce un UUID locale.
4. Il binding risultante rimane disarmato. Completa diagnostica, autorizzazioni app e bootstrap del nuovo worker. Scegli modello/reasoning nell'interfaccia, non mediante l'alias GemRouter.

La creazione registra un'intenzione persistente prima di qualsiasi azione UI. Dopo un errore o un restart, un nuovo tentativo sullo stesso worker è bloccato con `personal_chat_creation_pending`: controlla l'esito nel browser e salva manualmente l'URL della chat effettivamente osservata per completare l'associazione disarmata. Anche un tentativo fallito prima dell'invio resta conservativamente bloccato: non viene sacrificata l'unicità per riprovare alla cieca. L'onboarding incompleto non cancella altre chat o revoca altri grant. Non è prevista migrazione automatica della cronologia; creare una nuova chat non trasferisce il contesto precedente.

## Verifiche riproducibili e limiti delle prove

La suite ordinaria non deve autenticarsi all'account reale:

```sh
pnpm check
pnpm test
pnpm build
pnpm smoke:chatgpt-mcp
pnpm smoke:chatgpt-ui
pnpm smoke:chatgpt-control
git diff --check
```

I test `chatgpt-control-*.test.ts` isolano runtime stdio, browser/DOM, stato/binding, outbox, permessi, replay, cancellazioni e template. Lo smoke control usa trasporti locali e worker deterministici: un risultato verde prova il percorso implementato con simulatori, non che l'account esponga quei controlli o che la chat reale risponda. Lo smoke dashboard non è un browser autenticato a ChatGPT.

Il probe reale già eseguito ha verificato solamente binario Codex, versione, `initialize`, configurazione effettiva e `account/read` su profilo privato non autenticato. Risultato: `controller_auth_required`. Non ha chiamato login, creato chat personali o consumato inferenza dell'account.

### Accettazione live, solo con account e consenso disponibili

Prima del test conserva solo metadati non segreti di worker/binding/grant attivo e conferma che non esistano poll o claim in corso. Completa i tre accessi e verifica il target esatto, modalità Chat, connettore e tool. Esegui prima la diagnostica status; confronta worker e grant precedente. Questo passaggio non dimostra ancora polling o inferenza.

Dopo deploy autorizzato e armamento, lo smoke remoto esistente richiede `GEMROUTER_BASE_URL`, `GEMROUTER_API_KEY` di un'app realmente autorizzata e `GEMROUTER_CHATGPT_ALIAS`. Non scrivere la chiave nella cronologia shell o nei report. Il comando è:

```sh
pnpm smoke:chatgpt-mcp:live
```

Questo script invia richieste remote reali, ma da solo non prova l'identità della chat: correlare separatamente URL osservato, wake, `gateway_exchange`, claim e completion sul gateway. Non usare un client MCP esterno per simulare il worker durante l'accettazione live. Verificare anche il contenuto atteso del prompt innocuo, non soltanto HTTP 200.

Lascia terminare il turno con `idle`/`yielded`, invia una richiesta successiva senza messaggi manuali e poi due richieste ravvicinate. Registra tempi end-to-end e stati distinti `wake_requested`, `controller_accepted`, `target_verified`, `wake_delivery_attempted`, `wake_delivered_observed`, `mcp_poll_observed`, claim e completion. Verifica indisponibilità del controllore, deadline e stop; per nuove chat usa solo un worker di test separato. Non eliminare conversazioni personali come cleanup automatico.

Il report deve distinguere: implementazione locale, test automatici, smoke HTTP/MCP simulato, runtime ufficiale non autenticato, controllo reale UI, status MCP, polling, completion e ripresa dopo idle. Testo finale Codex, normale risposta in pagina e successo di un click non soddisfano mai la completion.

## Video e fonti

Il [video indicato, da 05:00](https://www.youtube.com/watch?v=OQipTxv9Qv0&t=300s) non è stato ispezionato audiovisivamente. È stata consultata una [trascrizione secondaria con timestamp](https://moderncreator.app/2026-09-08-mark-kashef-i-tested-every-gpt-6-astra-effort-level-here-s-what-i-d-use): a 05:21–05:53 descrive creazione/ridenominazione di thread Codex con effort diversi; a 06:05–06:20 descrive la comparsa dei thread e l'avvio dei task. Non documenta l'ID di una chat personale `/c/...`, il relativo connettore o un'API che la riattivi. È un'indicazione sul meccanismo, non una prova diretta delle schermate.

Le fonti ufficiali usate per il contratto sono [App Server](https://learn.chatgpt.com/docs/app-server), [autenticazione Codex](https://learn.chatgpt.com/docs/auth) e [Browser](https://learn.chatgpt.com/docs/browser). Il gateway MCP non risveglia da solo una chat: l'estensione qui implementata aggiunge un trasporto UI opt-in, con disponibilità e prove da verificare sull'account reale.
