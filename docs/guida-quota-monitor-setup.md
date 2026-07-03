# Guida passo-passo: attivare la lettura delle quote reali da Google

Questa guida va ripetuta **per ognuno dei 7 account Gemini** (ogni account = un
progetto Google Cloud diverso). Tempo stimato: ~5 minuti a progetto. Non serve
abilitare il billing: i volumi di lettura di GemRouter (2 query ogni 30 minuti)
rientrano ampiamente nel piano gratuito di Cloud Monitoring.

> Consiglio: apri una **finestra di navigazione in incognito per ogni account
> Google**, così non mischi le sessioni dei 7 account.

## Passo 1 — Trova il progetto associato alla API key

1. Vai su **https://aistudio.google.com** e fai login con l'account Gemini.
2. Nel menu a sinistra clicca **"Get API key"** (o "API keys").
3. Nella tabella delle chiavi, accanto a ogni key vedi la colonna **"Project"**:
   annota il **nome del progetto** e, cliccandoci sopra, il **Project ID**
   (es. `gen-lang-client-0123456789`). È il valore che servirà come `projectId`.

## Passo 2 — Apri la Google Cloud Console sul progetto giusto

1. Vai su **https://console.cloud.google.com** con lo **stesso account Google**.
2. In alto, a sinistra della barra di ricerca, c'è il **selettore progetto**
   (mostra il nome del progetto corrente). Cliccalo.
3. Nella finestra che si apre, tab **"ALL"** (Tutti): cerca il progetto del
   Passo 1 e selezionalo. Da ora tutto quello che fai vale per quel progetto.

## Passo 3 — Abilita la Cloud Monitoring API

1. Menu hamburger **☰** (in alto a sinistra) → **"APIs & Services"** →
   **"Library"** (Libreria).
2. Nella barra di ricerca scrivi **"Cloud Monitoring API"** e clicca il risultato.
3. Se vedi il bottone blu **"ENABLE"** (Abilita), cliccalo. Se vedi "MANAGE"
   (Gestisci), è già abilitata: passa oltre.

## Passo 4 — Crea il service account

1. Menu **☰** → **"IAM & Admin"** (IAM e amministrazione) →
   **"Service Accounts"** (Account di servizio).
2. In alto clicca **"+ CREATE SERVICE ACCOUNT"** (Crea account di servizio).
3. Campo **"Service account name"**: scrivi `gemrouter-quota`
   (l'ID si compila da solo). Clicca **"CREATE AND CONTINUE"**.
4. Al passo **"Grant this service account access to project"**: apri il menu
   **"Select a role"** (Seleziona un ruolo), nella casella filtro scrivi
   **"Monitoring Viewer"** e seleziona **Monitoring Viewer** (Visualizzatore
   Monitoring — è in sola lettura, non può toccare nulla).
5. Clicca **"CONTINUE"** e poi **"DONE"** (il terzo passo si salta).

## Passo 5 — Scarica la chiave JSON

1. Nella lista degli account di servizio, clicca sull'**email** di
   `gemrouter-quota@<project-id>.iam.gserviceaccount.com`.
2. Vai sul tab **"KEYS"** (Chiavi).
3. **"ADD KEY"** (Aggiungi chiave) → **"Create new key"** (Crea nuova chiave).
4. Tipo: **JSON** (già selezionato) → **"CREATE"**.
5. Il browser scarica un file tipo `<project-id>-abc123.json`. **È un segreto**:
   trattalo come una password.

## Passo 6 — Porta la chiave sul server

Dal computer dove hai scaricato il file:

```bash
scp ~/Downloads/<project-id>-*.json funboy@<server>:/home/funboy/INFRA/gem-router/data/secrets/account1-monitoring-sa.json
```

(la cartella `data/` è già esclusa da git, le chiavi non finiscono nel repo).
Usa un nome file chiaro per capire a quale account appartiene.

## Passo 7 — Registra il progetto in GemRouter

Modifica (o crea) `data/gcp-monitoring-credentials.json` aggiungendo una voce
per ogni progetto completato — `accountId` è l'id in
`data/gemini-api-accounts.json`, `serviceAccountPath` è relativo a `data/`:

```json
[
  {
    "accountId": "account1",
    "projectId": "gen-lang-client-0123456789",
    "serviceAccountPath": "secrets/account1-monitoring-sa.json"
  }
]
```

Puoi aggiungere gli account uno alla volta: quelli non elencati vengono
semplicemente saltati.

## Passo 8 — Verifica

```bash
curl -s -X POST http://127.0.0.1:4024/v1/admin/quota-monitor/refresh \
  -H "Authorization: Bearer $GEMROUTER_ADMIN_TOKEN" | head -c 2000
```

Risposta attesa: `"ok": true` con l'elenco dei progetti e, per ciascuno, il
numero di `observations`. Il campo `reconcile` dice quanti contatori RPD sono
stati riallineati (`adjustedUp`/`adjustedDown`) e quante serie sono state
saltate perché senza dimensione modello (`skipped`). Lo stato completo è sempre
su `GET /v1/provider/quota-monitor` e il ledger riallineato si vede nella
dashboard nella sezione "Gemini RPD Capacity".

Da qui in poi il sync gira da solo ogni 30 minuti.

## Nota: elenco modelli free e quote sono dinamici

Google cambia nel tempo i modelli free e le loro quote. GemRouter li tiene
allineati su tre livelli, senza intervento manuale:

1. **Catalogo per account (ogni 6 ore)** — ogni account interroga il proprio
   endpoint `/models` con la sua key. L'elenco `models` in
   `data/gemini-api-accounts.json` è un *tetto*, non la verità: un modello viene
   servito solo se è nella lista curata **e** Google lo serve ancora per quel
   account. Se Google lo ritira, sparisce dal routing da solo; i modelli curati
   non più disponibili compaiono in `curatedMissing` nella diagnostica
   (`/health` → `backends.geminiApi.accountModels`). Refresh manuale:
   `POST /v1/admin/gemini/account-models/refresh` (token admin).
2. **Quote reali (ogni 30 minuti)** — quando il quota monitor osserva da Cloud
   Monitoring un limite giornaliero reale per modello, quel valore sostituisce
   il limite RPD statico nel ledger (`monitorRpdLimit`).
3. **Free-tier policy (ogni 24 ore)** — la pagina prezzi di Google viene
   analizzata e la dashboard segnala nuovi modelli free ("attenzione nuovi
   modelli disponibili") o modelli configurati non più free/disponibili.
   L'aggiunta di un nuovo modello al routing resta una decisione manuale
   (i suoi limiti vanno verificati), ma la segnalazione è automatica.

## Errori comuni

- **`token exchange failed (400)`** — il file JSON della chiave è corrotto o
  incompleto: riscarica la chiave (Passo 5).
- **`monitoring query failed (403)`** — il service account non ha il ruolo
  Monitoring Viewer **su quel progetto**, oppure la Cloud Monitoring API non è
  abilitata (Passi 3–4).
- **`monitoring query failed (404)`** — `projectId` sbagliato nel file
  credenziali: usa il Project ID testuale, non il nome visualizzato.
- **osservazioni a zero** — normale se oggi quell'account non ha ancora fatto
  richieste: le serie compaiono col primo traffico del giorno.
