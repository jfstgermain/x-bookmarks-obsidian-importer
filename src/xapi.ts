import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getValidAccessToken,
  refreshAccessToken,
} from './auth.ts';
import type { Credentials } from './config.ts';
import { log } from './log.ts';
import {
  estimatedCostUsd,
  nowIso,
  type MediaRow,
  type PostRow,
  upsertAuthor,
  upsertPost,
} from './db.ts';
import { dateFromPostId, num, normaliseHandle, postUrl, sleep } from './util.ts';

const API = 'https://api.x.com';

/**
 * X is mid-rename from "tweets" to "posts" in its v2 parameter names. Newer apps
 * accept `post.fields` / `referenced_posts` / `note_post`; older ones only accept
 * `tweet.fields` / `referenced_tweets` / `note_tweet`. Rather than guess, we try the
 * modern profile first and fall back once, so this keeps working across the rename.
 */
export type FieldProfile = {
  name: string;
  postFieldsParam: string;
  postFields: string[];
  expansions: string[];
  userFields: string[];
  mediaFields: string[];
  noteKey: 'note_post' | 'note_tweet';
  refsKey: 'referenced_posts' | 'referenced_tweets';
};

export const FIELD_PROFILES: FieldProfile[] = [
  {
    name: 'modern',
    postFieldsParam: 'post.fields',
    postFields: [
      'id',
      'text',
      'created_at',
      'author_id',
      'username',
      'conversation_id',
      'in_reply_to_user_id',
      'referenced_posts',
      'note_post',
      'article',
      'article_title',
      'attachments',
      'entities',
      'public_metrics',
      'lang',
      'possibly_sensitive',
    ],
    expansions: ['author_id', 'attachments.media_keys', 'referenced_posts', 'username'],
    userFields: ['id', 'name', 'username', 'description', 'profile_image_url', 'is_identity_verified'],
    mediaFields: [
      'media_key',
      'type',
      'url',
      'preview_image_url',
      'width',
      'height',
      'alt_text',
      'duration_ms',
      'variants',
    ],
    noteKey: 'note_post',
    refsKey: 'referenced_posts',
  },
  {
    name: 'legacy',
    postFieldsParam: 'tweet.fields',
    postFields: [
      'id',
      'text',
      'created_at',
      'author_id',
      'conversation_id',
      'in_reply_to_user_id',
      'referenced_tweets',
      'note_tweet',
      'attachments',
      'entities',
      'public_metrics',
      'lang',
      'possibly_sensitive',
    ],
    expansions: [
      'author_id',
      'attachments.media_keys',
      'referenced_tweets.id',
      'referenced_tweets.id.author_id',
    ],
    userFields: ['id', 'name', 'username', 'description', 'profile_image_url', 'verified'],
    mediaFields: [
      'media_key',
      'type',
      'url',
      'preview_image_url',
      'width',
      'height',
      'alt_text',
      'duration_ms',
      'variants',
    ],
    noteKey: 'note_tweet',
    refsKey: 'referenced_tweets',
  },
];

/** Raised when the API rejects our field/expansion names, so we can try the next profile. */
export class FieldProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldProfileError';
  }
}

export class XApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = 'XApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 402 from X means the developer account has no credits left. It is a billing
 * problem, not a configuration problem, and the API's own message says nothing
 * useful about how to fix it.
 */
export class CreditsDepletedError extends Error {
  constructor() {
    super(
      [
        'X API credits depleted — the importer is configured correctly, it just cannot pay for reads.',
        '',
        '  Top up at:  https://console.x.com  →  Billing / Credits',
        '  Cost model: $0.001 per bookmarked post returned (~$1 per 1,000 posts)',
        '',
        'Credits are prepaid: a zero balance fails the first request, there is no post-paid billing.',
      ].join('\n'),
    );
    this.name = 'CreditsDepletedError';
  }
}

export type BookmarksPage = {
  data?: Array<Record<string, unknown>>;
  includes?: {
    users?: Array<Record<string, unknown>>;
    media?: Array<Record<string, unknown>>;
    posts?: Array<Record<string, unknown>>;
    tweets?: Array<Record<string, unknown>>;
  };
  meta?: { next_token?: string; result_count?: number };
  errors?: Array<Record<string, unknown>>;
};

export class XApi {
  #credentials: Credentials;
  #rateLimitedUntil = 0;
  requestCount = 0;

  constructor(credentials: Credentials) {
    this.#credentials = credentials;
  }

  async #token(forceRefresh = false): Promise<string> {
    if (forceRefresh) {
      this.#credentials = await refreshAccessToken(this.#credentials);
      return this.#credentials.accessToken;
    }
    const token = await getValidAccessToken(this.#credentials);
    this.#credentials = { ...this.#credentials, accessToken: token };
    return token;
  }

  /** Low-level GET with 429 handling, one 401 retry, and bounded 5xx retries. */
  async get(path: string, params: Record<string, string | undefined>): Promise<BookmarksPage> {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    let attempt = 0;
    let forceRefresh = false;

    for (;;) {
      attempt += 1;
      const wait = this.#rateLimitedUntil - Date.now();
      if (wait > 0) {
        log.debug(`Rate limited, waiting ${Math.ceil(wait / 1000)}s`);
        await sleep(wait);
      }

      const token = await this.#token(forceRefresh);
      forceRefresh = false;
      this.requestCount += 1;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'x-bookmarks-obsidian-importer/0.1',
        },
      });

      const remaining = response.headers.get('x-rate-limit-remaining');
      const reset = Number(response.headers.get('x-rate-limit-reset') ?? 0);
      if (remaining !== null) log.debug(`Rate limit remaining: ${remaining}`);

      if (response.status === 429) {
        const until = reset ? reset * 1000 + 2000 : Date.now() + 60_000;
        this.#rateLimitedUntil = until;
        if (attempt >= 4) {
          throw new XApiError(429, 'Rate limited by X after 4 attempts', '');
        }
        log.warn(`Rate limited by X; retrying in ${Math.max(1, Math.ceil((until - Date.now()) / 1000))}s`);
        continue;
      }

      if (response.status === 401 && attempt < 3) {
        log.debug('Access token rejected, forcing refresh');
        forceRefresh = true;
        continue;
      }

      const text = await response.text();

      if (response.status === 402) {
        throw new CreditsDepletedError();
      }

      if (response.status === 400) {
        const lower = text.toLowerCase();
        const fieldish =
          lower.includes('field') ||
          lower.includes('expansion') ||
          lower.includes('parameter') ||
          lower.includes('query');
        if (fieldish) throw new FieldProfileError(text);
        throw new XApiError(400, `Bad request: ${text.slice(0, 400)}`, text);
      }

      if (response.status >= 500 && attempt < 4) {
        const backoff = 1000 * 2 ** (attempt - 1);
        log.warn(`X API ${response.status}, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      if (!response.ok) {
        throw new XApiError(
          response.status,
          `GET ${url.pathname} failed (${response.status}): ${text.slice(0, 400)}`,
          text,
        );
      }

      return JSON.parse(text) as BookmarksPage;
    }
  }

  async me(): Promise<{ id: string; username: string; name: string }> {
    const payload = (await this.get('/2/users/me', {
      'user.fields': 'username,name',
    })) as unknown as { data?: { id: string; username: string; name: string } };
    if (!payload.data?.id) throw new Error('Could not read /2/users/me');
    return payload.data;
  }

  async bookmarks(
    userId: string,
    profile: FieldProfile,
    options: { maxResults?: number; paginationToken?: string } = {},
  ): Promise<BookmarksPage> {
    return this.get(`/2/users/${userId}/bookmarks`, {
      max_results: String(options.maxResults ?? 100),
      pagination_token: options.paginationToken,
      [profile.postFieldsParam]: profile.postFields.join(','),
      expansions: profile.expansions.join(','),
      'user.fields': profile.userFields.join(','),
      'media.fields': profile.mediaFields.join(','),
    });
  }
}

function bestMp4(media: Record<string, unknown>): string | null {
  const variants = media.variants;
  if (!Array.isArray(variants)) return null;
  const mp4s = variants
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .filter((v) => String(v.content_type ?? '') === 'video/mp4' && typeof v.url === 'string')
    .sort((a, b) => num(b.bit_rate) - num(a.bit_rate));
  return (mp4s[0]?.url as string | undefined) ?? null;
}

export type IngestResult = { seen: number; created: number; updated: number };

/** Normalise one API page into rows and persist it. */
export function ingestPage(
  db: DatabaseSync,
  page: BookmarksPage,
  profile: FieldProfile,
  runId: number,
): IngestResult {
  const users = new Map<string, Record<string, unknown>>();
  for (const user of page.includes?.users ?? []) {
    users.set(String(user.id), user);
    upsertAuthor(db, {
      id: String(user.id),
      name: user.name ? String(user.name) : null,
      handle: user.username ? String(user.username) : null,
      description: user.description ? String(user.description) : null,
      profileImageUrl: user.profile_image_url ? String(user.profile_image_url) : null,
      verified: Boolean(user.verified ?? user.is_identity_verified),
    });
  }

  const mediaByKey = new Map<string, Record<string, unknown>>();
  for (const media of page.includes?.media ?? []) {
    mediaByKey.set(String(media.media_key), media);
  }

  const referenced = new Map<string, Record<string, unknown>>();
  for (const post of [...(page.includes?.posts ?? []), ...(page.includes?.tweets ?? [])]) {
    referenced.set(String(post.id), post);
  }

  const result: IngestResult = { seen: 0, created: 0, updated: 0 };

  for (const post of page.data ?? []) {
    const id = String(post.id ?? '');
    if (!id) continue;

    const authorId = post.author_id ? String(post.author_id) : null;
    const author = authorId ? users.get(authorId) : undefined;
    const handle = normaliseHandle(
      (author?.username as string | undefined) ?? (post.username as string | undefined),
    );
    const authorName = (author?.name as string | undefined) ?? handle;

    const noteText = (post[profile.noteKey] as { text?: string } | undefined)?.text ?? null;
    const text = post.text ? String(post.text) : null;

    const refs = Array.isArray(post[profile.refsKey])
      ? (post[profile.refsKey] as Array<Record<string, unknown>>)
      : [];
    const quote = refs.find((r) => r.type === 'quoted');
    const retweet = refs.find((r) => r.type === 'retweeted');
    const reply = refs.find((r) => r.type === 'replied_to');
    const primary = quote ?? retweet;
    const primaryRef = primary ? referenced.get(String(primary.id)) : undefined;

    const quotedHandleRaw = primaryRef?.username as string | undefined;
    const quotedAuthorId = primaryRef?.author_id ? String(primaryRef.author_id) : undefined;
    const quotedAuthor = quotedAuthorId ? users.get(quotedAuthorId) : undefined;
    const quotedHandle = quotedHandleRaw
      ? normaliseHandle(quotedHandleRaw)
      : quotedAuthor?.username
        ? normaliseHandle(String(quotedAuthor.username))
        : null;

    const attachments = post.attachments as { media_keys?: string[] } | undefined;
    const mediaKeys = Array.isArray(attachments?.media_keys) ? attachments.media_keys : [];
    const media: MediaRow[] = mediaKeys.map((key, idx) => {
      const found = mediaByKey.get(String(key)) ?? {};
      const type = found.type ? String(found.type) : null;
      const isVideo = type === 'video' || type === 'animated_gif';
      return {
        idx,
        mediaKey: String(key),
        type,
        // Photos expose `url`; video and GIFs only have a poster frame.
        url: isVideo ? bestMp4(found) : found.url ? String(found.url) : null,
        previewUrl: found.preview_image_url ? String(found.preview_image_url) : null,
        width: found.width ? num(found.width) : null,
        height: found.height ? num(found.height) : null,
        altText: found.alt_text ? String(found.alt_text) : null,
        durationMs: found.duration_ms ? num(found.duration_ms) : null,
      };
    });

    const metrics = (post.public_metrics ?? {}) as Record<string, unknown>;
    const article = post.article as Record<string, unknown> | undefined;
    const createdAt =
      (post.created_at as string | undefined) ?? dateFromPostId(id)?.toISOString() ?? null;

    const row: PostRow = {
      id,
      url: postUrl(handle, id),
      authorId,
      authorName,
      handle,
      text,
      noteText,
      fullText: noteText ?? text,
      createdAt,
      lang: post.lang ? String(post.lang) : null,
      conversationId: post.conversation_id ? String(post.conversation_id) : null,
      inReplyToUserId: post.in_reply_to_user_id ? String(post.in_reply_to_user_id) : null,
      refType: quote ? 'quoted' : retweet ? 'retweeted' : reply ? 'replied_to' : null,
      quotedId: primary ? String(primary.id) : null,
      quotedHandle,
      quotedName: quotedAuthor?.name ? String(quotedAuthor.name) : null,
      quotedText: primaryRef?.text ? String(primaryRef.text) : null,
      quotedCreatedAt: primaryRef?.created_at ? String(primaryRef.created_at) : null,
      likeCount: num(metrics.like_count),
      retweetCount: num(metrics.retweet_count),
      replyCount: num(metrics.reply_count),
      quoteCount: num(metrics.quote_count),
      articleUrl: article?.url ? String(article.url) : null,
      articleTitle: article?.title
        ? String(article.title)
        : post.article_title
          ? String(post.article_title)
          : null,
      media,
    };

    const { isNew } = upsertPost(db, row, post, runId);
    result.seen += 1;
    if (isNew) result.created += 1;
    else result.updated += 1;
  }

  return result;
}

export function saveRawPage(rawDir: string, runId: number, pageNumber: number, page: unknown): string {
  mkdirSync(rawDir, { recursive: true });
  const file = join(rawDir, `${String(runId).padStart(4, '0')}-page-${String(pageNumber).padStart(3, '0')}.json`);
  writeFileSync(file, `${JSON.stringify(page, null, 2)}\n`, 'utf8');
  return file;
}

export type SyncOptions = {
  rawDir: string;
  userId: string;
  maxResults?: number;
  maxPages?: number;
  limit?: number;
  /**
   * Stop paginating once this post id shows up in a page. Because the bookmark list is
   * ordered newest-bookmarked-first, everything below a known post is already imported,
   * so this turns a full re-read of the list into a one-page top-up.
   */
  since?: string;
  /**
   * Profile name that worked last time. Probing the modern field names on every run costs an
   * extra round-trip (the API rejects them with a 400), so we remember the winner and start there.
   */
  preferredProfile?: string;
  onPage?: (info: { page: number; seen: number; total: number }) => void;
};

export type SyncResult = {
  pages: number;
  postsSeen: number;
  postsNew: number;
  complete: boolean;
  fieldProfile: string;
  costUsd: number;
  stoppedEarly: boolean;
  /** True when the `--since` post was actually encountered before stopping. */
  sinceFound: boolean;
  /** Topmost post id of this run, used as the next run's cheap watermark. */
  firstPostId: string | null;
};

/**
 * Walk the bookmark list from newest to oldest.
 * `complete` is true only when we reached the end of the list — which is what makes
 * "this bookmark disappeared" claims trustworthy later.
 */
export async function syncBookmarks(
  db: DatabaseSync,
  api: XApi,
  runId: number,
  options: SyncOptions,
): Promise<SyncResult> {
  // Try the remembered profile first, then everything else as a fallback chain.
  const profileOrder: number[] = [];
  const preferredIndex = FIELD_PROFILES.findIndex((p) => p.name === options.preferredProfile);
  if (preferredIndex >= 0) profileOrder.push(preferredIndex);
  for (let i = 0; i < FIELD_PROFILES.length; i += 1) {
    if (!profileOrder.includes(i)) profileOrder.push(i);
  }

  let attempt = 0;
  let paginationToken: string | undefined;
  let pages = 0;
  let postsSeen = 0;
  let postsNew = 0;
  let stoppedEarly = false;
  let complete = false;
  let sinceFound = false;
  let firstPostId: string | null = null;

  for (;;) {
    if (options.maxPages && pages >= options.maxPages) {
      stoppedEarly = true;
      break;
    }

    let page: BookmarksPage;
    try {
      page = await api.bookmarks(options.userId, FIELD_PROFILES[profileOrder[attempt]!]!, {
        maxResults: options.maxResults ?? 100,
        paginationToken,
      });
    } catch (error) {
      if (error instanceof FieldProfileError && attempt + 1 < profileOrder.length) {
        const rejected = FIELD_PROFILES[profileOrder[attempt]!]!;
        attempt += 1;
        const next = FIELD_PROFILES[profileOrder[attempt]!]!;
        log.warn(`${rejected.name} field names rejected by the API; retrying with ${next.name} names`);
        continue;
      }
      throw error;
    }

    const profile = FIELD_PROFILES[profileOrder[attempt]!]!;
    pages += 1;
    saveRawPage(options.rawDir, runId, pages, page);

    const ingested = ingestPage(db, page, profile, runId);
    postsSeen += ingested.seen;
    postsNew += ingested.created;
    options.onPage?.({ page: pages, seen: postsSeen, total: postsSeen });

    if (firstPostId === null && page.data && page.data.length > 0) {
      firstPostId = String(page.data[0]!.id ?? '') || null;
    }

    if (options.limit && postsSeen >= options.limit) {
      stoppedEarly = true;
      break;
    }

    const hasNextPage = Boolean(page.meta?.next_token);

    if (options.since && (page.data ?? []).some((post) => String(post.id) === options.since)) {
      sinceFound = true;
      // Reaching the watermark on the final page means we did in fact read everything.
      if (hasNextPage) stoppedEarly = true;
      else complete = true;
      break;
    }

    paginationToken = page.meta?.next_token;
    if (!paginationToken) {
      complete = true;
      break;
    }
  }

  return {
    pages,
    postsSeen,
    postsNew,
    complete,
    fieldProfile: FIELD_PROFILES[profileOrder[attempt]!]!.name,
    costUsd: estimatedCostUsd(postsSeen),
    stoppedEarly,
    sinceFound,
    firstPostId,
  };
}

export function describeCost(resources: number): string {
  return `$${estimatedCostUsd(resources).toFixed(4)}`;
}

export { nowIso };
