import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  dirtyPosts,
  finishRun,
  openDb,
  startRun,
  stats,
  upsertPost,
  vanishedCount,
  type PostRow,
} from '../src/db.ts';

function tempDbFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'xbm-db-'));
  return {
    file: join(dir, 'bookmarks.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: '1',
    url: 'https://x.com/a/status/1',
    authorId: '9',
    authorName: 'A',
    handle: '@a',
    text: 'hello',
    noteText: null,
    fullText: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    lang: 'en',
    conversationId: '1',
    inReplyToUserId: null,
    refType: null,
    quotedId: null,
    quotedHandle: null,
    quotedName: null,
    quotedText: null,
    quotedCreatedAt: null,
    likeCount: 1,
    retweetCount: 0,
    replyCount: 0,
    quoteCount: 0,
    articleUrl: null,
    articleTitle: null,
    media: [],
    ...overrides,
  };
}

test('the same post is never inserted twice, and first_seen is preserved', () => {
  const { file, cleanup } = tempDbFile();
  try {
    const db = openDb(file);
    const run = startRun(db);
    const first = upsertPost(db, post(), { id: '1' }, run, '2026-10-01T00:00:00Z');
    assert.equal(first.isNew, true);

    const second = upsertPost(db, post({ text: 'hello again' }), { id: '1' }, run, '2026-10-02T00:00:00Z');
    assert.equal(second.isNew, false);

    const rows = db.prepare('SELECT * FROM posts').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, 'hello again', 'text refreshed');
    assert.equal(rows[0]!.first_seen_at, '2026-10-01T00:00:00Z', 'first import date kept');
    assert.equal(rows[0]!.last_seen_at, '2026-10-02T00:00:00Z');
  } finally {
    cleanup();
  }
});

test('re-syncing a post marks it dirty so the note gets refreshed', () => {
  const { file, cleanup } = tempDbFile();
  try {
    const db = openDb(file);
    const run = startRun(db);
    upsertPost(db, post(), {}, run);
    db.prepare('UPDATE posts SET dirty = 0').run();
    assert.equal(dirtyPosts(db).length, 0);
    upsertPost(db, post(), {}, run);
    assert.equal(dirtyPosts(db).length, 1, 'engagement counts / edits re-dirty the note');
  } finally {
    cleanup();
  }
});

test('media rows are replaced, keeping downloaded files intact', () => {
  const { file, cleanup } = tempDbFile();
  try {
    const db = openDb(file);
    const run = startRun(db);
    upsertPost(
      db,
      post({
        media: [
          { idx: 0, mediaKey: 'k0', type: 'photo', url: 'https://a/0.jpg', previewUrl: null, width: 1, height: 1, altText: null, durationMs: null },
          { idx: 1, mediaKey: 'k1', type: 'photo', url: 'https://a/1.jpg', previewUrl: null, width: 1, height: 1, altText: null, durationMs: null },
        ],
      }),
      {},
      run,
    );
    db.prepare("UPDATE media SET local_file = '1-1.jpg' WHERE idx = 0").run();

    // Second sync drops the trailing media item.
    upsertPost(
      db,
      post({
        media: [
          { idx: 0, mediaKey: 'k0', type: 'photo', url: 'https://a/0.jpg', previewUrl: null, width: 1, height: 1, altText: null, durationMs: null },
        ],
      }),
      {},
      run,
    );

    const rows = db.prepare('SELECT idx, local_file FROM media ORDER BY idx').all() as Array<{
      idx: number;
      local_file: string | null;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.local_file, '1-1.jpg', 'downloaded file reference survives');
  } finally {
    cleanup();
  }
});

test('vanished tracking only trusts complete scans', () => {
  const { file, cleanup } = tempDbFile();
  try {
    const db = openDb(file);
    const run1 = startRun(db);
    upsertPost(db, post({ id: '1', url: 'https://x.com/a/status/1' }), {}, run1);
    upsertPost(db, post({ id: '2', url: 'https://x.com/a/status/2' }), {}, run1);
    finishRun(db, run1, { pages: 1, postsSeen: 2, postsNew: 2, complete: false, fieldProfile: 'modern' });
    assert.equal(vanishedCount(db), 0, 'a partial scan proves nothing');

    const run2 = startRun(db);
    upsertPost(db, post({ id: '1', url: 'https://x.com/a/status/1' }), {}, run2);
    finishRun(db, run2, { pages: 1, postsSeen: 1, postsNew: 0, complete: true, fieldProfile: 'modern' });
    assert.equal(vanishedCount(db), 1, 'post 2 was not in the complete scan');
  } finally {
    cleanup();
  }
});

test('stats summarise the store', () => {
  const { file, cleanup } = tempDbFile();
  try {
    const db = openDb(file);
    const run = startRun(db);
    upsertPost(db, post({ id: '1', url: 'https://x.com/a/status/1' }), {}, run);
    finishRun(db, run, { pages: 1, postsSeen: 1, postsNew: 1, complete: true, fieldProfile: 'modern' });
    const summary = stats(db);
    assert.equal(summary.posts, 1);
    assert.equal(summary.withNotes, 0);
    assert.equal(summary.dirty, 1);
    assert.equal(summary.runs, 1);
    assert.equal(summary.lastSync?.posts_seen, 1);
  } finally {
    cleanup();
  }
});
