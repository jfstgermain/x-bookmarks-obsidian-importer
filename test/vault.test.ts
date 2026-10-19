import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.ts';
import { openDb, qualifyingHandles, startRun, upsertPost, type PostRow } from '../src/db.ts';
import { splitFrontmatter } from '../src/frontmatter.ts';
import { renderAll } from '../src/render.ts';
import { buildAuthorNotes, writeBases } from '../src/views.ts';
import { writeVaultDocs } from '../src/vault-docs.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'xbm-vault-'));
  const vaultPath = join(root, 'vault');
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  const db = openDb(join(root, 'db.sqlite'));
  const config: Config = { ...DEFAULTS, vaultPath };
  return {
    root,
    vaultPath,
    db,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: '111',
    url: 'https://x.com/janedoe/status/111',
    authorId: '42',
    authorName: 'Jane Doe',
    handle: '@janedoe',
    text: 'Reliability beats cleverness',
    noteText: null,
    fullText: 'Reliability beats cleverness',
    createdAt: '2026-03-14T10:00:00.000Z',
    lang: 'en',
    conversationId: '111',
    inReplyToUserId: null,
    refType: null,
    quotedId: null,
    quotedHandle: null,
    quotedName: null,
    quotedText: null,
    quotedCreatedAt: null,
    likeCount: 5,
    retweetCount: 0,
    replyCount: 0,
    quoteCount: 0,
    articleUrl: null,
    articleTitle: null,
    articlePreview: null,
    articleText: null,
    links: [],
    media: [],
    ...overrides,
  };
}

function noteFile(vaultPath: string, id: string): string {
  for (const folder of ['Inbox', 'Library']) {
    const dir = join(vaultPath, folder);
    let entries: Array<{ parentPath: string; name: string; isFile: () => boolean }> = [];
    try {
      entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as never;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(entry.parentPath, entry.name);
      const { frontmatter } = splitFrontmatter(readFileSync(path, 'utf8'));
      if (String(frontmatter?.id) === id) return path;
    }
  }
  throw new Error(`no note for ${id}`);
}

test('first render creates one note in Inbox with the expected schema', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    const summary = renderAll(db, config);
    assert.equal(summary.created, 1);

    const path = noteFile(vaultPath, '111');
    assert.equal(path, join(vaultPath, 'Inbox', '2026-03-14 - @janedoe - Reliability beats cleverness.md'));

    const { frontmatter, body } = splitFrontmatter(readFileSync(path, 'utf8'));
    assert.equal(frontmatter?.status, 'inbox');
    assert.deepEqual(frontmatter?.topics, []);
    assert.equal(frontmatter?.published, '2026-03-14');
    assert.equal(frontmatter?.handle, '@janedoe');
    assert.match(body, /Reliability beats cleverness/);
    assert.match(
      body,
      /· @janedoe · imported/,
      'single-post author stays plain text — no index note exists to link to',
    );
    assert.equal(body.includes('[[@janedoe]]'), false, 'no ghost wikilink');
  } finally {
    cleanup();
  }
});

test('re-rendering an untouched note is a no-op', () => {
  const { db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    renderAll(db, config);
    upsertPost(db, post(), {}, run); // mark dirty again, identical content
    const second = renderAll(db, config);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 1);
  } finally {
    cleanup();
  }
});

test('user edits to the body survive a re-sync, frontmatter still refreshes', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    renderAll(db, config);

    const path = noteFile(vaultPath, '111');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `${original}My own annotation.\n`, 'utf8');

    // The re-sync brings a new managed field (a quote) as well as new counts.
    upsertPost(
      db,
      post({
        likeCount: 999,
        refType: 'quoted',
        quotedId: '777',
        quotedHandle: '@source',
        quotedText: 'the thing being quoted',
        quotedCreatedAt: '2026-02-02T00:00:00.000Z',
      }),
      {},
      run,
    );
    const summary = renderAll(db, config);
    assert.equal(summary.bodyPreserved, 1);

    const content = readFileSync(path, 'utf8');
    assert.match(content, /My own annotation\./, 'annotation kept');
    const { frontmatter } = splitFrontmatter(content);
    assert.equal(frontmatter?.quoted, 'https://x.com/source/status/777', 'new property added');
    assert.equal(frontmatter?.kind, 'quote', 'derived kind refreshed');
  } finally {
    cleanup();
  }
});

test('triage state and topics are never overwritten by the importer', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    renderAll(db, config);

    const path = noteFile(vaultPath, '111');
    const content = readFileSync(path, 'utf8')
      .replace('status: inbox', 'status: kept')
      .replace('topics: []', 'topics: [reliability, engineering]');
    writeFileSync(path, content, 'utf8');

    upsertPost(db, post({ fullText: 'edited text' }), {}, run);
    renderAll(db, config);

    const { frontmatter } = splitFrontmatter(readFileSync(path, 'utf8'));
    assert.equal(frontmatter?.status, 'kept');
    assert.deepEqual(frontmatter?.topics, ['reliability', 'engineering']);
  } finally {
    cleanup();
  }
});

test('a moved or renamed note is found by id, never duplicated', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    renderAll(db, config);

    const path = noteFile(vaultPath, '111');
    const libraryDir = join(vaultPath, 'Library', '2026');
    mkdirSync(libraryDir, { recursive: true });
    const moved = join(libraryDir, 'Renamed by hand.md');
    renameSync(path, moved);

    upsertPost(db, post({ likeCount: 6 }), {}, run);
    renderAll(db, config);

    assert.equal(readdirSync(join(vaultPath, 'Inbox')).length, 0, 'no duplicate created in Inbox');
    assert.match(readFileSync(moved, 'utf8'), /Reliability beats cleverness/);
  } finally {
    cleanup();
  }
});

test('generated author indexes list the saved posts', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    upsertPost(
      db,
      post({ id: '222', url: 'https://x.com/janedoe/status/222', fullText: 'Second post', createdAt: '2026-04-01T00:00:00.000Z' }),
      {},
      run,
    );
    renderAll(db, config);

    const summary = buildAuthorNotes(config, qualifyingHandles(db, config.authorIndexMinPosts));
    assert.equal(summary.authors, 1);
    const moc = readFileSync(join(vaultPath, 'Authors', '@janedoe.md'), 'utf8');
    assert.match(moc, /# @janedoe/);
    assert.match(moc, /2 saved posts/);
    assert.match(moc, /Reliability beats cleverness/);
  } finally {
    cleanup();
  }
});

test('authors below the index threshold get no file and no wikilink', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    // One post from @janedoe, one from @other: neither reaches the default threshold of 2.
    upsertPost(db, post(), {}, run);
    upsertPost(
      db,
      post({ id: '333', url: 'https://x.com/other/status/333', handle: '@other', authorName: 'Other' }),
      {},
      run,
    );
    renderAll(db, config);

    const handles = qualifyingHandles(db, config.authorIndexMinPosts);
    assert.equal(handles.size, 0);

    const summary = buildAuthorNotes(config, handles);
    assert.equal(summary.notes, 0);
    const authorsDir = join(vaultPath, 'Authors');
    assert.equal(
      existsSync(authorsDir) ? readdirSync(authorsDir).length : 0,
      0,
      'no index files created',
    );

    const body = readFileSync(
      join(vaultPath, 'Inbox', '2026-03-14 - @janedoe - Reliability beats cleverness.md'),
      'utf8',
    );
    assert.equal(body.includes('[['), false, 'no wikilinks at all in the body');
  } finally {
    cleanup();
  }
});

test('an author gaining a second post earns a wikilink and an index', () => {
  const { vaultPath, db, config, cleanup } = setup();
  try {
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    renderAll(db, config);

    upsertPost(
      db,
      post({ id: '222', url: 'https://x.com/janedoe/status/222', fullText: 'Second post' }),
      {},
      run,
    );
    renderAll(db, config);

    const rendered = readdirSync(join(vaultPath, 'Inbox')).map((name) =>
      readFileSync(join(vaultPath, 'Inbox', name), 'utf8'),
    );
    assert.ok(
      rendered.some((content) => content.includes('[[@janedoe]]')),
      'the newly rendered note links to the author index',
    );

    const summary = buildAuthorNotes(config, qualifyingHandles(db, config.authorIndexMinPosts));
    assert.equal(summary.notes, 1);
  } finally {
    cleanup();
  }
});

test('base views and vault docs are valid and only written once', () => {
  const { vaultPath, config, cleanup } = setup();
  try {
    const bases = writeBases(config);
    assert.equal(bases.length, 4);
    for (const file of bases) {
      const content = readFileSync(join(vaultPath, 'Bases', file), 'utf8');
      assert.match(content, /views:/);
    }

    const docs = writeVaultDocs(config);
    assert.deepEqual(docs.created.sort(), ['00 Dashboard.md', 'AGENTS.md']);
    const second = writeVaultDocs(config);
    assert.equal(second.created.length, 0, 'existing docs are not clobbered');
    assert.equal(second.skipped.length, 2);
  } finally {
    cleanup();
  }
});
