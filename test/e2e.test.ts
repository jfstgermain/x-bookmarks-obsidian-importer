import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Config, type Credentials } from '../src/config.ts';
import { finishRun, openDb, startRun, stats } from '../src/db.ts';
import { splitFrontmatter } from '../src/frontmatter.ts';
import { renderAll } from '../src/render.ts';
import { syncBookmarks, XApi } from '../src/xapi.ts';

const credentials: Credentials = {
  clientId: 'test-client',
  redirectUri: 'http://localhost:8787/callback',
  accessToken: 'test-token',
  refreshToken: 'test-refresh',
  tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scope: 'bookmark.read tweet.read users.read offline.access',
  account: { userId: '42', username: 'janedoe', name: 'Jane Doe' },
  createdAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '100' },
  });
}

/**
 * Simulates the API surface we depend on, including the field-name rename:
 * `post.fields` is rejected with a field error so the client must fall back to
 * `tweet.fields`, exactly as older X apps behave.
 */
function installFetchMock(state: { calls: string[] }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    state.calls.push(url.pathname + url.search);

    if (url.pathname === '/2/users/42/bookmarks') {
      if (url.searchParams.has('post.fields')) {
        return jsonResponse(
          {
            errors: [
              {
                type: 'https://api.x.com/2/problems/invalid-request',
                parameter: 'post.fields',
                detail: 'The query parameter [post.fields] is not one of the allowed parameters',
              },
            ],
          },
          400,
        );
      }
      const page = url.searchParams.get('pagination_token');
      if (!page) {
        return jsonResponse({
          data: [
            {
              id: '101',
              text: 'First bookmark',
              created_at: '2026-01-01T00:00:00.000Z',
              author_id: '42',
              conversation_id: '101',
              attachments: { media_keys: ['m1'] },
              public_metrics: { like_count: 3 },
              lang: 'en',
            },
            {
              id: '102',
              text: 'Second bookmark',
              created_at: '2026-01-02T00:00:00.000Z',
              author_id: '42',
              conversation_id: '100',
              referenced_tweets: [{ id: '100', type: 'quoted' }],
              public_metrics: { like_count: 1 },
            },
          ],
          includes: {
            users: [{ id: '42', name: 'Jane Doe', username: 'janedoe' }],
            media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
            tweets: [{ id: '100', text: 'quoted body', author_id: '43' }],
          },
          meta: { result_count: 2, next_token: 'PAGE2' },
        });
      }
      return jsonResponse({
        data: [
          {
            id: '103',
            text: 'Third bookmark',
            created_at: '2026-01-03T00:00:00.000Z',
            author_id: '42',
            conversation_id: '103',
          },
        ],
        includes: { users: [{ id: '42', name: 'Jane Doe', username: 'janedoe' }] },
        meta: { result_count: 1 },
      });
    }

    return jsonResponse({ errors: [{ detail: `unexpected call ${url.pathname}` }] }, 404);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

async function syncOnce(db: ReturnType<typeof openDb>, dataPath: string) {
  const runId = startRun(db);
  const api = new XApi(credentials);
  const result = await syncBookmarks(db, api, runId, { rawDir: join(dataPath, 'raw'), userId: '42' });
  finishRun(db, runId, {
    pages: result.pages,
    postsSeen: result.postsSeen,
    postsNew: result.postsNew,
    complete: result.complete,
    fieldProfile: result.fieldProfile,
  });
  return result;
}

test('end-to-end: fallback, paginate, ingest, render, re-sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-e2e-'));
  const vaultPath = join(root, 'vault');
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  const config: Config = { ...DEFAULTS, vaultPath };
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const first = await syncOnce(db, root);

    assert.equal(first.pages, 2, 'followed the pagination token');
    assert.equal(first.postsSeen, 3);
    assert.equal(first.postsNew, 3);
    assert.equal(first.complete, true);
    assert.equal(first.fieldProfile, 'legacy', 'fell back after the field-name rejection');
    assert.ok(
      state.calls.some((call) => call.includes('tweet.fields')),
      'retried with legacy names',
    );
    assert.equal(state.calls.filter((call) => call.includes('bookmarks')).length, 3);

    const rawFiles = readdirSync(join(root, 'raw'));
    assert.equal(rawFiles.length, 2, 'every page is archived verbatim');

    const summary = renderAll(db, config);
    assert.equal(summary.created, 3);

    const inbox = readdirSync(join(vaultPath, 'Inbox'));
    assert.equal(inbox.length, 3);
    const quoted = inbox.find((name) => name.includes('Second bookmark'))!;
    const { frontmatter, body } = splitFrontmatter(
      readFileSync(join(vaultPath, 'Inbox', quoted), 'utf8'),
    );
    assert.equal(frontmatter?.kind, 'quote');
    assert.match(body, /\[!quote\] Quoted/);
    assert.match(body, /quoted body/);

    // A second sync sees the same posts: nothing new, notes refresh idempotently.
    const second = await syncOnce(db, root);
    assert.equal(second.postsNew, 0);
    const rerender = renderAll(db, config);
    assert.equal(rerender.created, 0);
    assert.equal(rerender.unchanged, 3);
    assert.equal(stats(db).posts, 3);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial run does not claim completeness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-e2e-partial-'));
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const runId = startRun(db);
    const api = new XApi(credentials);
    const result = await syncBookmarks(db, api, runId, {
      rawDir: join(root, 'raw'),
      userId: '42',
      maxPages: 1,
    });
    assert.equal(result.pages, 1);
    assert.equal(result.complete, false, 'stopping early is never reported as complete');
    assert.equal(result.stoppedEarly, true);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
