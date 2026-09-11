export interface NativeKeyring {
  Entry: new (service: string, account: string) => { getPassword(): string | null | undefined };
}

/** v1 returns null for many provider failures; v2 throws. Both must allow fallback. */
export async function readNativeSecret(load: () => Promise<NativeKeyring> = () => import('@napi-rs/keyring')): Promise<string | null> {
  try {
    const { Entry } = await load();
    return new Entry('gemini', 'antigravity').getPassword() ?? null;
  } catch {
    return null;
  }
}
