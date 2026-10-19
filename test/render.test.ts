import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dateFromPostId, normaliseHandle, titleFromText } from '../src/util.ts';
import type { RawPost } from '../src/db.ts';
import { buildNote } from '../src/render.ts';

function makePost(overrides: Partial<RawPost> = {}): RawPost {
  return {
    id: '1234567890',
    url: 'https://x.com/janedoe/status/1234567890',
    handle: '@janedoe',
    author_name: 'Jane Doe',
    full_text: 'How to build reliable agents',
    text: 'How to build reliable agents',
    created_at: '2026-03-14T10:22:31.000Z',
    lang: 'en',
    conversation_id: '1234567890',
    ref_type: null,
    quoted_id: null,
    quoted_handle: null,
    quoted_text: null,
    article_url: null,
    article_title: null,
    first_seen_at: '2026-10-18T12:00:00.000Z',
    note_path: null,
    body_hash: null,
    user_edited: 0,
    ...overrides,
  } as RawPost;
}

test('filename is date - handle - title', () => {
  const note = buildNote(makePost(), [], { addedDate: '2026-10-18' });
  assert.equal(note.filename, '2026-03-14 - @janedoe - How to build reliable agents');
});

test('filename strips URLs and unsafe characters', () => {
  const note = buildNote(
    makePost({ full_text: 'Look https://t.co/abc and a/b\\c:d "quoted" thing' }),
    [],
    { addedDate: '2026-10-18' },
  );
  assert.equal(note.filename.includes('t.co'), false);
  assert.equal(/[/\\:*?"<>|]/.test(note.filename), false);
});

test('frontmatter carries provenance and defaults', () => {
  const note = buildNote(makePost(), [], { addedDate: '2026-10-18' });
  assert.equal(note.frontmatter.id, '1234567890');
  assert.equal(note.frontmatter.published, '2026-03-14');
  assert.equal(note.frontmatter.added, '2026-10-18');
  assert.equal(note.frontmatter.kind, 'post');
  assert.equal(note.frontmatter.status, 'inbox');
  assert.deepEqual(note.frontmatter.topics, []);
  assert.equal('thread' in note.frontmatter, false, 'no thread link when post starts the thread');
});

test('replies get a thread link to the conversation root', () => {
  const note = buildNote(
    makePost({ id: '222', ref_type: 'replied_to', conversation_id: '111' }),
    [],
    { addedDate: '2026-10-18' },
  );
  assert.equal(note.frontmatter.thread, 'https://x.com/janedoe/status/111');
  assert.equal(note.frontmatter.kind, 'reply');
});

test('quoted posts render a callout', () => {
  const note = buildNote(
    makePost({
      ref_type: 'quoted',
      quoted_id: '999',
      quoted_handle: '@other',
      quoted_text: 'Original insight\nsecond line',
      quoted_created_at: '2026-01-02T00:00:00.000Z',
    }),
    [],
    { addedDate: '2026-10-18' },
  );
  assert.equal(note.frontmatter.kind, 'quote');
  assert.equal(note.frontmatter.quoted, 'https://x.com/other/status/999');
  assert.match(note.body, /> \[!quote\] Quoted · @other · 2026-01-02/);
  assert.match(note.body, /> Original insight\n> second line/);
});

test('retweets lead with the original content', () => {
  const note = buildNote(
    makePost({
      ref_type: 'retweeted',
      full_text: 'RT @other: the original point',
      quoted_id: '999',
      quoted_handle: '@other',
      quoted_text: 'the original point',
    }),
    [],
    { addedDate: '2026-10-18' },
  );
  assert.equal(note.frontmatter.kind, 'retweet');
  assert.match(note.body, /> \[!quote\] Retweeted from @other/);
  assert.match(note.body, /the original point/);
  assert.equal(note.body.includes('RT @other: the original point'), false);
});

test('downloaded media embeds as a wikilink, remote media as markdown', () => {
  const local = buildNote(makePost(), [
    { idx: 0, type: 'photo', local_file: '1234567890-1.jpg', url: null, preview_url: null, alt_text: 'a diagram' },
  ], { addedDate: '2026-10-18' });
  assert.match(local.body, /!\[\[1234567890-1\.jpg\|a diagram\]\]/);
  assert.deepEqual(local.frontmatter.media, ['photo']);

  const remote = buildNote(makePost(), [
    { idx: 0, type: 'photo', local_file: null, url: 'https://pbs.twimg.com/media/x.jpg', preview_url: null, alt_text: null },
  ], { addedDate: '2026-10-18' });
  assert.match(remote.body, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/x\.jpg\)/);
});

test('video without a download links to the X viewer', () => {
  const note = buildNote(makePost(), [
    { idx: 0, type: 'video', local_file: null, url: null, preview_url: 'https://pbs.twimg.com/poster.jpg', alt_text: null },
  ], { addedDate: '2026-10-18' });
  assert.match(note.body, /\[▶ Video\]\(https:\/\/x\.com\/janedoe\/status\/1234567890\/video\/1\)/);
});

test('article posts are labelled as articles', () => {
  const note = buildNote(
    makePost({ article_url: 'https://x.com/janedoe/status/1234567890', article_title: 'Long read' }),
    [],
    { addedDate: '2026-10-18' },
  );
  assert.equal(note.frontmatter.kind, 'article');
  assert.match(note.body, /\*\*Linked article:\*\* Long read/);
});

test('notes always end with a user-owned section', () => {
  const note = buildNote(makePost(), [], { addedDate: '2026-10-18' });
  assert.match(note.body, /## My notes\n\n$/);
});

test('handle normalisation', () => {
  assert.equal(normaliseHandle('janedoe'), '@janedoe');
  assert.equal(normaliseHandle('@@janedoe'), '@janedoe');
  assert.equal(normaliseHandle(undefined), 'unknown');
});

test('titles drop t.co links and leading mentions', () => {
  assert.equal(titleFromText('@someone: Real content here'), 'Real content here');
  assert.equal(titleFromText('Check this https://t.co/x'), 'Check this');
});

test('post id timestamps decode as a fallback', () => {
  const date = dateFromPostId('1234567890123456789');
  assert.ok(date instanceof Date);
  assert.ok(date!.getUTCFullYear() >= 2010 && date!.getUTCFullYear() <= 2030);
});
