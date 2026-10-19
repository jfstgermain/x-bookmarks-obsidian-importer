import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { num } from './util.ts';

export type MediaRow = {
  idx: number;
  mediaKey: string | null;
  type: string | null;
  url: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  durationMs: number | null;
};

export type PostRow = {
  id: string;
  url: string;
  authorId: string | null;
  authorName: string | null;
  handle: string | null;
  text: string | null;
  noteText: string | null;
  fullText: string | null;
  createdAt: string | null;
  lang: string | null;
  conversationId: string | null;
  inReplyToUserId: string | null;
  refType: string | null;
  quotedId: string | null;
  quotedHandle: string | null;
  quotedName: string | null;
  quotedText: string | null;
  quotedCreatedAt: string | null;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  articleUrl: string | null;
  articleTitle: string | null;
  media: MediaRow[];
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS authors (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  handle            TEXT,
  description       TEXT,
  profile_image_url TEXT,
  verified          INTEGER DEFAULT 0,
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  url               TEXT NOT NULL,
  author_id         TEXT,
  author_name       TEXT,
  handle            TEXT,
  text              TEXT,
  note_text         TEXT,
  full_text         TEXT,
  created_at        TEXT,
  lang              TEXT,
  conversation_id   TEXT,
  in_reply_to_user_id TEXT,
  ref_type          TEXT,
  quoted_id         TEXT,
  quoted_handle     TEXT,
  quoted_name       TEXT,
  quoted_text       TEXT,
  quoted_created_at TEXT,
  like_count        INTEGER DEFAULT 0,
  retweet_count     INTEGER DEFAULT 0,
  reply_count       INTEGER DEFAULT 0,
  quote_count       INTEGER DEFAULT 0,
  article_url       TEXT,
  article_title     TEXT,
  media_count       INTEGER DEFAULT 0,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  last_seen_run     INTEGER,
  raw_json          TEXT,
  note_path         TEXT,
  body_hash         TEXT,
  user_edited       INTEGER DEFAULT 0,
  dirty             INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_posts_dirty ON posts (dirty);
CREATE INDEX IF NOT EXISTS idx_posts_handle ON posts (handle);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at);

CREATE TABLE IF NOT EXISTS media (
  post_id      TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  media_key    TEXT,
  type         TEXT,
  url          TEXT,
  preview_url  TEXT,
  width        INTEGER,
  height       INTEGER,
  alt_text     TEXT,
  duration_ms  INTEGER,
  local_file   TEXT,
  downloaded_at TEXT,
  PRIMARY KEY (post_id, idx),
  FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  pages         INTEGER DEFAULT 0,
  posts_seen    INTEGER DEFAULT 0,
  posts_new     INTEGER DEFAULT 0,
  complete      INTEGER DEFAULT 0,
  field_profile TEXT,
  error         TEXT
);
`;

export function openDb(file: string): DatabaseSync {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function upsertAuthor(
  db: DatabaseSync,
  author: {
    id: string;
    name?: string | null;
    handle?: string | null;
    description?: string | null;
    profileImageUrl?: string | null;
    verified?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO authors (id, name, handle, description, profile_image_url, verified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name              = COALESCE(excluded.name, authors.name),
       handle            = COALESCE(excluded.handle, authors.handle),
       description       = COALESCE(excluded.description, authors.description),
       profile_image_url = COALESCE(excluded.profile_image_url, authors.profile_image_url),
       verified          = MAX(excluded.verified, authors.verified),
       updated_at        = excluded.updated_at`,
  ).run(
    author.id,
    author.name ?? null,
    author.handle ?? null,
    author.description ?? null,
    author.profileImageUrl ?? null,
    author.verified ? 1 : 0,
    nowIso(),
  );
}

const POST_UPSERT = `
INSERT INTO posts (
  id, url, author_id, author_name, handle, text, note_text, full_text, created_at, lang,
  conversation_id, in_reply_to_user_id, ref_type, quoted_id, quoted_handle, quoted_name,
  quoted_text, quoted_created_at, like_count, retweet_count, reply_count, quote_count,
  article_url, article_title, media_count, first_seen_at, last_seen_at, last_seen_run,
  raw_json, dirty
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, 1
)
ON CONFLICT (id) DO UPDATE SET
  url               = excluded.url,
  author_id         = COALESCE(excluded.author_id, posts.author_id),
  author_name       = COALESCE(excluded.author_name, posts.author_name),
  handle            = COALESCE(excluded.handle, posts.handle),
  text              = COALESCE(excluded.text, posts.text),
  note_text         = COALESCE(excluded.note_text, posts.note_text),
  full_text         = COALESCE(excluded.full_text, posts.full_text),
  created_at        = COALESCE(excluded.created_at, posts.created_at),
  lang              = COALESCE(excluded.lang, posts.lang),
  conversation_id   = COALESCE(excluded.conversation_id, posts.conversation_id),
  in_reply_to_user_id = COALESCE(excluded.in_reply_to_user_id, posts.in_reply_to_user_id),
  ref_type          = COALESCE(excluded.ref_type, posts.ref_type),
  quoted_id         = COALESCE(excluded.quoted_id, posts.quoted_id),
  quoted_handle     = COALESCE(excluded.quoted_handle, posts.quoted_handle),
  quoted_name       = COALESCE(excluded.quoted_name, posts.quoted_name),
  quoted_text       = COALESCE(excluded.quoted_text, posts.quoted_text),
  quoted_created_at = COALESCE(excluded.quoted_created_at, posts.quoted_created_at),
  like_count        = excluded.like_count,
  retweet_count     = excluded.retweet_count,
  reply_count       = excluded.reply_count,
  quote_count       = excluded.quote_count,
  article_url       = COALESCE(excluded.article_url, posts.article_url),
  article_title     = COALESCE(excluded.article_title, posts.article_title),
  media_count       = excluded.media_count,
  last_seen_at      = excluded.last_seen_at,
  last_seen_run     = excluded.last_seen_run,
  raw_json          = excluded.raw_json,
  dirty             = 1`;

/** Insert or refresh a post. Returns true when the post is new to the database. */
export function upsertPost(
  db: DatabaseSync,
  post: PostRow,
  raw: unknown,
  runId: number,
  now = nowIso(),
): { isNew: boolean } {
  const existed = db.prepare('SELECT 1 AS one FROM posts WHERE id = ?').get(post.id);
  const isNew = !existed;

  // first_seen_at is intentionally absent from the ON CONFLICT update list, so a re-sync
  // never rewrites the moment we first imported the bookmark.
  db.prepare(POST_UPSERT).run(
    post.id,
    post.url,
    post.authorId,
    post.authorName,
    post.handle,
    post.text,
    post.noteText,
    post.fullText,
    post.createdAt,
    post.lang,
    post.conversationId,
    post.inReplyToUserId,
    post.refType,
    post.quotedId,
    post.quotedHandle,
    post.quotedName,
    post.quotedText,
    post.quotedCreatedAt,
    post.likeCount,
    post.retweetCount,
    post.replyCount,
    post.quoteCount,
    post.articleUrl,
    post.articleTitle,
    post.media.length,
    now,
    now,
    runId,
    JSON.stringify(raw),
  );

  replaceMedia(db, post.id, post.media);
  return { isNew };
}

export function replaceMedia(db: DatabaseSync, postId: string, media: MediaRow[]): void {
  const keep = new Set(media.map((m) => m.idx));
  const existing = db
    .prepare('SELECT idx, local_file FROM media WHERE post_id = ?')
    .all(postId) as Array<{ idx: number; local_file: string | null }>;

  // Remove rows for media that no longer exists, but only when nothing was downloaded
  // for them — otherwise we would orphan files on disk.
  for (const row of existing) {
    if (!keep.has(row.idx) && !row.local_file) {
      db.prepare('DELETE FROM media WHERE post_id = ? AND idx = ?').run(postId, row.idx);
    }
  }

  const stmt = db.prepare(
    `INSERT INTO media (post_id, idx, media_key, type, url, preview_url, width, height, alt_text, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (post_id, idx) DO UPDATE SET
       media_key   = excluded.media_key,
       type        = excluded.type,
       url         = COALESCE(excluded.url, media.url),
       preview_url = COALESCE(excluded.preview_url, media.preview_url),
       width       = COALESCE(excluded.width, media.width),
       height      = COALESCE(excluded.height, media.height),
       alt_text    = COALESCE(excluded.alt_text, media.alt_text),
       duration_ms = COALESCE(excluded.duration_ms, media.duration_ms)`,
  );
  for (const m of media) {
    stmt.run(
      postId,
      m.idx,
      m.mediaKey,
      m.type,
      m.url,
      m.previewUrl,
      m.width,
      m.height,
      m.altText,
      m.durationMs,
    );
  }
}

export function recordMediaFile(
  db: DatabaseSync,
  postId: string,
  idx: number,
  localFile: string | null,
): void {
  db.prepare('UPDATE media SET local_file = ?, downloaded_at = ? WHERE post_id = ? AND idx = ?').run(
    localFile,
    localFile ? nowIso() : null,
    postId,
    idx,
  );
}

export function startRun(db: DatabaseSync): number {
  const info = db
    .prepare('INSERT INTO sync_runs (started_at) VALUES (?)')
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  stats: {
    pages: number;
    postsSeen: number;
    postsNew: number;
    complete: boolean;
    fieldProfile: string | null;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE sync_runs
        SET finished_at = ?, pages = ?, posts_seen = ?, posts_new = ?, complete = ?,
            field_profile = ?, error = ?
      WHERE id = ?`,
  ).run(
    nowIso(),
    stats.pages,
    stats.postsSeen,
    stats.postsNew,
    stats.complete ? 1 : 0,
    stats.fieldProfile,
    stats.error ?? null,
    runId,
  );
}

export function dirtyPosts(db: DatabaseSync, limit?: number): RawPost[] {
  const sql = `SELECT * FROM posts WHERE dirty = 1 ORDER BY created_at ASC, id ASC${
    limit ? ' LIMIT ?' : ''
  }`;
  const stmt = db.prepare(sql);
  const rows = (limit ? stmt.all(limit) : stmt.all()) as RawPost[];
  return rows;
}

export type RawPost = Record<string, unknown> & {
  id: string;
  note_path: string | null;
  body_hash: string | null;
  user_edited: number;
};

export function markRendered(
  db: DatabaseSync,
  postId: string,
  notePath: string,
  bodyHash: string,
  userEdited: boolean,
): void {
  db.prepare(
    'UPDATE posts SET note_path = ?, body_hash = ?, user_edited = ?, dirty = 0 WHERE id = ?',
  ).run(notePath, bodyHash, userEdited ? 1 : 0, postId);
}

export function markMediaUnavailable(db: DatabaseSync, postId: string, idx: number): void {
  db.prepare('UPDATE media SET local_file = NULL WHERE post_id = ? AND idx = ?').run(postId, idx);
}

export function mediaForPost(db: DatabaseSync, postId: string): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM media WHERE post_id = ? ORDER BY idx ASC')
    .all(postId) as Array<Record<string, unknown>>;
}

export type Stats = {
  posts: number;
  authors: number;
  withNotes: number;
  dirty: number;
  mediaFiles: number;
  firstSeen: string | null;
  lastSync: { started_at: string; posts_seen: number; posts_new: number; complete: number } | null;
  runs: number;
};

export function stats(db: DatabaseSync): Stats {
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n ?? 0);
  const lastSync = db
    .prepare(
      `SELECT started_at, posts_seen, posts_new, complete
         FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as Stats['lastSync'];

  return {
    posts: one('SELECT COUNT(*) AS n FROM posts'),
    authors: one('SELECT COUNT(*) AS n FROM authors'),
    withNotes: one('SELECT COUNT(*) AS n FROM posts WHERE note_path IS NOT NULL'),
    dirty: one('SELECT COUNT(*) AS n FROM posts WHERE dirty = 1'),
    mediaFiles: one('SELECT COUNT(*) AS n FROM media WHERE local_file IS NOT NULL'),
    firstSeen: (db.prepare('SELECT MIN(first_seen_at) AS d FROM posts').get() as { d: string | null })
      .d,
    lastSync: lastSync ?? null,
    runs: one('SELECT COUNT(*) AS n FROM sync_runs'),
  };
}

/** Posts that have disappeared from the bookmark list since the last complete scan. */
export function vanishedCount(db: DatabaseSync): number {
  const lastComplete = db
    .prepare('SELECT MAX(id) AS id FROM sync_runs WHERE complete = 1')
    .get() as { id: number | null };
  if (!lastComplete.id) return 0;
  return Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM posts WHERE last_seen_run < ?')
        .get(lastComplete.id) as { n: number }
    ).n ?? 0,
  );
}

export function estimatedCostUsd(resources: number): number {
  // X API pay-per-use: Owned Reads (your own bookmarks) are $0.001 per resource returned.
  return num(resources) * 0.001;
}
