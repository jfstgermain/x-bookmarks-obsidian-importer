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

test('a 402 is reported as a billing problem, not a config problem', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        detail: 'credits depleted',
        status: 402,
        title: 'Payment Required',
        type: 'https://api.x.com/2/problems/credits-depleted',
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const api = new XApi(credentials);
    await assert.rejects(
      () => api.get('/2/users/42/bookmarks', {}),
      (error: Error) => {
        assert.equal(error.name, 'CreditsDepletedError');
        assert.match(error.message, /console\.x\.com/);
        assert.match(error.message, /\$0\.001 per bookmarked post/);
        assert.match(error.message, /no post-paid billing/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('--since stops as soon as the watermark post appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-since-'));
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const runId = startRun(db);
    const api = new XApi(credentials);
    const result = await syncBookmarks(db, api, runId, {
      rawDir: join(root, 'raw'),
      userId: '42',
      since: '102',
      preferredProfile: 'legacy',
    });

    assert.equal(result.pages, 1, 'stopped on the page containing the watermark');
    assert.equal(result.sinceFound, true);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.complete, false, 'an incremental run never claims completeness');
    assert.equal(result.firstPostId, '101');
    assert.equal(
      state.calls.filter((c) => c.includes('bookmarks')).length,
      1,
      'a remembered field profile means one request, one page paid for',
    );
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--since on the final page still counts as a complete read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-since-last-'));
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const runId = startRun(db);
    const api = new XApi(credentials);
    const result = await syncBookmarks(db, api, runId, {
      rawDir: join(root, 'raw'),
      userId: '42',
      since: '103',
    });

    assert.equal(result.pages, 2);
    assert.equal(result.sinceFound, true);
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.complete, true, 'reaching the watermark on the last page read everything');
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a --since id that no longer exists falls back to a full read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-since-missing-'));
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const runId = startRun(db);
    const api = new XApi(credentials);
    const result = await syncBookmarks(db, api, runId, {
      rawDir: join(root, 'raw'),
      userId: '42',
      since: '999999',
    });

    assert.equal(result.pages, 2, 'kept going when the watermark was absent');
    assert.equal(result.sinceFound, false);
    assert.equal(result.complete, true);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the remembered field profile is used first, with fallback still intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xbm-profile-'));
  const db = openDb(join(root, 'db.sqlite'));
  const state = { calls: [] as string[] };
  const restore = installFetchMock(state);

  try {
    const api = new XApi(credentials);

    // First run: no memory, so it probes the modern names and falls back.
    const first = await syncBookmarks(db, api, startRun(db), {
      rawDir: join(root, 'raw'),
      userId: '42',
    });
    assert.equal(first.fieldProfile, 'legacy');
    const firstCalls = state.calls.length;
    assert.equal(firstCalls, 3, '2 pages + 1 rejected probe');

    // Second run with the remembered profile: no wasted probe.
    state.calls.length = 0;
    const second = await syncBookmarks(db, api, startRun(db), {
      rawDir: join(root, 'raw'),
      userId: '42',
      preferredProfile: first.fieldProfile,
    });
    assert.equal(second.fieldProfile, 'legacy');
    assert.equal(state.calls.length, 2, 'no probe, just the two pages');
    assert.equal(
      state.calls.some((call) => call.includes('post.fields')),
      false,
      'never asked for the modern names again',
    );
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
