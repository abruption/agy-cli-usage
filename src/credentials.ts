// Cross-platform reader for the Antigravity CLI (`agy`) OAuth credential.
//
// `agy` stores its token in the OS keyring using the zalando/go-keyring
// convention: service="gemini", account="antigravity". Long/binary values are
// stored with a `go-keyring-base64:` prefix followed by base64(JSON). The
// decoded JSON looks like:
//   { "token": { "access_token", "token_type", "refresh_token", "expiry" },
//     "auth_method": "consumer" }
//
// Read backends, tried in order:
//   1. macOS security CLI first; elsewhere isolated @napi-rs/keyring worker
//   2. OS CLI fallback                  (`security` on macOS, `secret-tool` on Linux)
//   3. Windows Credential Manager       (CredRead via powershell.exe — go-keyring's
//                                        target format differs from keyring-rs's)
//   4. File fallback                    (headless Linux: agy can't reach a keyring
//                                        and writes the token to a plain-JSON file)
// If every backend fails, the caller falls back to the PTY path which drives
// `agy` itself.

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, type RequestDeps } from './request.js';

// OAuth client for the Antigravity CLI. This is an installed/desktop ("public")
// OAuth client: per Google's own docs the client secret of an installed app is
// "obviously not treated as a secret" — it ships inside the agy binary and is
// identical for every user (the per-user identity is the keyring token, not
// this). Verified: the same client_id appears in agy's browser consent URL
// regardless of account, and the flow uses PKCE (code_challenge/S256), the
// mechanism that secures public clients precisely because the secret is public.
// Same pattern as Google's open-source gemini-cli.
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const KEYRING_SERVICE = 'gemini';
const KEYRING_ACCOUNT = 'antigravity';
const B64_PREFIX = 'go-keyring-base64:';

class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

interface Cred {
  accessToken: string;
  refreshToken: string | null;
  expiry: Date | null;
  authMethod: string | null;
}

// --- raw keyring read --------------------------------------------------------

export const CREDENTIAL_TIMEOUT_MS = 5_000;

/** Provider output is private; neither failures nor stderr are logged. */
export function runSecretCommand(file: string, args: string[], timeoutMs = CREDENTIAL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = execFile(file, args, {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
    proc.stdin?.end();
  });
}

function readViaNapiEsm(): Promise<string | null> {
  return runSecretCommand(process.execPath, [fileURLToPath(new URL('./keyring-worker.js', import.meta.url))]);
}

async function readViaCli(): Promise<string | null> {
  if (process.platform === 'darwin') {
    return runSecretCommand('security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w']);
  }
  if (process.platform === 'linux') {
    return runSecretCommand('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT]);
  }
  return null;
}

// On Windows, agy stores the token in Credential Manager via Go's
// zalando/go-keyring, whose target name is `service:account` ("gemini:antigravity").
// @napi-rs/keyring (keyring-rs) uses a different target format and can't find it,
// so we read the credential blob directly via the Win32 CredRead API through the
// built-in powershell.exe (no extra dependency).
const WIN_CRED_TARGET = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;

const PS_READ_CRED = `$ErrorActionPreference='Stop'
$sig=@'
using System;
using System.Runtime.InteropServices;
public class CredApi {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static byte[] Read(string target){
    IntPtr p; if(!CredRead(target,1,0,out p)) return null;
    try {
      var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
      var b=new byte[c.CredentialBlobSize];
      if(c.CredentialBlobSize>0) Marshal.Copy(c.CredentialBlob,b,0,c.CredentialBlobSize);
      return b;
    } finally { CredFree(p); }
  }
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$b=[CredApi]::Read('${WIN_CRED_TARGET}')
if($b -eq $null){ exit 1 }
[Console]::Out.Write([Convert]::ToBase64String($b))`;

async function readViaWindowsCredman(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const encoded = Buffer.from(PS_READ_CRED, 'utf16le').toString('base64');
    const b64 = await runSecretCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    );
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64');
    // go-keyring writes the value as UTF-8; tolerate UTF-16LE just in case.
    const utf8 = raw.toString('utf8');
    const looksValid = (s: string): boolean => s.startsWith(B64_PREFIX) || s.trimStart().startsWith('{');
    if (looksValid(utf8)) return utf8;
    const utf16 = raw.toString('utf16le');
    if (looksValid(utf16)) return utf16;
    return utf8;
  } catch {
    return null;
  }
}

// On headless Linux (no Secret Service) agy persists the token to a plain-JSON
// file instead of the keyring. Same payload shape, no `go-keyring-base64:` prefix.
//
// The jetski path is last on purpose. macOS keeps that file around next to the
// Keychain entry, and the two can hold *different* grants — an observed one was
// three days stale and belonged to a session with no Antigravity license, which
// still refreshes fine and only fails later at the quota call. Every keyring
// backend is tried first, so this is reached only where the alternative is no
// credential at all.
function readViaFile(): string | null {
  const candidates = [
    process.env.AGY_OAUTH_TOKEN_FILE,
    join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    join(homedir(), '.gemini', 'jetski-standalone-oauth-token'),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf8').trim();
        if (content) return content;
      }
    } catch {
      // unreadable (perms) — try next candidate
    }
  }
  return null;
}

export interface CredentialProviders {
  platform?: NodeJS.Platform;
  cli?: () => Promise<string | null>;
  native?: () => Promise<string | null>;
  windows?: () => Promise<string | null>;
  file?: () => string | null;
}

/** Injection is for credential-free tests; defaults preserve agy's provider precedence. */
export async function readRawSecret(providers: CredentialProviders = {}): Promise<string | null> {
  const cli = providers.cli ?? readViaCli;
  const native = providers.native ?? readViaNapiEsm;
  const backends = (providers.platform ?? process.platform) === 'darwin' ? [cli, native] : [native, cli];
  for (const backend of [...backends, providers.windows ?? readViaWindowsCredman, providers.file ?? readViaFile]) {
    try {
      const raw = await backend();
      if (raw) return raw;
    } catch { /* continue to the next read-only provider */ }
  }
  return null;
}

// --- decode ------------------------------------------------------------------

export function decodeSecret(raw: string): Cred {
  const payload = raw.startsWith(B64_PREFIX)
    ? Buffer.from(raw.slice(B64_PREFIX.length), 'base64').toString('utf8')
    : raw;
  let parsed: { token?: Record<string, unknown>; auth_method?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CredentialError('Stored agy credential is not valid JSON');
  }
  const token = (parsed.token ?? parsed) as Record<string, unknown>;
  const accessToken = token.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new CredentialError('Stored agy credential has no access_token');
  }
  const expiry = token.expiry;
  return {
    accessToken,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
    expiry: typeof expiry === 'string' ? new Date(expiry) : null,
    authMethod: typeof parsed.auth_method === 'string' ? parsed.auth_method : null,
  };
}

// --- refresh -----------------------------------------------------------------

function isExpired(cred: Cred, skewMs = 60_000): boolean {
  if (!cred.expiry) return false;
  return cred.expiry.getTime() - Date.now() < skewMs;
}

export async function refreshAccessToken(refreshToken: string, deps: RequestDeps = {}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });
  const json = await requestJson<{ access_token: string }>(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, (status) => new CredentialError(`Token refresh failed: HTTP ${status}`), deps);
  return json.access_token;
}

// --- public API --------------------------------------------------------------

export interface AccessToken {
  accessToken: string;
  authMethod: string | null;
}

/**
 * Returns a valid access token for the Cloud Code API, refreshing if needed.
 * Throws CredentialError if no credential can be read from any keyring backend
 * (the caller should then consider the PTY fallback).
 */
export async function getAccessToken(): Promise<AccessToken> {
  const raw = await readRawSecret();
  if (!raw) {
    throw new CredentialError(
      'Could not read agy credential from the OS keyring or token file. ' +
        'Is agy logged in on this machine? (set AGY_OAUTH_TOKEN_FILE to override the path, ' +
        'or use --source pty)',
    );
  }
  const cred = decodeSecret(raw);
  if (isExpired(cred) && cred.refreshToken) {
    const fresh = await refreshAccessToken(cred.refreshToken);
    return { accessToken: fresh, authMethod: cred.authMethod };
  }
  return { accessToken: cred.accessToken, authMethod: cred.authMethod };
}

/** Whether a keyring-based credential is readable at all (no refresh attempted). */
export async function hasCredential(): Promise<boolean> {
  return (await readRawSecret()) != null;
}

export { CredentialError };
