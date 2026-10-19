import { parse as parseYaml } from 'yaml';

export type Frontmatter = Record<string, unknown>;

export type SplitResult = { frontmatter: Frontmatter | null; body: string; raw: string };

const FENCE = '---';

/** Split an Obsidian note into frontmatter + body, tolerating CRLF and a BOM. */
export function splitFrontmatter(content: string): SplitResult {
  const text = content.replace(/^\uFEFF/, '');
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return { frontmatter: null, body: text, raw: '' };
  }

  const normalised = text.replace(/\r\n/g, '\n');
  const end = normalised.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return { frontmatter: null, body: text, raw: '' };

  const raw = normalised.slice(FENCE.length + 1, end);
  const body = normalised.slice(end + FENCE.length + 1).replace(/^\n/, '');

  let frontmatter: Frontmatter | null = null;
  try {
    const parsed = parseYaml(raw);
    frontmatter =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Frontmatter)
        : null;
  } catch {
    frontmatter = null;
  }

  return { frontmatter, body, raw };
}

const YAML_RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

/**
 * Encode one YAML scalar the way Obsidian expects.
 * Dates stay unquoted so Bases/Search treat them as dates; numeric-looking strings
 * (post ids!) and anything with YAML meaning get quoted.
 */
export function encodeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const text = String(value);
  if (text === '') return '""';
  if (DATE_LIKE.test(text)) return text;
  if (/^\d+$/.test(text)) return JSON.stringify(text);
  if (YAML_RESERVED.test(text)) return JSON.stringify(text);
  if (/^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z0-9 ._/\-\u00C0-\u024F\u2019'()]*$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function encodeValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((item) => encodeScalar(item)).join(', ')}]`;
  }
  return encodeScalar(value);
}

export function serialiseFrontmatter(frontmatter: Frontmatter): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${encodeValue(value)}`);
  }
  lines.push(FENCE);
  return `${lines.join('\n')}\n`;
}

export function composeNote(frontmatter: Frontmatter, body: string): string {
  return `${serialiseFrontmatter(frontmatter)}${body.replace(/^\n+/, '')}`;
}

/**
 * Merge freshly generated frontmatter into an existing note's frontmatter.
 *
 * - Keys listed in `managedKeys` are owned by the importer and get refreshed.
 * - Keys listed in `createOnlyKeys` are seeded once and then belong to the user
 *   (that is how `status` and `topics` survive every re-sync).
 * - Anything else the user added is preserved untouched.
 */
export function mergeFrontmatter(
  existing: Frontmatter | null,
  generated: Frontmatter,
  options: { managedKeys: string[]; createOnlyKeys: string[] },
): Frontmatter {
  const { managedKeys, createOnlyKeys } = options;
  const managed = new Set(managedKeys);
  const createOnly = new Set(createOnlyKeys);
  const merged: Frontmatter = {};

  // Generated order first, so regenerated notes stay stable and readable.
  for (const [key, value] of Object.entries(generated)) {
    if (createOnly.has(key)) {
      merged[key] = existing && key in existing ? existing[key] : value;
      continue;
    }
    merged[key] = value;
  }

  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key in merged) continue;
    // Drop managed keys we no longer emit (e.g. a quote that got removed)…
    if (managed.has(key) && !createOnly.has(key) && !(key in generated)) continue;
    // …but keep everything the user owns.
    merged[key] = value;
  }

  return merged;
}
