#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorise, ensureAccount } from './auth.ts';
import {
  DEFAULTS,
  ensureDataDirs,
  ensureVaultLayout,
  loadConfig,
  loadCredentials,
  paths,
  requireCredentials,
  saveConfig,
  type Config,
} from './config.ts';
import {
  estimatedCostUsd,
  finishRun,
  getMeta,
  openDb,
  setMeta,
  startRun,
  stats,
  vanishedCount,
} from './db.ts';
import { log, setVerbose } from './log.ts';
import { downloadAllMedia, pendingMediaCount } from './media.ts';
import { buildVaultIndex, renderAll } from './render.ts';
import { buildAuthorNotes, writeBases } from './views.ts';
import { writeVaultDocs } from './vault-docs.ts';
import { XApi, syncBookmarks } from './xapi.ts';

const USAGE = `x-bookmarks-obsidian-importer

Usage: node src/cli.ts <command> [options]

Commands:
  init      Configure the vault path and create the vault skeleton
  auth      One-time OAuth 2.0 (PKCE) authorisation against your X app
  doctor    Check config, credentials, scopes and vault access
  sync      Pull bookmarks from the X API into the local database
  render    Write/refresh Obsidian notes from the database
  views     Regenerate .base views and per-author index notes
  all       sync + render + views
  status    Show what has been imported

Global options:
  --vault <path>     Override the configured vault path
  --verbose          Verbose logging
  --help             Show this help

init options:
  --vault <path>     Vault root (required unless already configured)
  --force            Rewrite the generated vault docs and bases

auth options:
  --client-id <id>   X app client id (OAuth 2.0 public client)
  --port <n>         Local callback port (default 8787)

sync options:
  --since <post-id>  Stop once this post id appears (use 'last' for the watermark from the
                     previous run). Turns a full re-read into a one-page top-up.
  --limit <n>        Stop after n posts
  --max-pages <n>    Stop after n API pages (100 posts each)
  --no-media         Skip media downloads for this run

render options:
  --limit <n>        Only render n pending notes (triage a backlog in batches)
  --force            Overwrite note bodies even if you edited them
`;

type Args = { command: string; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

const flagString = (args: Args, key: string): string | undefined => {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
};

const flagNumber = (args: Args, key: string): number | undefined => {
  const raw = flagString(args, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const flagOn = (args: Args, key: string): boolean => args.flags.get(key) === true;

function configFrom(args: Args): Config {
  const vaultOverride = flagString(args, 'vault');
  return loadConfig(vaultOverride ? { vaultPath: vaultOverride } : {});
}

function loadConfigSafe(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setVerbose(flagOn(args, 'verbose') || process.env.XBM_VERBOSE === '1');

  switch (args.command) {
    case 'help':
    case '--help':
      log.info(USAGE);
      return;

    case 'init': {
      const existing = loadConfigSafe();
      const vaultPath = flagString(args, 'vault') ?? existing?.vaultPath;
      if (!vaultPath) throw new Error('Pass --vault "/path/to/vault"');
      const config = { ...DEFAULTS, ...(existing ?? {}), vaultPath } as Config;
      ensureVaultLayout(config);
      saveConfig(config);
      const docs = writeVaultDocs(config);
      const bases = writeBases(config);
      log.ok(`vault configured: ${config.vaultPath}`);
      log.step(`config file: ${paths().configFile}`);
      if (docs.created.length) log.step(`created ${docs.created.join(', ')}`);
      if (bases.length) log.step(`wrote ${bases.length} base views to ${config.basesDir}/`);
      log.info('\nNext: create an X app (OAuth 2.0, public client, callback');
      log.info('http://localhost:8787/callback), then run:');
      log.info('  node src/cli.ts auth --client-id <client id>');
      return;
    }

    case 'auth': {
      const credentials = await authorise({
        clientId: flagString(args, 'client-id') ?? process.env.XBM_CLIENT_ID,
        port: flagNumber(args, 'port'),
      });
      const config = loadConfigSafe();
      if (config) {
        ensureVaultLayout(config);
        log.step(`vault: ${config.vaultPath}`);
        writeBases(config);
      } else {
        log.warn(`No vault configured yet. Run: node src/cli.ts init --vault "/path/to/vault"`);
      }
      log.info(`Account: @${credentials.account?.username} (${credentials.account?.userId})`);
      return;
    }

    case 'doctor':
      await runDoctor();
      return;

    case 'sync':
      await runSync(args);
      return;

    case 'render': {
      const config = configFrom(args);
      ensureVaultLayout(config);
      const db = openDb(ensureDataDirs().dbFile);
      const summary = renderAll(db, config, {
        limit: flagNumber(args, 'limit'),
        force: flagOn(args, 'force'),
      });
      log.ok(
        `render: ${summary.created} created · ${summary.updated} updated · ${summary.unchanged} unchanged · ${summary.bodyPreserved} kept your edits · ${summary.errors} errors`,
      );
      return;
    }

    case 'views': {
      const config = configFrom(args);
      ensureVaultLayout(config);
      log.ok(formatViews(config));
      return;
    }

    case 'all': {
      await runSync(args);
      const config = configFrom(args);
      const db = openDb(ensureDataDirs().dbFile);
      const summary = renderAll(db, config, { limit: flagNumber(args, 'limit') });
      log.ok(`render: ${summary.created} created · ${summary.updated} updated`);
      log.ok(formatViews(config));
      return;
    }

    case 'status':
      runStatus();
      return;

    default:
      log.error(`Unknown command: ${args.command}`);
      log.info(USAGE);
      process.exitCode = 1;
  }
}

function formatViews(config: Config): string {
  const bases = writeBases(config);
  const authors = buildAuthorNotes(config);
  return `views: ${bases.length} bases · ${authors.notes} author notes (${authors.removed} pruned)`;
}

async function runSync(args: Args): Promise<void> {
  const config = configFrom(args);
  ensureVaultLayout(config);
  const dataPaths = ensureDataDirs();
  const credentials = requireCredentials();
  const account = await ensureAccount(credentials);
  const userId = account.userId;

  const db = openDb(dataPaths.dbFile);
  const api = new XApi(credentials);
  const runId = startRun(db);
  setMeta(db, 'account_username', account.username);

  // `--since last` resolves to the topmost post of the previous run: a watermark that is
  // guaranteed to sit in bookmark order, so we can stop as soon as we reach it.
  const sinceFlag = flagString(args, 'since');
  let since = sinceFlag;
  if (sinceFlag === 'last') {
    since = getMeta(db, 'frontier_id') ?? undefined;
    if (!since) {
      log.warn('no watermark recorded yet (first run) — reading the full bookmark list');
    } else {
      log.step(`incremental: stopping at known post ${since}`);
    }
  }

  log.step(`syncing bookmarks for @${account.username}`);

  let result;
  try {
    result = await syncBookmarks(db, api, runId, {
      rawDir: dataPaths.rawDir,
      userId,
      maxResults: config.maxResults,
      maxPages: flagNumber(args, 'max-pages'),
      limit: flagNumber(args, 'limit'),
      since,
      preferredProfile: getMeta(db, 'field_profile') ?? undefined,
      onPage: (info) =>
        log.step(
          `page ${info.page} · ${info.seen} posts seen · est. $${estimatedCostUsd(info.seen).toFixed(4)}`,
        ),
    });
    finishRun(db, runId, {
      pages: result.pages,
      postsSeen: result.postsSeen,
      postsNew: result.postsNew,
      complete: result.complete,
      fieldProfile: result.fieldProfile,
    });
  } catch (error) {
    finishRun(db, runId, {
      pages: 0,
      postsSeen: 0,
      postsNew: 0,
      complete: false,
      fieldProfile: null,
      error: (error as Error).message,
    });
    throw error;
  }

  log.ok(
    `sync: ${result.postsSeen} posts in ${result.pages} page(s) · ${result.postsNew} new · ${result.fieldProfile} field names · est. $${result.costUsd.toFixed(4)}`,
  );
  if (!result.complete) {
    if (since && result.sinceFound) {
      log.step(
        `stopped at --since ${since} after ${result.pages} page(s) — everything below it was already imported`,
      );
    } else if (since) {
      log.warn(`--since ${since} never appeared; the full bookmark list was read instead`);
    } else {
      log.warn(
        'scan stopped before the end of the bookmark list — "no longer bookmarked" tracking stays off',
      );
    }
  }

  // Remember the topmost post for the next `--since last` run.
  if (result.firstPostId) setMeta(db, 'frontier_id', result.firstPostId);
  // Remember which field-name profile the API accepted, so later runs skip the probe.
  setMeta(db, 'field_profile', result.fieldProfile);

  const previousTotal = Number(getMeta(db, 'est_cost_total_usd') ?? '0');
  setMeta(db, 'est_cost_total_usd', (previousTotal + result.costUsd).toFixed(4));

  if (!flagOn(args, 'no-media') && config.downloadMedia) {
    const media = await downloadAllMedia(db, config);
    if (media.downloaded || media.failed) {
      log.ok(
        `media: ${media.downloaded} downloaded · ${media.skipped} already present · ${media.failed} failed`,
      );
    }
  }
}

async function runDoctor(): Promise<void> {
  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    label: `Node ${process.versions.node}`,
    ok: nodeMajor >= 24,
    detail: nodeMajor >= 24 ? 'built-in node:sqlite available' : 'Node 24+ required',
  });

  const config = loadConfigSafe();
  checks.push({ label: 'vault configured', ok: Boolean(config), detail: config?.vaultPath });

  if (config) {
    checks.push({
      label: 'vault detected',
      ok: existsSync(join(config.vaultPath, '.obsidian')),
      detail: config.vaultPath,
    });
    checks.push({
      label: 'vault folders writable',
      ok: (() => {
        try {
          ensureVaultLayout(config);
          return true;
        } catch {
          return false;
        }
      })(),
    });
  }

  const credentials = loadCredentials();
  checks.push({
    label: 'credentials present',
    ok: Boolean(credentials?.refreshToken),
    detail: credentials ? paths().credentialsFile : 'run: node src/cli.ts auth',
  });

  if (credentials) {
    const scopes = credentials.scope.split(/\s+/).filter(Boolean);
    checks.push({
      label: 'bookmark.read scope',
      ok: scopes.includes('bookmark.read'),
      detail: credentials.scope,
    });
    checks.push({ label: 'offline.access scope', ok: scopes.includes('offline.access') });

    try {
      const api = new XApi(credentials);
      const me = await api.me();
      checks.push({ label: 'X API reachable', ok: true, detail: `@${me.username} (${me.id})` });
      setMeta(openDb(ensureDataDirs().dbFile), 'account_username', me.username);
    } catch (error) {
      checks.push({ label: 'X API reachable', ok: false, detail: (error as Error).message });
    }
  }

  log.heading('\nDoctor\n');
  for (const check of checks) {
    const line = `${check.label}${check.detail ? ` ${log.dim(`— ${check.detail}`)}` : ''}`;
    if (check.ok) log.ok(line);
    else log.error(line);
  }

  const failed = checks.filter((check) => !check.ok);
  log.info('');
  if (failed.length === 0) log.ok('all checks passed');
  else {
    log.warn(`${failed.length} check(s) need attention`);
    process.exitCode = 1;
  }
}

function runStatus(): void {
  const dataPaths = ensureDataDirs();
  const db = openDb(dataPaths.dbFile);
  const summary = stats(db);
  const config = loadConfigSafe();
  const spend = Number(getMeta(db, 'est_cost_total_usd') ?? '0');

  log.heading('\nX bookmarks\n');
  log.info(`  posts in database     ${summary.posts}`);
  log.info(`  authors               ${summary.authors}`);
  log.info(`  notes written         ${summary.withNotes}`);
  log.info(`  pending render        ${summary.dirty}`);
  log.info(`  media files           ${summary.mediaFiles}`);
  log.info(`  media outstanding     ${pendingMediaCount(db)}`);
  log.info(`  first import          ${summary.firstSeen ?? '—'}`);
  log.info(`  estimated API spend   $${spend.toFixed(2)}`);
  if (summary.lastSync) {
    const partial = summary.lastSync.complete ? '' : ' (partial)';
    log.info(
      `  last sync             ${summary.lastSync.started_at} · ${summary.lastSync.posts_seen} seen / ${summary.lastSync.posts_new} new${partial}`,
    );
    if (summary.lastSync.error) {
      const firstLine = summary.lastSync.error.split('\n')[0] ?? summary.lastSync.error;
      log.info(`                        failed: ${firstLine}`);
    }
    const gone = vanishedCount(db);
    if (gone > 0) log.info(`  no longer bookmarked  ${gone}`);
  }
  log.info(`  database              ${dataPaths.dbFile}`);
  const frontier = getMeta(db, 'frontier_id');
  if (frontier) log.info(`  incremental watermark   ${frontier}`);

  if (config && existsSync(config.vaultPath)) {
    const index = buildVaultIndex(config.vaultPath, [config.inboxDir, config.libraryDir]);
    const counts = new Map<string, number>();
    for (const entry of index.values()) {
      const status = String(entry.frontmatter?.status ?? 'unknown');
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    log.info('');
    log.heading('Vault\n');
    if (counts.size === 0) log.info('  no notes yet');
    for (const [status, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      log.info(`  ${status.padEnd(20)} ${count}`);
    }
  }
}

main().catch((error: Error) => {
  log.error(error.message);
  if (process.env.XBM_VERBOSE === '1') console.error(error);
  process.exitCode = 1;
});
