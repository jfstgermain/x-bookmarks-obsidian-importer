import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { composeNote, splitFrontmatter, type Frontmatter } from './frontmatter.ts';
import { buildVaultIndex } from './render.ts';
import { sanitizeFilename } from './util.ts';
import { writeFileAtomic } from './vault-io.ts';

/** One row of the compact digest an AI (or a human) needs in order to tag a note. */
export type DigestEntry = {
  id: string;
  path: string;
  handle: string;
  author: string;
  published: string;
  kind: string;
  status: string;
  topics: string[];
  media: string[];
  excerpt: string;
};

function excerptOf(body: string, maxChars = 320): string {
  const paragraphs: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('>') || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.startsWith('---') || /^\[.*\]\(.*\)/.test(line)) continue;
    if (/^https?:\/\/\S+$/.test(line)) continue;
    paragraphs.push(line);
    if (paragraphs.join(' ').length >= maxChars) break;
  }
  const joined = paragraphs
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

/** Compact view of every note in a folder, ordered oldest post first. */
export function buildDigest(
  config: Config,
  options: { folder?: string; limit?: number; status?: string } = {},
): DigestEntry[] {
  const folder = options.folder ?? config.inboxDir;
  const index = buildVaultIndex(config.vaultPath, [folder]);
  const entries: DigestEntry[] = [];

  for (const entry of index.values()) {
    const frontmatter = entry.frontmatter ?? {};
    const status = String(frontmatter.status ?? 'inbox');
    if (options.status && status !== options.status) continue;
    entries.push({
      id: String(frontmatter.id),
      path: entry.path,
      handle: String(frontmatter.handle ?? ''),
      author: String(frontmatter.author ?? ''),
      published: String(frontmatter.published ?? ''),
      kind: String(frontmatter.kind ?? 'post'),
      status,
      topics: Array.isArray(frontmatter.topics) ? frontmatter.topics.map(String) : [],
      media: Array.isArray(frontmatter.media) ? frontmatter.media.map(String) : [],
      excerpt: excerptOf(entry.body),
    });
  }

  entries.sort((a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id));
  return options.limit ? entries.slice(0, options.limit) : entries;
}

export type PlanEntry = { id: string; topics: string[]; summary?: string };

export type ApplyOptions = {
  /** Status to stamp on every planned note. `null` leaves it untouched. */
  status?: 'kept' | 'dropped' | null;
  /** Move triaged notes into Library/<year>/ instead of leaving them in Inbox. */
  into?: 'library' | null;
  dryRun?: boolean;
};

export type ApplySummary = {
  updated: number;
  moved: number;
  skipped: number;
  unknownIds: string[];
  topicCounts: Map<string, number>;
};

/** Parse a plan file: either `[{id, topics}]` or `{ entries: [...] }`. */
export function readPlan(file: string): PlanEntry[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { entries?: unknown }).entries as unknown[]) ?? [];
  if (!Array.isArray(list)) throw new Error(`Plan file has no entries: ${file}`);

  const entries: PlanEntry[] = [];
  for (const raw of list) {
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? '').trim();
    if (!id) continue;
    const topics = Array.isArray(item.topics)
      ? item.topics.map((topic) => String(topic).trim().toLowerCase()).filter(Boolean)
      : [];
    entries.push({
      id,
      topics: [...new Set(topics)],
      summary: item.summary ? String(item.summary) : undefined,
    });
  }
  return entries;
}

/**
 * Apply topic/status decisions to notes and optionally file them into Library/<year>/.
 * Notes are located by their `id` property, so this works whatever the current path is.
 */
export function applyPlan(
  config: Config,
  db: DatabaseSync,
  plan: PlanEntry[],
  options: ApplyOptions = {},
): ApplySummary {
  const byId = new Map(buildDigest(config, { folder: config.inboxDir }).map((e) => [e.id, e]));
  // Also look in Library so re-running is idempotent after a previous triage.
  for (const entry of buildDigest(config, { folder: config.libraryDir })) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const summary: ApplySummary = {
    updated: 0,
    moved: 0,
    skipped: 0,
    unknownIds: [],
    topicCounts: new Map(),
  };

  for (const entry of plan) {
    const note = byId.get(entry.id);
    if (!note) {
      summary.unknownIds.push(entry.id);
      continue;
    }

    const absolute = join(config.vaultPath, note.path);
    if (!existsSync(absolute)) {
      summary.skipped += 1;
      continue;
    }

    const content = readFileSync(absolute, 'utf8');
    const { frontmatter, body } = splitFrontmatter(content);
    const current: Frontmatter = frontmatter ?? {};

    const updates: Frontmatter = { ...current, topics: entry.topics };
    if (options.status) updates.status = options.status;
    if (entry.summary) updates.summary = entry.summary;
    const merged = updates;

    const nextContent = composeNote(merged, body);
    const year = String(merged.published ?? '').slice(0, 4) || 'undated';

    let targetPath = note.path;
    if (options.into === 'library' && note.path.startsWith(`${config.inboxDir}/`)) {
      const targetDir = join(config.vaultPath, config.libraryDir, year);
      targetPath = join(config.libraryDir, year, sanitizeFilename(basename(note.path), 200));
    }

    if (options.dryRun) {
      summary.updated += 1;
      if (targetPath !== note.path) summary.moved += 1;
      for (const topic of entry.topics) {
        summary.topicCounts.set(topic, (summary.topicCounts.get(topic) ?? 0) + 1);
      }
      continue;
    }

    writeFileAtomic(absolute, nextContent);

    if (targetPath !== note.path) {
      const targetAbsolute = join(config.vaultPath, targetPath);
      if (existsSync(targetAbsolute)) {
        // Never clobber: fall back to an id-suffixed name.
        targetPath = targetPath.replace(/\.md$/, ` - ${entry.id}.md`);
      }
      const finalAbsolute = join(config.vaultPath, targetPath);
      // Library/<year>/ is created lazily, so the destination may not exist yet.
      mkdirSync(dirname(finalAbsolute), { recursive: true });
      renameSync(absolute, finalAbsolute);
      db.prepare('UPDATE posts SET note_path = ? WHERE id = ?').run(targetPath, entry.id);
      summary.moved += 1;
    }

    summary.updated += 1;
    for (const topic of entry.topics) {
      summary.topicCounts.set(topic, (summary.topicCounts.get(topic) ?? 0) + 1);
    }
  }

  return summary;
}

export function describeApply(summary: ApplySummary, dryRun = false): string {
  const topics = [...summary.topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => `${topic} (${count})`)
    .join(', ');
  const bits = [
    `${summary.updated} updated`,
    `${summary.moved} moved`,
    summary.skipped ? `${summary.skipped} skipped` : '',
    summary.unknownIds.length ? `${summary.unknownIds.length} unknown ids` : '',
    dryRun ? 'DRY RUN' : '',
  ].filter(Boolean);
  return `${bits.join(' · ')}${topics ? `\n  topics: ${topics}` : ''}`;
}
