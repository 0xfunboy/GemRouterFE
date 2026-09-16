import { join } from 'node:path';
import { z } from 'zod';
import { accessFile, privateDir, readPrivate, createPrivate } from './private-files.js';
import { CODE_MS, observationSchema } from './protocol.js';

const usage = `Usage:
  pnpm operator issue
  pnpm operator report
  pnpm operator emit SESSION_ID
  pnpm operator observe SESSION_ID EVENT_ID OUTCOME WORKER_ID|unknown foreground|background|offscreen --target-confirmed --turn-ended
  pnpm operator stop SESSION_ID
  pnpm operator shutdown
OUTCOME: model-tool | message-only | no-turn | approval | tool-missing | worker-mismatch
observe records ONLY an actual operator observation, never inferred from a bridge receipt.`;
async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!['issue', 'report', 'emit', 'observe', 'stop', 'shutdown'].includes(command)) throw new Error(usage);
  const access = z.object({ adminUrl: z.literal('http://127.0.0.1:8808'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(JSON.parse(await readPrivate(accessFile)));
  let body: unknown = {};
  if (command === 'emit' || command === 'stop') {
    if (args.length !== 1) throw new Error(usage);
    body = { sessionId: z.string().regex(/^session_[a-f0-9]{24}$/).parse(args[0]) };
  } else if (command === 'observe') {
    if (args.length !== 7 || args[5] !== '--target-confirmed' || args[6] !== '--turn-ended') throw new Error(usage);
    body = { sessionId: z.string().regex(/^session_[a-f0-9]{24}$/).parse(args[0]), observation: observationSchema.parse({
      eventId: args[1], outcome: args[2], ...(args[3] === 'unknown' ? {} : { workerId: args[3] }), conditions: args[4],
      targetConfirmed: true, turnEnded: true,
    }) };
  } else if (args.length) throw new Error(usage);
  const response = await fetch(access.adminUrl + '/' + command, { method: command === 'report' ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + access.token, 'Content-Type': 'application/json' },
    body: command === 'report' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? 'operator_request_failed'));
  if (command === 'issue') {
    const file = join(privateDir, String(data.sessionId) + '.code');
    await createPrivate(file, String(data.code));
    console.log(JSON.stringify({ sessionId: data.sessionId, expiresAt: data.expiresAt, codeExpiresInSeconds: CODE_MS / 1000,
      codeFile: file, instruction: 'Open this private file in your editor and paste the code ONLY into the widget. Do not paste it in the chat or tool logs.' }, null, 2));
  } else console.log(JSON.stringify(data, null, 2));
}
try { await run(); } catch (error) {
  // Schema failures can contain submitted data: never print the whole object.
  console.error(error instanceof z.ZodError ? 'Invalid operator input' : error instanceof Error ? error.message : 'Operator error');
  process.exitCode = 1;
}
