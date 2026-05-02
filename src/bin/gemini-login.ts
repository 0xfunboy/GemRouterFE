import 'dotenv/config';

import { loadConfig } from '../config.js';
import { resolveGeminiCliDotDir, runGeminiBrowserLogin } from '../lib/geminiCli.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await runGeminiBrowserLogin(config.geminiCli);
  console.log('[gemini-auth] login complete');
  console.log(`[gemini-auth] cache dir: ${resolveGeminiCliDotDir(config.geminiCli)}`);
  if (result.accountEmail) {
    console.log(`[gemini-auth] account: ${result.accountEmail}`);
  }
  console.log(`[gemini-auth] callback port: ${result.callbackPort}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[gemini-auth] ${message}`);
  process.exit(1);
});
