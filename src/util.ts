import { createHash, randomBytes } from 'node:crypto';

/** Hex SHA-256, used for body hashes so we can detect user edits. */
export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** RFC 7636 base64url without padding. */
export function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** YYYY-MM-DD in local time. */
export function isoDay(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Full ISO-8601 timestamp, UTC. */
export function isoStamp(value: Date = new Date()): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RESERVED_CHARS = /[/\\:*?"<>|#^[\]\u0000-\u001f]/g;

/**
 * Filesystem- and Obsidian-safe title slug derived from post text.
 * Keeps the author's capitalisation because it reads better than lowercasing.
 */
export function titleFromText(text: string, maxWords = 10, maxChars = 70): string {
  let cleaned = text
    // strip bare URLs (t.co and friends), they carry no meaning in a filename
    .replace(/https?:\/\/\S+/g, ' ')
    // strip leading mentions and RT markers
    .replace(/^(?:RT\s+)?(?:@\w+\s*[:,-]?\s*)+/i, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  // Keep the first sentence if it is short enough, otherwise fall back to words.
  const firstSentence = cleaned.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  const candidate =
    firstSentence.length > 0 && firstSentence.length <= maxChars
      ? firstSentence
      : cleaned.split(' ').slice(0, maxWords).join(' ');

  cleaned = candidate
    .replace(RESERVED_CHARS, '')
    .replace(/\s+/g, ' ')
    // trailing punctuation looks wrong in a filename
    .replace(/[\s.,;:!?-]+$/, '')
    .trim();

  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
  }
  return cleaned;
}

/** Strip characters Windows/macOS/Obsidian dislike, then clamp length. */
export function sanitizeFilename(name: string, maxChars = 120): string {
  const cleaned = name.replace(RESERVED_CHARS, '').replace(/\s+/g, ' ').trim();
  const clamped = cleaned.length > maxChars ? cleaned.slice(0, maxChars).trim() : cleaned;
  return clamped.replace(/[\s.]+$/, '') || 'untitled';
}

/** Normalise a handle to exactly one leading @. */
export function normaliseHandle(handle: string | undefined | null): string {
  if (!handle) return 'unknown';
  const bare = handle.replace(/^@+/, '').trim();
  return bare ? `@${bare}` : 'unknown';
}

/** Canonical public URL for a post id + handle. */
export function postUrl(handle: string, id: string): string {
  const bare = (handle || '').replace(/^@+/, '') || 'i';
  return `https://x.com/${bare}/status/${id}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Coerce anything to a number, defaulting to 0. */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Snowflake id -> approximate post timestamp. Used only when the API omits
 * created_at; X post ids encode the creation time in their high bits.
 */
export function dateFromPostId(id: string): Date | null {
  try {
    const asBig = BigInt(id);
    const ms = (asBig >> 22n) + 1288834974657n;
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
