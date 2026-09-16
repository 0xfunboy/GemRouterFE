import type { Method } from './client.js';

type BrowserCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};
export function createMountId(crypto: BrowserCrypto | undefined): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('secure_random_unavailable');
  // randomUUID is secure-context-only in browsers. getRandomValues provides
  // the same CSPRNG without depending on that convenience method. Never use
  // Math.random, timestamps, chat identifiers or credentials as a fallback.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function selectBridge(initialized: boolean, caps: { message?: { text?: unknown } } | undefined, alias: boolean): {
  method?: Method; declared: boolean; label: string;
} {
  const declared = initialized && caps?.message?.text !== undefined;
  if (declared) return { method: 'ui/message', declared, label: 'ui/message (testo dichiarato dall’host)' };
  if (alias) return { method: 'openai.sendFollowUpMessage', declared: false, label: 'Alias documentato: openai.sendFollowUpMessage' };
  // Older MCP Apps hosts can complete initialize without the optional message
  // capability. The pinned SDK permits ui/message after initialize. Only a
  // manual baseline may establish support; server gates still block remote arm.
  if (initialized && caps?.message === undefined) return { method: 'ui/message', declared: false,
    label: 'ui/message: inizializzato, capacità non dichiarata — verifica manuale' };
  return { declared: false, label: 'Nessun bridge utilizzabile rilevato' };
}
