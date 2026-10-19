import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { splitFrontmatter } from '../src/frontmatter.ts';
import { applyPlan, buildDigest, readPlan } from '../src/triage.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'xbm-triage-'));
  const vaultPath = join(root, 'vault');
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  mkdirSync(join(vaultPath, 'Inbox'), { recursive: true });
  const config: Config = { ...DEFAULTS, vaultPath };
  const db = openDb(join(root, 'db.sqlite'));
  return { root, vaultPath, config, db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeNote(vaultPath: string, filename: string, id: string, extra: string[] = []): string {
  const lines = [
    '---',
    `id: "${id}"`,
    `url: "https://x.com/a/status/${id}"`,
    'handle: "@a"',
    'author: A',
    'published: 2026-05-04',
    'added: 2026-10-19',
    'kind: post',
    'status: inbox',
    'topics: []',
    ...extra,
    '---',
    'Body text that matters.',
    '',
    '## My notes',
    '',
    '',
  ].join('\n');
  const path = join(vaultPath, 'Inbox', filename);
  writeFileSync(path, lines, 'utf8');
  return path;
}

test('digest lists inbox notes with a usable excerpt', () => {
  const { vaultPath, config, cleanup } = setup();
  try {
    writeNote(vaultPath, 'a.md', '111');
    const digest = buildDigest(config);
    assert.equal(digest.length, 1);
    assert.equal(digest[0]!.id, '111');
    assert.equal(digest[0]!.excerpt, 'Body text that matters.');
    assert.deepEqual(digest[0]!.topics, []);
  } finally {
    cleanup();
  }
});

test('applying a plan stamps topics, sets status and files into Library/<year>/', () => {
  const { vaultPath, config, db, cleanup } = setup();
  try {
    writeNote(vaultPath, 'a.md', '111');
    writeNote(vaultPath, 'b.md', '222');

    const summary = applyPlan(
      config,
      db,
      [
        { id: '111', topics: ['ai-agents', 'learning'] },
        { id: '222', topics: ['finance'] },
      ],
      { status: 'kept', into: 'library' },
    );

    assert.equal(summary.updated, 2);
    assert.equal(summary.moved, 2);
    assert.equal(summary.unknownIds.length, 0);
    assert.equal(readdirSync(join(vaultPath, 'Inbox')).length, 0, 'inbox emptied');

    const yearDir = join(vaultPath, 'Library', '2026');
    assert.equal(readdirSync(yearDir).length, 2, 'year folder created on demand');

    const { frontmatter, body } = splitFrontmatter(readFileSync(join(yearDir, 'a.md'), 'utf8'));
    assert.equal(frontmatter?.status, 'kept');
    assert.deepEqual(frontmatter?.topics, ['ai-agents', 'learning']);
    assert.match(body, /Body text that matters\./, 'note body untouched');
  } finally {
    cleanup();
  }
});

test('re-applying the same plan is idempotent and finds moved notes', () => {
  const { vaultPath, config, db, cleanup } = setup();
  try {
    writeNote(vaultPath, 'a.md', '111');
    const plan = [{ id: '111', topics: ['ai-agents'] }];
    const first = applyPlan(config, db, plan, { status: 'kept', into: 'library' });
    assert.equal(first.updated, 1);
    assert.equal(first.moved, 1);

    const second = applyPlan(config, db, plan, { status: 'kept', into: 'library' });

    assert.equal(second.updated, 1);
    assert.equal(second.moved, 0, 'already in Library, nothing to move');
    assert.equal(second.unknownIds.length, 0, 'notes in Library are still found by id');
  } finally {
    cleanup();
  }
});

test('a dry run changes nothing on disk', () => {
  const { vaultPath, config, db, cleanup } = setup();
  try {
    writeNote(vaultPath, 'a.md', '111');
    const summary = applyPlan(config, db, [{ id: '111', topics: ['ai-agents'] }], {
      status: 'kept',
      into: 'library',
      dryRun: true,
    });

    assert.equal(summary.updated, 1);
    assert.equal(summary.moved, 1);
    assert.equal(readdirSync(join(vaultPath, 'Inbox')).length, 1, 'still in Inbox');
    assert.equal(existsSync(join(vaultPath, 'Library')), false, 'no Library folder created');
    const { frontmatter } = splitFrontmatter(readFileSync(join(vaultPath, 'Inbox', 'a.md'), 'utf8'));
    assert.equal(frontmatter?.status, 'inbox', 'status untouched');
  } finally {
    cleanup();
  }
});

test('ids that are not in the vault are reported, not silently dropped', () => {
  const { config, db, cleanup } = setup();
  try {
    const summary = applyPlan(config, db, [{ id: 'does-not-exist', topics: ['x'] }], {
      status: 'kept',
    });
    assert.deepEqual(summary.unknownIds, ['does-not-exist']);
    assert.equal(summary.updated, 0);
  } finally {
    cleanup();
  }
});

test('missing summary is left alone, provided summary is written', () => {
  const { vaultPath, config, db, cleanup } = setup();
  try {
    writeNote(vaultPath, 'a.md', '111');
    applyPlan(config, db, [{ id: '111', topics: ['x'], summary: 'One-liner.' }], { status: 'kept' });
    const { frontmatter } = splitFrontmatter(readFileSync(join(vaultPath, 'Inbox', 'a.md'), 'utf8'));
    assert.equal(frontmatter?.summary, 'One-liner.');
    assert.equal(frontmatter?.status, 'kept');
  } finally {
    cleanup();
  }
});

test('plan files are read from both array and {entries} shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xbm-plan-'));
  try {
    const arrayFile = join(dir, 'a.json');
    writeFileSync(arrayFile, JSON.stringify([{ id: '1', topics: ['AI-Agents ', 'ai-agents'] }]));
    const fromArray = readPlan(arrayFile);
    assert.deepEqual(fromArray[0]!.topics, ['ai-agents'], 'lowercased and de-duplicated');

    const objectFile = join(dir, 'b.json');
    writeFileSync(objectFile, JSON.stringify({ entries: [{ id: '2', topics: ['x'] }] }));
    assert.equal(readPlan(objectFile)[0]!.id, '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
