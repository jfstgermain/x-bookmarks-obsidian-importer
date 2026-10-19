import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type Account = {
  userId: string;
  username: string;
  name: string;
};

export type Credentials = {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp at which the access token stops being valid. */
  tokenExpiresAt: string;
  scope: string;
  account?: Account;
  createdAt: string;
};

export type Config = {
  /** Absolute path to the Obsidian vault root. */
  vaultPath: string;
  /** Where new, untriaged notes are written (vault-relative). */
  inboxDir: string;
  /** Where triaged notes live; a YYYY subfolder is appended per note. */
  libraryDir: string;
  /** Vault-relative folder for downloaded media. */
  attachmentsDir: string;
  /** Vault-relative folder for generated per-author index notes. */
  authorsDir: string;
  /** Vault-relative folder for generated .base view files. */
  basesDir: string;
  /** Posts per API page (1-100). */
  maxResults: number;
  /** Download images and video posters into the vault. */
  downloadMedia: boolean;
  /** Also download mp4 variants (large; off by default). */
  downloadVideo: boolean;
};

export type Paths = {
  configDir: string;
  dataDir: string;
  rawDir: string;
  dbFile: string;
  credentialsFile: string;
  configFile: string;
};

const DEFAULTS: Omit<Config, 'vaultPath'> = {
  inboxDir: 'Inbox',
  libraryDir: 'Library',
  attachmentsDir: '05_Attachments',
  authorsDir: 'Authors',
  basesDir: 'Bases',
  maxResults: 100,
  downloadMedia: true,
  downloadVideo: false,
};

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

export function absolutePath(input: string, base = process.cwd()): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function paths(): Paths {
  const configDir = absolutePath(
    process.env.XBM_CONFIG_DIR ?? join(homedir(), '.config', 'x-bookmarks-importer'),
  );
  const repoRoot = resolve(import.meta.dirname, '..');
  const dataDir = absolutePath(process.env.XBM_DATA_DIR ?? join(repoRoot, 'data'));
  return {
    configDir,
    dataDir,
    rawDir: join(dataDir, 'raw'),
    dbFile: join(dataDir, 'bookmarks.db'),
    credentialsFile: join(configDir, 'credentials.json'),
    configFile: join(configDir, 'config.json'),
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write JSON atomically, and 0600 when it may hold secrets. */
function writeJsonAtomic(file: string, value: unknown, secret = false): void {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${(error as Error).message}`);
  }
}

export function loadCredentials(): Credentials | null {
  return readJson<Credentials>(paths().credentialsFile);
}

export function saveCredentials(credentials: Credentials): void {
  writeJsonAtomic(paths().credentialsFile, credentials, true);
}

export function requireCredentials(): Credentials {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error(
      `No credentials found at ${paths().credentialsFile}\nRun: node src/cli.ts auth --client-id <your X app client id>`,
    );
  }
  return credentials;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const stored = readJson<Partial<Config>>(paths().configFile) ?? {};
  const envVault = process.env.XBM_VAULT;
  const merged: Partial<Config> = { ...DEFAULTS, ...stored, ...overrides };
  if (envVault) merged.vaultPath = absolutePath(envVault);

  if (!merged.vaultPath) {
    throw new Error(
      `No vault configured.\nRun: node src/cli.ts init --vault "/path/to/your/vault"`,
    );
  }

  const config = merged as Config;
  config.vaultPath = absolutePath(config.vaultPath);
  return config;
}

export function saveConfig(config: Config): void {
  writeJsonAtomic(paths().configFile, config);
}

/** Ensure the vault looks like an Obsidian vault and its folders exist. */
export function ensureVaultLayout(config: Config): void {
  if (!existsSync(config.vaultPath)) {
    throw new Error(`Vault path does not exist: ${config.vaultPath}`);
  }
  for (const dir of [
    config.inboxDir,
    config.libraryDir,
    config.attachmentsDir,
    config.authorsDir,
    config.basesDir,
  ]) {
    ensureDir(join(config.vaultPath, dir));
  }
}

export function ensureDataDirs(): Paths {
  const p = paths();
  ensureDir(p.dataDir);
  ensureDir(p.rawDir);
  ensureDir(p.configDir);
  return p;
}

export { DEFAULTS };
