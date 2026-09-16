/** Explicit account-only CLI. Never opens a model turn, worker run or gateway database. */
import { randomUUID } from 'node:crypto';
import { readCodexConfig } from '../src/codex/config.js';
import { CodexRuntime, CodexRuntimeError } from '../src/codex/runtime.js';

const command = process.argv[2] ?? 'status';
if (!['status', 'usage', 'models', 'login'].includes(command)) {
  console.error('Usage: pnpm codex:account [status|usage|models|login]'); process.exit(2);
}
const runtime = new CodexRuntime({ ...readCodexConfig(), enabled: true, excludedDirectories: [process.cwd()] });
let closing = false;
const stop = async () => { if (!closing) { closing = true; await runtime.close(); process.exitCode = 130; } };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (command === 'login') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CodexRuntimeError('codex_interactive_terminal_required');
    const account = await runtime.status();
    if (account.authenticated) console.log('Codex già autenticato nel profilo dedicato. Nessun nuovo login avviato.');
    else {
      const owner = randomUUID();
      const login = await runtime.startLogin(owner, 'device');
      // Deliberately shown only in the operator's interactive terminal, never saved in the repo.
      console.log(`Apri ${login.verificationUrl} nel tuo browser e inserisci il codice: ${login.userCode}`);
      while (!closing) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (closing) break;
        const state = await runtime.loginStatus(owner);
        if (state?.status !== 'pending') {
          if (state?.status !== 'completed') throw new CodexRuntimeError('codex_login_not_completed');
          console.log('Login Codex completato nel profilo dedicato.'); break;
        }
      }
    }
  } else {
    const data = command === 'usage' ? await runtime.usage() : command === 'models' ? await runtime.models() : await runtime.status();
    console.log(JSON.stringify(data, null, 2));
    if (command === 'status' && !runtime.cachedStatus().authenticated) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof CodexRuntimeError ? error.code : 'codex_account_failed' }));
  if (!closing) process.exitCode = 1;
} finally { await runtime.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
