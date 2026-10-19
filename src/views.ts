import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Config } from './config.ts';
import { splitFrontmatter, composeNote, type Frontmatter } from './frontmatter.ts';
import { log } from './log.ts';
import { buildVaultIndex } from './render.ts';
import { normaliseHandle } from './util.ts';
import { writeFileAtomic } from './vault-io.ts';

const INBOX_BASE = `# Saved to Inbox, not yet triaged.
filters:
  and:
    - 'file.inFolder("Inbox")'
formulas:
  age_days: '(now() - date(added)).days.round(0)'
properties:
  handle:
    displayName: Author
  published:
    displayName: Posted
  added:
    displayName: Saved
  formula.age_days:
    displayName: Days old
views:
  - type: cards
    name: "Reading queue"
    limit: 10
    filters:
      and:
        - 'status == "inbox"'
    order:
      - file.name
      - handle
      - published
      - summary
    sort:
      - property: published
        direction: ASC
  - type: table
    name: "Untriaged"
    filters:
      and:
        - 'status != "kept"'
        - 'status != "dropped"'
    order:
      - file.name
      - handle
      - published
      - formula.age_days
      - topics
    sort:
      - property: published
        direction: DESC
`;

const LIBRARY_BASE = `# Everything you kept, newest first.
filters:
  and:
    - 'file.inFolder("Library")'
formulas:
  year: 'date(published).year'
properties:
  handle:
    displayName: Author
  published:
    displayName: Posted
  added:
    displayName: Saved
  formula.year:
    displayName: Year
views:
  - type: table
    name: "Recent"
    limit: 25
    order:
      - file.name
      - handle
      - published
      - added
      - topics
    sort:
      - property: added
        direction: DESC
  - type: table
    name: "Library"
    order:
      - file.name
      - handle
      - published
      - topics
    groupBy:
      property: formula.year
      direction: DESC
    sort:
      - property: published
        direction: DESC
  - type: table
    name: "Dropped"
    filters:
      and:
        - 'status == "dropped"'
    order:
      - file.name
      - handle
      - published
    sort:
      - property: published
        direction: DESC
`;

const AUTHORS_BASE = `# Who you actually save from.
filters:
  and:
    - 'file.hasProperty("handle")'
formulas:
  saved: '1'
properties:
  handle:
    displayName: Author
views:
  - type: table
    name: "By author"
    order:
      - handle
      - author
      - published
      - kind
    groupBy:
      property: handle
      direction: ASC
    sort:
      - property: published
        direction: DESC
`;

const TOPICS_BASE = `# Topic coverage across kept bookmarks.
filters:
  and:
    - 'status == "kept"'
properties:
  topics:
    displayName: Topics
  handle:
    displayName: Author
views:
  - type: table
    name: "Kept by year"
    order:
      - file.name
      - handle
      - published
      - topics
    sort:
      - property: published
        direction: DESC
`;

export const BASE_FILES: Array<{ file: string; content: string }> = [
  { file: 'Inbox.base', content: INBOX_BASE },
  { file: 'Library.base', content: LIBRARY_BASE },
  { file: 'Authors.base', content: AUTHORS_BASE },
  { file: 'Topics.base', content: TOPICS_BASE },
];

/** Write the .base view files, validating each one before it lands. */
export function writeBases(config: Config): string[] {
  const written: string[] = [];
  for (const base of BASE_FILES) {
    try {
      parseYaml(base.content);
    } catch (error) {
      log.error(`Refusing to write invalid base ${base.file}: ${(error as Error).message}`);
      continue;
    }
    const target = join(config.vaultPath, config.basesDir, base.file);
    writeFileAtomic(target, base.content);
    written.push(base.file);
  }
  return written;
}

function excerpt(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('!')) continue;
    if (trimmed.startsWith('---')) continue;
    if (/^\[.*\]\(.*\)/.test(trimmed)) continue;
    const cleaned = trimmed
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (cleaned.length < 3) continue;
    return cleaned.length > 160 ? `${cleaned.slice(0, 159)}…` : cleaned;
  }
  return '';
}

export type AuthorIndexSummary = { authors: number; notes: number; removed: number; skipped: number };

/**
 * Generate one index note per author, plus prune stale generated ones.
 * `handles` is the set that deserves an index (see qualifyingHandles): authors below the
 * threshold get no file, and their notes link to them as plain text instead.
 */
export function buildAuthorNotes(config: Config, handles: Set<string>): AuthorIndexSummary {
  const index = buildVaultIndex(config.vaultPath, [config.inboxDir, config.libraryDir]);

  type Entry = {
    path: string;
    basename: string;
    body: string;
    frontmatter: Frontmatter;
  };

  const byHandle = new Map<string, Entry[]>();
  for (const entry of index.values()) {
    const handle = entry.frontmatter?.handle;
    if (!handle) continue;
    if (!handles.has(String(handle))) continue;
    const list = byHandle.get(String(handle)) ?? [];
    list.push({
      path: entry.path,
      basename: entry.path.replace(/\.md$/, ''),
      body: entry.body,
      frontmatter: entry.frontmatter ?? {},
    });
    byHandle.set(String(handle), list);
  }

  const authorsDir = join(config.vaultPath, config.authorsDir);
  let removed = 0;
  let notes = 0;

  for (const [handle, entries] of byHandle) {
    entries.sort((a, b) => String(b.frontmatter.published ?? '').localeCompare(String(a.frontmatter.published ?? '')));
    const name = String(entries[0]?.frontmatter.author ?? handle);
    const years = new Map<string, Entry[]>();
    for (const entry of entries) {
      const year = String(entry.frontmatter.published ?? '').slice(0, 4) || 'undated';
      const list = years.get(year) ?? [];
      list.push(entry);
      years.set(year, list);
    }

    const lines: string[] = [
      `# ${normaliseHandle(handle)}`,
      '',
      `${name} · ${entries.length} saved post${entries.length === 1 ? '' : 's'}`,
      '',
    ];

    for (const [year, list] of [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      lines.push(`## ${year}`, '');
      for (const entry of list) {
        const published = String(entry.frontmatter.published ?? '');
        const summary = excerpt(entry.body);
        const link = `[[${entry.basename}|${published} · ${String(entry.frontmatter.kind ?? 'post')}]]`;
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''}`);
      }
      lines.push('');
    }

    const frontmatter: Frontmatter = {
      generated: true,
      handle: normaliseHandle(handle),
      name,
      count: entries.length,
    };

    writeFileAtomic(
      join(authorsDir, `${normaliseHandle(handle)}.md`),
      composeNote(frontmatter, `${lines.join('\n')}`),
    );
    notes += 1;
  }

  // Prune generated author notes whose author no longer has any saved posts.
  if (existsSync(authorsDir)) {
    for (const file of readdirSync(authorsDir)) {
      if (!file.endsWith('.md')) continue;
      const path = join(authorsDir, file);
      const { frontmatter } = splitFrontmatter(readFileSync(path, 'utf8'));
      if (frontmatter?.generated === true && !byHandle.has(String(frontmatter.handle ?? ''))) {
        unlinkSync(path);
        removed += 1;
      }
    }
  }

  return { authors: byHandle.size, notes, removed, skipped: handles.size - byHandle.size };
}
