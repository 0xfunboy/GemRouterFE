# GemRouter: architettura e workflow operativo

Questo documento descrive il comportamento effettivo del codice in `src/` al 16 agosto
2026. È pensato come mappa tecnica per modifiche in produzione: distingue configurazione,
discovery, autorizzazione delle app, selezione del modello, selezione dell'account, fallback
e persistenza.

## Vista d'insieme

```text
client agent/app
  -> superficie HTTP (OpenAI / GemRouter-DeepSeek / Ollama)
  -> autenticazione app + origin + rate/concurrency policy
  -> parsing e normalizzazione richiesta
  -> policy modello globale + allowlist app
  -> router tra backend, con deadline unica
  -> scheduler Gemini / NVIDIA / Ollama
  -> adattatore risposta della superficie richiesta
  -> audit + interaction telemetry
```

Per una richiesta Gemini di testo, il tratto centrale è:

```text
modello richiesto
  -> piano modelli: exact model, poi downgrade per capacità
  -> catalogo live per account (gate di disponibilità)
  -> ledger locale RPM/TPM/RPD e cooldown
  -> scelta quotaGroup/account
  -> reserve -> dispatch -> reconcile success/failure
  -> eventuale account successivo o modello successivo
```

Una distinzione fondamentale è che **discovered**, **configured** e **allowed** non sono
sinonimi:

- un modello *discovered* esiste nell'API Google;
- un modello *configured* è nel catalogo curato e nella configurazione routed attiva;
- un modello *allowed* è anche autorizzato per la specifica app client.

Solo l'intersezione dei tre livelli è utilizzabile in modo affidabile.

## Struttura del repository

| Percorso | Responsabilità |
|---|---|
| `src/index.ts` | Bootstrap, Fastify, route, auth, policy app/modello, adattamento risposte, admin API e telemetry |
| `src/config.ts` | Lettura `.env`, default, precedenze delle chiavi/account, assemblaggio config di tutti i provider |
| `src/lib/models.ts` | Cataloghi statici, normalizzazione ID e inferenza capability dei modelli |
| `src/lib/openai.ts` | Parsing e output OpenAI Chat Completions, Responses e Images |
| `src/lib/ollama.ts` | Parsing e output compatibile Ollama |
| `src/lib/semantics.ts` | Istruzioni semantiche per JSON, canale e policy azioni |
| `src/lib/compatibility.ts` | Superfici `gemrouter`, `openai`, `deepseek`, `ollama` |
| `src/lib/backup.ts` | Export/import dello stato configurato e dei segreti |
| `src/llm/router.ts` | Ordine backend, deadline globale, fallback inter-backend e hedge Gemini/NVIDIA |
| `src/llm/providers/gemini-api/client.ts` | Payload Gemini, thinking config, piano modelli, retry/fallback, error mapping |
| `src/llm/providers/gemini-api/modelDiscovery.ts` | Discovery globale tramite `GET /v1beta/models` e cache |
| `src/llm/providers/gemini-api/accountCatalog.ts` | Discovery per ogni account e gate live account/modello |
| `src/llm/providers/gemini-api/keyPool.ts` | Admission e scelta del miglior account/quota group |
| `src/llm/providers/gemini-api/quotaLedger.ts` | Ledger RPM/TPM/RPD, reservation lifecycle e cooldown |
| `src/llm/providers/gemini-api/rateLimits.ts` | Limiti locali curati e fallback prudente per modelli sconosciuti |
| `src/llm/providers/nvidia/` | Catalogo NIM, alias/tier, scoreboard, probe e race interna |
| `src/llm/providers/ollama/` | Router verso endpoint Ollama configurati |
| `src/llm/providers/ollama-local/` | Vision ed embeddings locali dedicati |
| `src/llm/providers/agnes/` | Generazione immagini/video Agnes |
| `src/store/appStore.ts` | App client, hash API key, allowlist, rate limit e coda concorrenza |
| `src/store/interactions.ts` | Interazioni e aggregati orari |
| `src/store/audit.ts` | Audit append-only |
| `src/store/adminSessions.ts` | Sessioni della dashboard admin |
| `src/ui.ts` | Dashboard server-rendered e logica browser |
| `tests/` | Regressioni su scheduler, quota, app policy, NVIDIA e UI |
| `data/` | Stato runtime persistito; contiene segreti ed è ignorato da Git |
| `ops/systemd/` | Unit di produzione, restart notturno e installer |
| `scripts/start-gemrouter.sh` | Build se necessario e avvio di `dist/index.js` |
| `scripts/smoke.sh` | Smoke test HTTP contro un'istanza in esecuzione |

`dist/` è output compilato. La sorgente autorevole è `src/`; una modifica TypeScript non
raggiunge il processo già in esecuzione finché non viene eseguito il build e il servizio non
viene riavviato.

## Sequenza di startup

1. `src/index.ts` importa `dotenv/config`, quindi `.env` entra in `process.env`.
2. `loadConfig()` crea `data/` se necessario e costruisce la configurazione completa.
3. `data/model-config.json`, se valido, sovrascrive live l'insieme e l'ordine dei modelli
   Gemini di testo. Ogni ID non presente in `config.geminiApi.limits` viene scartato.
4. Vengono creati i client Gemini, NVIDIA, Ollama, Ollama Local e Agnes, poi il router LLM.
5. `AppStore` carica `data/apps.json`.
6. L'app bootstrap viene creata o aggiornata cercando l'hash della chiave definita in
   `.env`. Nome, origin, modelli e limiti della bootstrap app vengono quindi riallineati
   ai valori `GEMROUTER_BOOTSTRAP_*` a ogni startup.
7. `restrictAllowedModels(config.modelIds)`:
   - per una app `modelAccess: all`, rigenera `allowedModels` con tutto l'universo attivo;
   - per una app `modelAccess: custom`, elimina gli ID non più presenti nell'universo;
   - persiste il file se ha effettuato modifiche.
8. Fastify registra hook e route e ascolta su `HOST:PORT`.
9. Il client Gemini programma il refresh del catalogo per-account ogni 6 ore; se la cache
   è stale, avvia un refresh iniziale differito di 30 secondi.

Questo ordine evita che una allowlist venga potata usando un vecchio elenco `.env` prima di
caricare `model-config.json`.

## Precedenza della configurazione modelli

La configurazione ha più strati:

1. I default TypeScript in `src/lib/models.ts` sono il fallback per installazioni senza
   liste esplicite.
2. `.env` definisce catalogo diretto, free-tier text e fallback con
   `GEMROUTER_DIRECT_MODELS`, `GEMROUTER_FREE_TIER_TEXT_MODELS` e
   `GEMROUTER_TEXT_FALLBACK_MODELS`.
3. `data/model-config.json` sostituisce l'elenco routed di testo all'avvio ed è la copia
   persistita dell'editor **Routed Models** della dashboard.
4. `src/llm/providers/gemini-api/rateLimits.ts` è anche un catalogo di ammissione: se un
   ID non è noto lì, l'editor runtime non può abilitarlo.
5. La policy della singola app restringe ulteriormente l'universo.

Il primo modello della configurazione globale è il default/fallback di policy. L'ordine è
anche un tie-break del piano Gemini, ma i fallback non sono una semplice iterazione lineare:
`buildGeminiModelAttemptPlan()` ordina prima i candidati per vicinanza di capacità al modello
richiesto, evitando upgrade finché esistono downgrade adeguati.

### “Preferred model” delle agent-app

`ApiAppRecord` non contiene un campo `preferredModel`. L'ordine di `allowedModels` non decide
il modello usato. La preferenza arriva dal campo `model` inviato dal client, normalmente
configurato nell'env dell'agent-app.

Nel router, la policy app fa questo:

- se il modello richiesto è configurato e consentito, lo conserva;
- altrimenti sceglie il primo modello globale consentito all'app e annota
  `policyFallbackReason`;
- se nessun modello di testo è consentito, risponde `403 no_free_text_model_allowed`.

Di conseguenza, aggiungere un modello a `allowedModels` lo **autorizza**, ma per renderlo
effettivamente preferito occorre farlo richiedere dal client. Le app `modelAccess: all`
seguono automaticamente il catalogo globale; quelle `custom` richiedono un'estensione
esplicita dell'allowlist.

## Precedenza delle chiavi Gemini e degli account

`src/config.ts` risolve le chiavi in questo ordine:

1. `GEMROUTER_GEMINI_API_KEYS_JSON`, se è un array non vuoto;
2. account con una proprietà `key` in `data/gemini-api-accounts.json`;
3. `GEMROUTER_GEMINI_API_KEYS`, associato per posizione ai metadati account.

Il `quotaGroup` rappresenta il progetto che condivide la quota. Chiavi dello stesso progetto
devono avere lo stesso `quotaGroup`; chiavi di progetti indipendenti non devono essere unite.
I limiti per-gruppo definiti negli account hanno precedenza sui limiti globali, poi
`GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` può sovrascriverli.

## Model discovery

Esistono due discovery complementari.

### Discovery globale

`GeminiApiModelDiscovery` usa la prima chiave abilitata per chiamare
`GET /v1beta/models`, normalizza `models/<id>` e salva metadati, limiti token e metodi in
`data/gemini-api-models-cache.json`. Il refresh predefinito è ogni 6 ore ed è lazy: una
richiesta o una route admin lo avvia se la cache è stale. Un errore mantiene i modelli già
in cache e aggiorna `lastError`.

Questa discovery alimenta dashboard, capability e filtro dei candidati, ma non abilita da
sola un modello in produzione.

### Discovery per account

`GeminiAccountModelCatalog` chiama `/models?pageSize=1000` per ogni account abilitato e salva
solo modelli con `generateContent` in `data/gemini-api-account-models.json`.

Durante la scelta della chiave, un account può servire il modello soltanto se:

- la sua allowlist curata `account.models`, quando presente, lo consente; e
- il catalogo live per quell'account lo contiene.

Se il catalogo manca, è in errore o è più vecchio di 48 ore, il gate fallisce aperto sulla
allowlist curata. Questo evita che un guasto temporaneo del discovery svuoti l'intero pool.

## Workflow di una richiesta chat

1. Gli hook impostano request ID, CORS e tempo iniziale.
2. La route verifica che la superficie richiesta sia abilitata.
3. `ensureClientAccess()` valida il Bearer token confrontando l'hash, controlla origin,
   rate limit per-app e acquisisce uno slot di concorrenza con priorità.
4. Il parser della superficie normalizza modello, messaggi, streaming, token, temperatura
   e formato output. Tool calling OpenAI non è supportato su questa superficie.
5. `resolveTextModelForApp()` calcola l'intersezione fra modelli attivi e policy app.
6. `buildRequestLlmOptions()` costruisce session key, backend preference, deadline e
   configurazione thinking; il profilo semantico aggiunge le istruzioni necessarie.
7. `src/llm/router.ts` sceglie backend e condivide una deadline assoluta, predefinita a
   75 secondi, fra ogni tentativo e fallback.
8. Il provider esegue la richiesta e restituisce modello realmente usato, backend,
   account/quota group, usage e storia fallback.
9. La route adatta il risultato alla superficie, espone gli header `x-gemrouter-*`, registra
   audit e interazione e rilascia lo slot di concorrenza in `finally`.

Le route streaming sono compatibili con SSE/NDJSON, ma il client Gemini corrente completa
`generateContent` prima di produrre il chunk applicativo: non è streaming upstream token per
token.

## Routing tra backend

Con `backendPreference: auto`:

- gli ID `gemini-*` e `gemma-*` preferiscono Gemini API;
- alias/tier NVIDIA e modelli vendor NVIDIA-only preferiscono NVIDIA;
- gli altri ID preferiscono Ollama;
- un header `x-gemrouter-backend` esplicito rende il backend strict e disabilita il fallback
  inter-backend;
- gli ID in `GEMROUTER_GEMINI_API_STRICT_MODELS` non cambiano backend né modello.

Per richieste Gemini di testo autorizzate anche a `nvidia-auto`, il router può avviare un
hedge NVIDIA dopo 8 secondi. Il primo backend con output utilizzabile vince; il perdente viene
abortito. Una richiesta Gemini già dispatchata resta conteggiata nel ledger perché Google
potrebbe averla accettata.

NVIDIA esegue anche una propria selezione fra modelli/tier usando scoreboard, cooldown,
latenza e probe. Un ID NVIDIA-only può essere rimappato sul fallback Gemini configurato se
NVIDIA fallisce.

## Scheduler Gemini

### Piano modelli

Il piano parte sempre dal modello esatto, se consentito. I successivi candidati devono:

- appartenere alla famiglia provider Gemini/Gemma;
- essere modelli text `generateContent`;
- non essere image, live, embedding, TTS, audio o long-running;
- essere presenti nella allowlist della richiesta.

I candidati vengono ordinati per capability rank e distanza dal modello richiesto. Per
Gemini 3.7 Flash il downgrade più vicino è 3.6 Flash, poi 3.5 Flash.

### Scelta account

`GeminiApiKeyPool.reserve()` esclude account disabilitati, non autorizzati dal catalogo o
senza capacità. I restanti vengono ordinati per:

1. priorità account decrescente;
2. capacity score normalizzato RPM/TPM/RPD meno una penalità per 429 recenti;
3. rotazione sul successo/uso meno recente;
4. ordine di configurazione.

La reservation scrive subito eventi RPM, TPM stimato e RPD per impedire race fra richieste
concorrenti. Subito prima di `fetch` passa a `dispatched`.

### Budget di tentativi

- massimo 6 chiamate upstream Gemini per singola richiesta client;
- massimo 3 account sul modello esatto per 401/403, 404 o 429;
- sui modelli di fallback viene provato un solo account, per conservare budget e deadline;
- un 5xx o timeout non attraversa tutte le chiavi: passa al modello più vicino;
- un candidato che ha ancora fallback riceve al massimo 15 secondi; l'ultimo usa il tempo
  residuo della deadline globale;
- l'attesa locale per RPM/TPM/cooldown è limitata complessivamente a 20 secondi.

Un output vuoto non è mai un successo: viene ritentato fino a due volte con almeno 1024 token
di output, poi il router passa al modello successivo.

## Ledger quota e cooldown

Il ledger è per `quotaGroup + model`, mentre gli ultimi esiti chiave sono per `keyId`.

- RPM: finestra scorrevole configurabile, default 60 secondi;
- TPM: token **input** nella finestra scorrevole; la stima viene sostituita dal
  `promptTokenCount` reale su successo;
- RPD: dalla mezzanotte `America/Los_Angeles`, DST incluso.

Lifecycle reservation:

- `reserved`: può essere cancellata senza consumo se non è mai partita;
- `dispatched`: resta contabilizzata anche su timeout o perdita dell'hedge;
- `completed`: successo o fallimento riconciliato.

Cooldown attuali:

- `503 high demand`: 30 secondi e rollback della reservation;
- `429 Retry-After`: almeno 60 secondi, oppure il valore maggiore indicato da Google;
- `429 day-scope`: fino al reset Pacific solo se il contatore locale è almeno al 50% del
  limite; altrimenti 30 minuti prudenziali;
- `429` generico: scala 1, 5, 10, 15 minuti e riparte dal primo gradino dopo 10 minuti senza
  nuovi 429;
- un successo sullo stesso gruppo/modello azzera strike e cooldown.

Per default i 429 falliti vengono rimossi dai contatori locali
(`GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE=false`), perché l'upstream li ha respinti.

## Thinking config per famiglia

Il payload non è uniforme fra modelli:

- Gemma: omette completamente `thinkingConfig`;
- Gemini 3.5 Flash: usa `thinkingBudget`, default `0`;
- Gemini 3.7 Flash: usa `thinkingLevel` e accetta solo `low`, `medium`, `high`; la
  configurazione globale `minimal` viene promossa a `low` solo per questo modello;
- altri Gemini 3.x: usano `thinkingLevel`;
- Gemini 2.5 Flash/Flash-Lite: usano `thinkingBudget`;
- Gemini 2.5 Pro: invia soltanto `includeThoughts`.

Questo branching è parte della compatibilità di produzione: un campo accettato da un modello
può produrre `400 INVALID_ARGUMENT` su un altro e un 400 non è fallback-eligible.

## Route e flussi speciali

### OpenAI/GemRouter/DeepSeek

- `GET /v1/models`, `GET /models`
- `POST /v1/chat/completions`, `POST /chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`, `POST /images/generations`

Tutte filtrano i modelli visibili usando la policy dell'app autenticata.

### Ollama compatibility

- `GET /api/version`, `GET /api/tags`, `POST /api/show`
- `POST /api/chat`, `POST /api/generate`

### Flussi dedicati

- embeddings Ollama Local: `/v1/embeddings`, `/embeddings`;
- vision Ollama Local: `/v1/vision`, `/vision`;
- video Agnes: `/v1/videos/generations`, `/videos/generations`.

Vision ed embeddings locali non entrano nel fallback Gemini e hanno contatori RPD propri.

### Operatività e admin

- `/health` e `/dashboard/summary` espongono stato sanitizzato;
- `/admin/summary` e `/admin/provider/*` espongono diagnosi e mutazioni protette;
- `/admin/provider/models-config` applica e persiste l'elenco routed live;
- `/admin/provider/gemini-api/accounts` modifica account e ricarica il pool senza restart;
- `/admin/apps` gestisce app, policy, rotazione e revoca chiavi;
- `/admin/backup/*` esporta/importa anche segreti: il file va trattato come credenziale.

## Persistenza e proprietà dei file

| File | Autore principale | Nota operativa |
|---|---|---|
| `.env` | operatore | Segreti e bootstrap; letto solo allo startup |
| `data/model-config.json` | editor Routed Models | Override globale dei modelli, letto allo startup e aggiornabile live via admin |
| `data/apps.json` | AppStore/admin | Hash chiavi e policy; caricato in memoria, non hot-reloaded da edit manuale |
| `data/gemini-api-accounts.json` | admin account manager | Contiene chiavi raw; il client supporta hot reload via admin |
| `data/gemini-api-models-cache.json` | global discovery | Derivato e sostituibile |
| `data/gemini-api-account-models.json` | account discovery | Derivato e sostituibile |
| `data/gemini-api-quota-ledger.json` | quota ledger | Stato conservativo da non modificare durante traffico |
| `data/interactions.json` | InteractionStore | Prompt/risposte e metriche |
| `data/audit.log` | AuditLogger | Eventi append-only |
| `data/nvidia-scoreboard.json` | NVIDIA client | Score, cooldown e osservazioni |
| `data/ollama-local-usage.json` | Ollama Local | Contatori giornalieri |

Gli edit manuali di `apps.json` e `.env` non cambiano il processo già attivo. Per evitare che
lo stato in memoria riscriva un file manualmente modificato, il percorso preferito per
mutazioni live è l'admin API; per modifiche di codice/catalogo serve un restart controllato.

## Procedura sicura per aggiungere un modello Gemini

1. Confermare l'ID esatto nella documentazione Google e in `/v1beta/models`.
2. Verificare `generateContent`, limiti token e disponibilità su più account.
3. Verificare il payload thinking con una chiamata reale; non inferirlo solo dal prefisso.
4. Aggiungere il modello ai limiti curati, ai default, al capability rank e all'ordine UI.
5. Aggiungerlo a `.env` e `data/model-config.json` nella posizione desiderata.
6. Estendere le app `custom` che devono richiederlo; le app `all` si aggiornano al riavvio.
7. Aggiungere test per quota, thinking config e ordine fallback.
8. Eseguire `pnpm check`, `pnpm test` e `pnpm build`.
9. Prima del restart, conservare una copia recuperabile dei file runtime.
10. Dopo il restart, verificare `/health`, `/v1/models` con una chiave app e una chat breve
    sul nuovo modello; controllare backend, modello reale e fallback headers.

## Gemini 3.8 Flash: integrazione corrente

L'ID GA verificato è `gemini-3.8-flash`. Il catalogo Developer API dichiara
`generateContent`, input massimo 1.048.576 token e output massimo 65.536 token. Il modello
accetta `thinkingLevel` `low`, `medium` o `high`, ma non `minimal`, e rifiuta i parametri di
sampling legacy. Il builder promuove quindi il default `minimal` a `low` e omette
`temperature` solo per 3.8.

Il modello è il primo della configurazione globale ed è anche impostato esplicitamente come
`GEMROUTER_DEFAULT_MODEL`: le richieste che non indicano un modello partono quindi da 3.8.
È classificato sopra 3.7; il downgrade più vicino resta 3.7 e la logica generale di
failover non cambia.

## Gemini 3.7 Flash: integrazione corrente

L'ID verificato è `gemini-3.7-flash`. Il catalogo Developer API dichiara
`generateContent`, `countTokens`, `createCachedContent` e `batchGenerateContent`, con input
massimo 1.048.576 token e output massimo 65.536 token. Il pricing standard include il free
tier.

La configurazione locale usa i limiti free-tier mostrati da AI Studio per `account2`
il 2026-08-17: 5 RPM, 250.000 TPM input e 20 RPD. Il modello è classificato sopra
3.6 e il downgrade parte da 3.6, poi 3.5.

Il test live ha confermato che `thinkingLevel: minimal` viene rifiutato, mentre
`thinkingLevel: low` risponde correttamente. Per questo l'adattamento è implementato nel
builder del payload, non affidato alla configurazione degli agent.

## Validazione account e thinking del 2026-08-17

Prima dell'inserimento, le nuove chiavi di `account1` (`runchk`) e `account11`
(`robohood`) sono state provate direttamente con una generazione reale, 30 secondi di
timeout per chiamata e pause fra le richieste. Entrambe generano correttamente sugli otto
modelli accessibili: Gemini 3.7, 3.6, 3.5, 3.5 Lite, 3 Flash Preview, 3.1 Flash Lite e i
due Gemma 4. Un iniziale 503 su 3.7 per `account1` è rientrato al singolo retry.

Sulle due chiavi nuove, `gemini-2.5-flash` e `gemini-2.5-flash-lite` restituiscono 404
perché Google non li rende disponibili ai nuovi utenti. Per evitare tentativi upstream
inutili, entrambi gli account hanno quindi un catalogo esplicito limitato agli otto modelli
verificati; gli account precedenti restano liberi di servire i 2.5.

La matrice thinking osservata sul `generateContent` API è:

| Famiglia | Configurazione accettata |
|---|---|
| Gemini 3.7 Flash | `low`, `medium`, `high`; `minimal` restituisce 400 |
| Gemini 3.6/3.5/3.5 Lite/3 Flash/3.1 Lite | `minimal`, `low`, `medium`, `high` |
| Gemini 2.5 Flash/Lite | budget numerico legacy; non verificabile con le due nuove chiavi |
| Gemma 4 | il campo thinking non produce thinking tokens; il router lo omette |

I limiti free-tier osservati su `account2` sono 5 RPM / 250.000 TPM / 20 RPD per i
Flash principali, 15 RPM / 250.000 TPM / 500 RPD per 3.1 e 3.5 Flash Lite, e
30 RPM / 16.000 TPM / 14.400 RPD per i due Gemma 4.
