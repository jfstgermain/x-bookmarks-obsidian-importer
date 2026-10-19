import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write via a temp file in the same directory, then rename.
 * Keeps iCloud Drive and Obsidian from ever observing a half-written note.
 */
export function writeFileAtomic(file: string, content: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}
