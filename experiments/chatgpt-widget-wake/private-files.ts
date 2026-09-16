import { mkdir, lstat, readFile, open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export const privateDir = process.env.WIDGET_WAKE_PRIVATE_DIR ?? '/home/OPERATOR/.local/share/gemrouter-widget-wake';
export const accessFile = join(privateDir, 'operator.json');
export async function checkDir(create = false) {
  if (!isAbsolute(privateDir)) throw new Error('private_directory_must_be_absolute');
  if (create) await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const st = await lstat(privateDir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('private_directory_requires_owner_mode_0700');
}
export async function readPrivate(path: string) {
  await checkDir();
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('private_file_requires_owner_mode_0600');
  return readFile(path, 'utf8');
}
export async function createPrivate(path: string, value: string) {
  await checkDir();
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(value); } finally { await file.close(); }
}
