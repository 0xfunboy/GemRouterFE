// SERVER ONLY. Never import this module into the public widget bundle.
export const TARGET = 'https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582';
export const WORKER = 'worker-000000007c41d5e30ad0';
// Returned only after private enrollment; events never carry instructions.
export const promptTemplate = `[GemRouter widget probe: EVENT_ID]

Questa è la verifica diagnostica che ho attivato nel widget.
Usa il connettore Example - Trade già disponibile in questa conversazione
per chiamare gateway_status una sola volta.
Non chiamare gateway_open o gateway_exchange. Non aprire run,
non elaborare job, non rifare OAuth e non usare altri strumenti.
Non richiamare il tool che ha renderizzato il widget.
Riporta EVENT_ID, il workerId e lo stato realmente restituiti.
Il worker atteso è ${WORKER}: se è diverso, segnala WORKER_MISMATCH e fermati.
Se il tool non è disponibile, riporta EVENT_ID e MCP_NOT_AVAILABLE.
Non sostituire la chiamata con risultati precedenti o inventati.
Termina dopo questa verifica, senza polling o ulteriori messaggi.`;
