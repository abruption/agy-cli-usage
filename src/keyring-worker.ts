// Synchronous native providers must only run in this killable subprocess.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function readNativeSecret(): Promise<string | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('gemini', 'antigravity').getPassword() ?? null;
  } catch {
    return null;
  }
}

function isMainModule(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isMainModule()) {
  const secret = await readNativeSecret();
  if (secret) process.stdout.write(secret);
}
