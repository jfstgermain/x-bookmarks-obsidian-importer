import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, startRun } from '../src/db.ts';
import { FIELD_PROFILES, ingestPage, type BookmarksPage } from '../src/xapi.ts';

const modern = FIELD_PROFILES[0]!;
const legacy = FIELD_PROFILES[1]!;

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'xbm-api-'));
  return {
    db: openDb(join(dir, 'db.sqlite')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const modernPage: BookmarksPage = {
  data: [
    {
      id: '111',
      text: 'Short text',
      created_at: '2026-02-01T10:00:00.000Z',
      author_id: '42',
      username: 'janedoe',
      conversation_id: '111',
      referenced_posts: [{ id: '999', type: 'quoted' }],
      note_post: { text: 'The full long post text that goes past 280 characters.' },
      attachments: { media_keys: ['m1'] },
      public_metrics: { like_count: 10, retweet_count: 2, reply_count: 1, quote_count: 3 },
      lang: 'en',
    },
  ],
  includes: {
    users: [
      { id: '42', name: 'Jane Doe', username: 'janedoe', description: 'bio', profile_image_url: 'https://img/1.jpg', is_identity_verified: true },
      { id: '43', name: 'Other Person', username: 'other' },
    ],
    media: [
      { media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 800, height: 600, alt_text: 'a chart' },
    ],
    posts: [
      { id: '999', text: 'Quoted source text', author_id: '43', username: 'other', created_at: '2026-01-05T00:00:00.000Z' },
    ],
  },
  meta: { result_count: 1, next_token: 'next' },
};

test('modern field names are ingested correctly', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    const result = ingestPage(db, modernPage, modern, run);
    assert.equal(result.created, 1);

    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get('111') as Record<string, unknown>;
    assert.equal(row.handle, '@janedoe');
    assert.equal(row.author_name, 'Jane Doe');
    assert.equal(row.full_text, 'The full long post text that goes past 280 characters.', 'note_post wins over truncated text');
    assert.equal(row.kind ?? row.ref_type, 'quoted');
    assert.equal(row.quoted_id, '999');
    assert.equal(row.quoted_handle, '@other');
    assert.equal(row.quoted_text, 'Quoted source text');
    assert.equal(row.like_count, 10);
    assert.equal(row.media_count, 1);
    assert.equal(row.url, 'https://x.com/janedoe/status/111');

    const media = db.prepare('SELECT * FROM media').all() as Array<Record<string, unknown>>;
    assert.equal(media.length, 1);
    assert.equal(media[0]!.alt_text, 'a chart');
    assert.equal(media[0]!.url, 'https://pbs.twimg.com/media/a.jpg');

    const author = db.prepare('SELECT * FROM authors WHERE id = ?').get('42') as Record<string, unknown>;
    assert.equal(author.handle, 'janedoe');
    assert.equal(author.verified, 1);
  } finally {
    cleanup();
  }
});

test('legacy field names are ingested with the same result', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    const legacyPage: BookmarksPage = {
      data: [
        {
          id: '111',
          text: 'Short text',
          created_at: '2026-02-01T10:00:00.000Z',
          author_id: '42',
          conversation_id: '111',
          referenced_tweets: [{ id: '999', type: 'quoted' }],
          note_tweet: { text: 'The full long post text that goes past 280 characters.' },
          attachments: { media_keys: ['m1'] },
          public_metrics: { like_count: 10 },
          lang: 'en',
        },
      ],
      includes: {
        users: [{ id: '42', name: 'Jane Doe', username: 'janedoe' }],
        media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
        tweets: [{ id: '999', text: 'Quoted source text', author_id: '42', created_at: '2026-01-05T00:00:00.000Z' }],
      },
    };
    ingestPage(db, legacyPage, legacy, run);
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get('111') as Record<string, unknown>;
    assert.equal(row.full_text, 'The full long post text that goes past 280 characters.');
    assert.equal(row.quoted_id, '999');
    assert.equal(row.quoted_text, 'Quoted source text');
  } finally {
    cleanup();
  }
});

test('videos prefer the highest-bitrate mp4 for download and keep the poster', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    const page: BookmarksPage = {
      data: [{ id: '222', text: 'clip', author_id: '42', attachments: { media_keys: ['v1'] } }],
      includes: {
        users: [{ id: '42', name: 'J', username: 'j' }],
        media: [
          {
            media_key: 'v1',
            type: 'video',
            preview_image_url: 'https://pbs.twimg.com/poster.jpg',
            variants: [
              { content_type: 'video/mp4', url: 'https://video/low.mp4', bit_rate: 100 },
              { content_type: 'video/mp4', url: 'https://video/high.mp4', bit_rate: 2000 },
            ],
          },
        ],
      },
    };
    ingestPage(db, page, modern, run);
    const media = db.prepare('SELECT * FROM media WHERE post_id = ?').get('222') as Record<string, unknown>;
    assert.equal(media.url, 'https://video/high.mp4');
    assert.equal(media.preview_url, 'https://pbs.twimg.com/poster.jpg');
  } finally {
    cleanup();
  }
});

test('a retweet keeps its own id but records the original as the referenced post', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    const page: BookmarksPage = {
      data: [
        {
          id: '333',
          text: 'RT @orig: the real content',
          author_id: '42',
          conversation_id: '333',
          referenced_posts: [{ id: '444', type: 'retweeted' }],
        },
      ],
      includes: {
        users: [{ id: '42', name: 'Wrapper', username: 'wrapper' }],
        posts: [{ id: '444', text: 'the real content', author_id: '43', username: 'orig' }],
      },
    };
    ingestPage(db, page, modern, run);
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get('333') as Record<string, unknown>;
    assert.equal(row.ref_type, 'retweeted');
    assert.equal(row.quoted_id, '444');
    assert.equal(row.quoted_handle, '@orig');
    assert.equal(row.quoted_text, 'the real content');
  } finally {
    cleanup();
  }
});

test('missing author expansion falls back to the post username', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    ingestPage(db, { data: [{ id: '555', text: 'x', author_id: '77', username: 'fallback' }] }, modern, run);
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get('555') as Record<string, unknown>;
    assert.equal(row.handle, '@fallback');
  } finally {
    cleanup();
  }
});

test('an empty bookmark list is a no-op', () => {
  const { db, cleanup } = tempDb();
  try {
    const run = startRun(db);
    const result = ingestPage(db, { data: [], meta: { result_count: 0 } }, modern, run);
    assert.deepEqual(result, { seen: 0, created: 0, updated: 0 });
  } finally {
    cleanup();
  }
});
