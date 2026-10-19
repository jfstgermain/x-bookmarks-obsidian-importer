import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { mediaForPost, recordMediaFile, markMediaUnavailable } from './db.ts';
import { log } from './log.ts';
import { sleep } from './util.ts';

type MediaRow = {
  idx: number;
  type: string | null;
  url: string | null;
  preview_url: string | null;
};

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function extensionFor(url: string, contentType: string | null, type: string | null): string {
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if (IMAGE_EXT.has(fromUrl)) return fromUrl;
  if (contentType?.includes('mp4')) return '.mp4';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('jpeg')) return '.jpg';
  if (type === 'video') return '.mp4';
  return '.jpg';
}

async function fetchBuffer(url: string, attempt = 1): Promise<{ data: Buffer; contentType: string | null }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'x-bookmarks-obsidian-importer/0.1' },
  });
  if (response.status === 429 || response.status >= 500) {
    if (attempt < 3) {
      await sleep(1000 * 2 ** (attempt - 1));
      return fetchBuffer(url, attempt + 1);
    }
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return { data: Buffer.from(arrayBuffer), contentType: response.headers.get('content-type') };
}

export type MediaResult = { downloaded: number; skipped: number; failed: number };

/** Download the media for one post into the vault's attachments folder. */
export async function downloadMediaForPost(
  db: DatabaseSync,
  config: Config,
  postId: string,
): Promise<MediaResult> {
  const result: MediaResult = { downloaded: 0, skipped: 0, failed: 0 };
  if (!config.downloadMedia) return result;

  const rows = mediaForPost(db, postId) as unknown as MediaRow[];
  if (rows.length === 0) return result;

  const dir = join(config.vaultPath, config.attachmentsDir);

  for (const row of rows) {
    const isVideo = row.type === 'video' || row.type === 'animated_gif';
    // Full videos are opt-in: they are large and the poster frame is usually enough to remember.
    const source = isVideo && !config.downloadVideo ? row.preview_url : (row.url ?? row.preview_url);
    if (!source) {
      result.skipped += 1;
      continue;
    }

    const existing = db
      .prepare('SELECT local_file FROM media WHERE post_id = ? AND idx = ?')
      .get(postId, row.idx) as { local_file: string | null } | undefined;

    if (existing?.local_file && existsSync(join(dir, existing.local_file))) {
      if (statSync(join(dir, existing.local_file)).size > 0) {
        result.skipped += 1;
        continue;
      }
    }

    try {
      const { data, contentType } = await fetchBuffer(source);
      if (data.length === 0) throw new Error('empty response');
      const ext = extensionFor(source, contentType, row.type);
      const filename = `${postId}-${row.idx + 1}${ext}`;
      await writeFile(join(dir, filename), data);
      recordMediaFile(db, postId, row.idx, filename);
      result.downloaded += 1;
    } catch (error) {
      result.failed += 1;
      markMediaUnavailable(db, postId, row.idx);
      log.warn(`Media ${postId}#${row.idx + 1} failed: ${(error as Error).message}`);
    }
  }

  return result;
}

/** Bounded-concurrency walk over posts that still need media. */
export async function downloadAllMedia(
  db: DatabaseSync,
  config: Config,
  options: { concurrency?: number; limit?: number } = {},
): Promise<MediaResult> {
  const total: MediaResult = { downloaded: 0, skipped: 0, failed: 0 };
  if (!config.downloadMedia) return total;

  const rows = db
    .prepare(
      `SELECT DISTINCT p.id AS id
         FROM posts p
         JOIN media m ON m.post_id = p.id
        WHERE m.local_file IS NULL
        ORDER BY p.created_at DESC${options.limit ? ' LIMIT ?' : ''}`,
    )
    .all(...(options.limit ? [options.limit] : [])) as Array<{ id: string }>;

  const concurrency = Math.max(1, options.concurrency ?? 4);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const row = rows[index];
      if (!row) return;
      const result = await downloadMediaForPost(db, config, row.id);
      total.downloaded += result.downloaded;
      total.skipped += result.skipped;
      total.failed += result.failed;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return total;
}

export function pendingMediaCount(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT post_id) AS n FROM media WHERE local_file IS NULL')
    .get() as { n: number };
  return Number(row.n ?? 0);
}
