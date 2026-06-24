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
//   1. @napi-rs/keyring native module  (macOS / Linux Secret Service)
//   2. OS CLI fallback                  (`security` on macOS, `secret-tool` on Linux)
//   3. Windows Credential Manager       (CredRead via powershell.exe — go-keyring's
//                                        target format differs from keyring-rs's)
//   4. File fallback                    (headless Linux: agy can't reach a keyring
//                                        and writes the token to a plain-JSON file)
// If every backend fails, the caller falls back to the PTY path which drives
// `agy` itself.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

class CredentialError extends Error {}

// --- raw keyring read --------------------------------------------------------

async function readViaNapiEsm() {
  try {
    const mod = await import('@napi-rs/keyring');
    const Entry = mod.Entry ?? mod.default?.Entry;
    if (!Entry) return null;
    return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT).getPassword();
  } catch {
    return null;
  }
}

function readViaCli() {
  try {
    if (process.platform === 'darwin') {
      return execFileSync(
        'security',
        ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'],
        { encoding: 'utf8' },
      ).trim();
    }
    if (process.platform === 'linux') {
      return execFileSync(
        'secret-tool',
        ['lookup', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT],
        { encoding: 'utf8' },
      ).trim();
    }
  } catch {
    return null;
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

function readViaWindowsCredman() {
  if (process.platform !== 'win32') return null;
  try {
    const encoded = Buffer.from(PS_READ_CRED, 'utf16le').toString('base64');
    const b64 = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8' },
    ).trim();
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64');
    // go-keyring writes the value as UTF-8; tolerate UTF-16LE just in case.
    const utf8 = raw.toString('utf8');
    const looksValid = (s) => s.startsWith(B64_PREFIX) || s.trimStart().startsWith('{');
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
function readViaFile() {
  const candidates = [
    process.env.AGY_OAUTH_TOKEN_FILE,
    join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  ].filter(Boolean);
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

async function readRawSecret() {
  const fromNapi = await readViaNapiEsm();
  if (fromNapi) return fromNapi;
  const fromCli = readViaCli();
  if (fromCli) return fromCli;
  const fromWin = readViaWindowsCredman();
  if (fromWin) return fromWin;
  const fromFile = readViaFile();
  if (fromFile) return fromFile;
  return null;
}

// --- decode ------------------------------------------------------------------

export function decodeSecret(raw) {
  const payload = raw.startsWith(B64_PREFIX)
    ? Buffer.from(raw.slice(B64_PREFIX.length), 'base64').toString('utf8')
    : raw;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CredentialError('Stored agy credential is not valid JSON');
  }
  const token = parsed.token ?? parsed;
  if (!token?.access_token) {
    throw new CredentialError('Stored agy credential has no access_token');
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiry: token.expiry ? new Date(token.expiry) : null,
    authMethod: parsed.auth_method ?? null,
  };
}

// --- refresh -----------------------------------------------------------------

function isExpired(cred, skewMs = 60_000) {
  if (!cred.expiry) return false;
  return cred.expiry.getTime() - Date.now() < skewMs;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new CredentialError(`Token refresh failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

// --- public API --------------------------------------------------------------

/**
 * Returns a valid access token for the Cloud Code API, refreshing if needed.
 * Throws CredentialError if no credential can be read from any keyring backend
 * (the caller should then consider the PTY fallback).
 * @returns {Promise<{ accessToken: string, authMethod: string|null }>}
 */
export async function getAccessToken() {
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
export async function hasCredential() {
  return (await readRawSecret()) != null;
}

export { CredentialError };
