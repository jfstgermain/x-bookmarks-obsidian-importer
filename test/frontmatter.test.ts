import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  composeNote,
  encodeScalar,
  mergeFrontmatter,
  serialiseFrontmatter,
  splitFrontmatter,
} from '../src/frontmatter.ts';

test('dates stay unquoted so Bases treats them as dates', () => {
  assert.equal(encodeScalar('2026-03-14'), '2026-03-14');
  assert.equal(encodeScalar('2026-03-14T10:22:31Z'), '2026-03-14T10:22:31Z');
});

test('numeric-looking strings are quoted so post ids stay strings', () => {
  assert.equal(encodeScalar('1234567890'), '"1234567890"');
});

test('YAML-reserved words and indicator-leading strings are quoted', () => {
  assert.equal(encodeScalar('true'), '"true"');
  assert.equal(encodeScalar('null'), '"null"');
  assert.equal(encodeScalar('@janedoe'), '"@janedoe"');
});

test('plain prose stays readable', () => {
  assert.equal(encodeScalar('Jane Doe'), 'Jane Doe');
  assert.equal(encodeScalar('How to build agents'), 'How to build agents');
});

test('strings containing YAML syntax are quoted', () => {
  assert.equal(encodeScalar('a: b'), '"a: b"');
  assert.equal(encodeScalar('#notatag'), '"#notatag"');
  assert.equal(encodeScalar('line\nbreak'), '"line\\nbreak"');
});

test('arrays are encoded inline', () => {
  assert.equal(
    serialiseFrontmatter({ topics: [] }).includes('topics: []'),
    true,
    'empty list stays a list, not an empty string',
  );
  assert.equal(
    serialiseFrontmatter({ topics: ['ai', 'obsidian'] }).includes('topics: [ai, obsidian]'),
    true,
  );
});

test('frontmatter round-trips through the parser', () => {
  const frontmatter = {
    id: '1234567890',
    url: 'https://x.com/janedoe/status/1234567890',
    handle: '@janedoe',
    published: '2026-03-14',
    topics: ['ai', 'agents'],
    count: 3,
  };
  const note = composeNote(frontmatter, 'Hello\n');
  const split = splitFrontmatter(note);
  assert.deepEqual(split.frontmatter, frontmatter);
  assert.equal(split.body, 'Hello\n');
});

test('notes without frontmatter are handled', () => {
  const split = splitFrontmatter('# Just a note\n');
  assert.equal(split.frontmatter, null);
  assert.equal(split.body, '# Just a note\n');
});

test('merge refreshes managed keys but never touches user-owned ones', () => {
  const existing = {
    id: '1',
    url: 'https://old',
    handle: '@a',
    status: 'kept',
    topics: ['ai'],
    myKey: 'mine',
  };
  const generated = {
    id: '1',
    url: 'https://new',
    handle: '@a',
    quoted: 'https://quote',
    status: 'inbox',
    topics: [],
  };

  const merged = mergeFrontmatter(existing, generated, {
    managedKeys: ['id', 'url', 'handle', 'quoted', 'status', 'topics'],
    createOnlyKeys: ['status', 'topics'],
  });

  assert.equal(merged.url, 'https://new', 'managed key refreshed');
  assert.equal(merged.quoted, 'https://quote', 'new managed key added');
  assert.equal(merged.status, 'kept', 'user triage status preserved');
  assert.deepEqual(merged.topics, ['ai'], 'user topics preserved');
  assert.equal(merged.myKey, 'mine', 'unknown user key preserved');
});

test('merge drops managed keys the generator no longer emits', () => {
  const merged = mergeFrontmatter(
    { id: '1', quoted: 'https://gone', status: 'inbox' },
    { id: '1' },
    { managedKeys: ['id', 'quoted'], createOnlyKeys: ['status'] },
  );
  assert.equal('quoted' in merged, false);
  assert.equal(merged.status, 'inbox');
});

test('create-only values are seeded when absent', () => {
  const merged = mergeFrontmatter(null, { id: '1', status: 'inbox', topics: [] }, {
    managedKeys: ['id'],
    createOnlyKeys: ['status', 'topics'],
  });
  assert.equal(merged.status, 'inbox');
  assert.deepEqual(merged.topics, []);
});
