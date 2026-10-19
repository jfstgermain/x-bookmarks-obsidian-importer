import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { dirtyPosts, mediaForPost, markRendered, type RawPost } from './db.ts';
import {
  composeNote,
  mergeFrontmatter,
  splitFrontmatter,
  type Frontmatter,
} from './frontmatter.ts';
import { log } from './log.ts';
import {
  normaliseHandle,
  postUrl,
  sanitizeFilename,
  sha256hex,
  titleFromText,
} from './util.ts';
import { writeFileAtomic } from './vault-io.ts';

const sanitiseTitle = (name: string): string => sanitizeFilename(name, 140);

export const MANAGED_KEYS = [
  'id',
  'url',
  'handle',
  'author',
  'published',
  'added',
  'lang',
  'kind',
  'thread',
  'quoted',
  'article',
  'media',
];

/** Seeded once on creation, then owned by the user. */
export const CREATE_ONLY_KEYS = ['status', 'topics', 'summary'];

export type MediaFile = {
  idx: number;
  type: string | null;
  local_file: string | null;
  url: string | null;
  preview_url: string | null;
  alt_text: string | null;
};

export type BuiltNote = { filename: string; frontmatter: Frontmatter; body: string };

function day(value: unknown): string {
  const text = String(value ?? '');
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function callout(title: string, text: string, footer?: string): string {
  const lines = text
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  const tail = footer ? `\n>\n> ${footer}` : '';
  return `> [!quote] ${title}\n${lines}${tail}`;
}

function mediaBlock(post: RawPost, media: MediaFile[]): string {
  if (media.length === 0) return '';
  const parts: string[] = [];
  const postId = String(post.id);

  for (const item of media) {
    const alt = item.alt_text ? item.alt_text.replace(/[[\]|]/g, ' ') : '';
    const isVideo = item.type === 'video' || item.type === 'animated_gif';

    if (item.local_file) {
      parts.push(alt ? `![[${item.local_file}|${alt}]]` : `![[${item.local_file}]]`);
      continue;
    }
    if (isVideo) {
      const viewer = `${String(post.url)}/video/${item.idx + 1}`;
      const poster = item.preview_url ? `\n\n[![](${item.preview_url})](${viewer})` : '';
      parts.push(`[▶ Video](${viewer})${poster}`);
      continue;
    }
    const src = item.url ?? item.preview_url;
    if (src) parts.push(alt ? `![${alt}](${src})` : `![](${src})`);
  }

  return parts.join('\n\n');
}

export function buildNote(post: RawPost, media: MediaFile[], options: { addedDate: string }): BuiltNote {
  const id = String(post.id);
  const handle = normaliseHandle((post.handle as string | undefined) ?? undefined);
  const author = (post.author_name as string | undefined) ?? handle;
  const publishedRaw = post.created_at ? String(post.created_at) : '';
  const published = day(publishedRaw);
  const url = String(post.url);
  const fullText = String(post.full_text ?? post.text ?? '');
  const refType = (post.ref_type as string | null) ?? null;
  const quotedId = post.quoted_id ? String(post.quoted_id) : null;
  const quotedHandle = post.quoted_handle ? normaliseHandle(String(post.quoted_handle)) : null;
  const quotedUrl = quotedId ? postUrl(quotedHandle ?? 'i', quotedId) : null;
  const conversationId = post.conversation_id ? String(post.conversation_id) : null;
  const threadUrl =
    conversationId && conversationId !== id ? postUrl(handle, conversationId) : null;
  const articleUrl = post.article_url ? String(post.article_url) : null;
  const articleTitle = post.article_title ? String(post.article_title) : null;

  const kind = articleUrl
    ? 'article'
    : refType === 'retweeted'
      ? 'retweet'
      : refType === 'quoted'
        ? 'quote'
        : refType === 'replied_to'
          ? 'reply'
          : 'post';

  const frontmatter: Frontmatter = {
    id,
    url,
    handle,
    author,
    published,
    added: options.addedDate,
    kind,
  };
  // Only emit optional keys when they carry a value, so notes stay clean and
  // `'thread' in frontmatter` reliably means "this post is part of a thread".
  if (post.lang) frontmatter.lang = String(post.lang);
  if (threadUrl) frontmatter.thread = threadUrl;
  if (quotedUrl) frontmatter.quoted = quotedUrl;
  if (articleUrl) frontmatter.article = articleUrl;
  if (media.length > 0) frontmatter.media = media.map((m) => m.type ?? 'media');
  frontmatter.status = 'inbox';
  frontmatter.topics = [];

  const sections: string[] = [];

  if (kind === 'retweet' && post.quoted_text) {
    // A retweet's own text is usually just "RT @someone: …"; the original is the content.
    sections.push(
      callout(
        `Retweeted from ${quotedHandle ?? 'unknown'}${post.quoted_created_at ? ` · ${day(post.quoted_created_at)}` : ''}`,
        String(post.quoted_text),
        quotedUrl ? `[Open original](${quotedUrl})` : undefined,
      ),
    );
    if (fullText && !fullText.startsWith('RT @')) sections.push(fullText);
  } else {
    sections.push(fullText);
    if (kind === 'quote' && post.quoted_text) {
      sections.push(
        callout(
          `Quoted · ${quotedHandle ?? 'unknown'}${post.quoted_created_at ? ` · ${day(post.quoted_created_at)}` : ''}`,
          String(post.quoted_text),
          quotedUrl ? `[Open quoted post](${quotedUrl})` : undefined,
        ),
      );
    }
  }

  const mediaText = mediaBlock(post, media);
  if (mediaText) sections.push(mediaText);

  if (articleUrl) {
    sections.push(
      `**Linked article:** ${articleTitle ? `${articleTitle} — ` : ''}[read it on X](${articleUrl})`,
    );
  }

  const footerBits = [`[View on X](${url})`];
  if (threadUrl) footerBits.push(`[Thread](${threadUrl})`);
  footerBits.push(`[[${normaliseHandle(String(post.handle ?? ''))}]]`);
  footerBits.push(`imported ${options.addedDate}`);
  sections.push(`---\n${footerBits.join(' · ')}`);

  const body = `${sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n')}\n\n## My notes\n\n`;

  const title = titleFromText(fullText || String(post.quoted_text ?? '')) || `post ${id}`;
  const filename = sanitiseTitle(`${published || 'undated'} - ${handle} - ${title}`);

  return { filename, frontmatter, body };
}

export type VaultIndexEntry = {
  path: string;
  body: string;
  frontmatter: Frontmatter | null;
};

export type VaultIndex = Map<string, VaultIndexEntry>;

/** Index existing notes by their `id` property so moved/renamed notes are still found. */
export function buildVaultIndex(vaultPath: string, folders: string[]): VaultIndex {
  const index: VaultIndex = new Map();
  for (const folder of folders) {
    const root = join(vaultPath, folder);
    let entries;
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const absolute = join(entry.parentPath, entry.name);
      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(content);
      const id = frontmatter?.id;
      if (id === undefined || id === null) continue;
      index.set(String(id), {
        path: relative(vaultPath, absolute),
        body,
        frontmatter,
      });
    }
  }
  return index;
}

export type RenderOutcome = 'created' | 'updated' | 'body-preserved' | 'unchanged';

export type RenderSummary = {
  created: number;
  updated: number;
  bodyPreserved: number;
  unchanged: number;
  errors: number;
};

export function renderAll(
  db: DatabaseSync,
  config: Config,
  options: { limit?: number; force?: boolean } = {},
): RenderSummary {
  const summary: RenderSummary = {
    created: 0,
    updated: 0,
    bodyPreserved: 0,
    unchanged: 0,
    errors: 0,
  };

  const posts = dirtyPosts(db, options.limit);
  if (posts.length === 0) return summary;

  const index = buildVaultIndex(config.vaultPath, [
    config.inboxDir,
    config.libraryDir,
    config.authorsDir,
  ]);

  for (const post of posts) {
    try {
      const id = String(post.id);
      const media = mediaForPost(db, id) as unknown as MediaFile[];
      const addedDate = day(post.first_seen_at ?? new Date().toISOString());
      const note = buildNote(post, media, { addedDate });

      const existing = index.get(id);
      const generatedBody = note.body;
      const storedHash = post.body_hash ? String(post.body_hash) : null;
      const currentBodyHash = existing ? sha256hex(existing.body.trim()) : null;
      const userEditedBody =
        existing !== undefined && storedHash !== null && currentBodyHash !== storedHash;

      if (!existing) {
        const target = join(config.inboxDir, `${note.filename}.md`);
        writeFileAtomic(join(config.vaultPath, target), composeNote(note.frontmatter, generatedBody));
        markRendered(db, id, target, sha256hex(generatedBody.trim()), false);
        index.set(id, { path: target, body: generatedBody, frontmatter: note.frontmatter });
        summary.created += 1;
        continue;
      }

      const keptBody = userEditedBody && !options.force ? existing.body : generatedBody;
      const mergedFrontmatter = mergeFrontmatter(existing.frontmatter, note.frontmatter, {
        managedKeys: MANAGED_KEYS,
        createOnlyKeys: CREATE_ONLY_KEYS,
      });
      const nextContent = composeNote(mergedFrontmatter, keptBody);
      const absolute = join(config.vaultPath, existing.path);
      const previous = readFileSync(absolute, 'utf8');

      if (previous === nextContent) {
        markRendered(db, id, existing.path, sha256hex(keptBody.trim()), userEditedBody);
        index.set(id, { path: existing.path, body: keptBody, frontmatter: mergedFrontmatter });
        if (userEditedBody) summary.bodyPreserved += 1;
        else summary.unchanged += 1;
        continue;
      }

      writeFileAtomic(absolute, nextContent);
      markRendered(db, id, existing.path, sha256hex(keptBody.trim()), userEditedBody);
      index.set(id, { path: existing.path, body: keptBody, frontmatter: mergedFrontmatter });
      if (userEditedBody && !options.force) summary.bodyPreserved += 1;
      else summary.updated += 1;
    } catch (error) {
      summary.errors += 1;
      log.error(`Failed to render post ${String(post.id)}: ${(error as Error).message}`);
    }
  }

  return summary;
}

export { titleFromText };
