import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { base64url, randomToken } from './util.ts';
import { log } from './log.ts';
import {
  loadCredentials,
  paths,
  saveCredentials,
  type Account,
  type Credentials,
} from './config.ts';

export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const DEFAULT_SCOPES = ['bookmark.read', 'tweet.read', 'users.read', 'offline.access'];
const DEFAULT_PORT = 8787;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
};

export function createPkcePair(): { verifier: string; challenge: string } {
  // RFC 7636: verifier is 43-128 chars from the unreserved set.
  const verifier = randomToken(48);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Token endpoint returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok || parsed.error) {
    const detail = parsed.error_description ?? parsed.error ?? text.slice(0, 300);
    throw new Error(`Token request failed (${response.status}): ${detail}`);
  }
  return parsed;
}

export async function fetchAccount(accessToken: string): Promise<Account> {
  const response = await fetch('https://api.x.com/2/users/me?user.fields=username,name', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET /2/users/me failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const payload = JSON.parse(text) as { data?: { id?: string; username?: string; name?: string } };
  const data = payload.data;
  if (!data?.id || !data.username) {
    throw new Error(`GET /2/users/me returned no user: ${text.slice(0, 300)}`);
  }
  return { userId: data.id, username: data.username, name: data.name ?? data.username };
}

function expiresAtFrom(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Exchange a refresh token for a fresh access token. X rotates refresh tokens. */
export async function refreshAccessToken(credentials: Credentials): Promise<Credentials> {
  if (!credentials.refreshToken) {
    throw new Error(
      'No refresh token stored. Re-run auth with the offline.access scope so the importer can run unattended.',
    );
  }
  log.debug('Refreshing access token');
  const token = await postToken({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
  });

  const next: Credentials = {
    ...credentials,
    accessToken: token.access_token,
    // X may or may not rotate; keep the old one if they didn't send a new one.
    refreshToken: token.refresh_token ?? credentials.refreshToken,
    tokenExpiresAt: expiresAtFrom(token.expires_in),
    scope: token.scope ?? credentials.scope,
  };
  saveCredentials(next);
  return next;
}

/** Returns a valid access token, refreshing if it is expired or about to expire. */
export async function getValidAccessToken(credentials: Credentials): Promise<string> {
  const expiresAt = new Date(credentials.tokenExpiresAt).getTime();
  const skewMs = 60_000;
  if (!Number.isNaN(expiresAt) && expiresAt - skewMs > Date.now()) {
    return credentials.accessToken;
  }
  const refreshed = await refreshAccessToken(credentials);
  return refreshed.accessToken;
}

export async function ensureAccount(credentials: Credentials): Promise<Account> {
  if (credentials.account?.userId) return credentials.account;
  const token = await getValidAccessToken(credentials);
  const account = await fetchAccount(token);
  saveCredentials({ ...credentials, account });
  return account;
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

type CallbackResult = { code?: string; error?: string; errorDescription?: string; state?: string };

function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const result: CallbackResult = {
        code: url.searchParams.get('code') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
      };

      const ok = Boolean(result.code) && result.state === expectedState;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>X bookmarks importer</title>
         <style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem}</style>
         <h1>${ok ? 'Authorised ✓' : 'Authorisation failed'}</h1>
         <p>${ok ? 'You can close this tab and return to the terminal.' : (result.errorDescription ?? result.error ?? 'Missing code or state mismatch')}</p>`,
      );

      // Give the response a tick to flush before tearing the server down.
      setTimeout(() => server.close(), 50);
      if (ok) resolve(result);
      else reject(new Error(result.errorDescription ?? result.error ?? 'Authorisation denied'));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Interactive one-time OAuth 2.0 Authorization Code flow with PKCE.
 * Requires an X developer app configured as a public client with the
 * callback URL matching `http://localhost:<port>/callback`.
 */
export async function authorise(options: {
  clientId?: string;
  port?: number;
  scopes?: string[];
  openBrowser?: boolean;
}): Promise<Credentials> {
  const existing = loadCredentials();
  const clientId = options.clientId ?? existing?.clientId ?? (await ask('X app Client ID: '));
  if (!clientId) throw new Error('A client ID is required. Create an app at https://developer.x.com/');

  const port = options.port ?? DEFAULT_PORT;
  const redirectUri = `http://localhost:${port}/callback`;
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const { verifier, challenge } = createPkcePair();
  const state = randomToken(16);

  const url = buildAuthorizeUrl({ clientId, redirectUri, scopes, state, challenge });

  log.heading('\nAuthorise the importer against your X account\n');
  log.info('1. Make sure your X app has this exact callback URL set:');
  log.info(`     ${log.bold(redirectUri)}`);
  log.info('2. Open this URL and approve access:\n');
  log.info(`   ${url}\n`);
  log.info('Requested scopes:', scopes.join(', '), '\n');

  const callbackPromise = waitForCallback(port, state);
  log.dim('Waiting for the browser callback…');
  log.info('');
  const callback = await callbackPromise;
  if (!callback.code) throw new Error('No authorisation code returned.');

  const token = await postToken({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const credentials: Credentials = {
    clientId,
    redirectUri,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? '',
    tokenExpiresAt: expiresAtFrom(token.expires_in),
    scope: token.scope ?? scopes.join(' '),
    createdAt: new Date().toISOString(),
  };

  const account = await fetchAccount(credentials.accessToken);
  credentials.account = account;
  saveCredentials(credentials);

  if (!credentials.refreshToken) {
    log.warn('No refresh token returned — add the offline.access scope so syncs can run unattended.');
  }

  log.ok(`Authorised as ${account.name} (@${account.username}, id ${account.userId})`);
  log.info('Credentials saved to', log.dim(paths().credentialsFile));
  return credentials;
}
