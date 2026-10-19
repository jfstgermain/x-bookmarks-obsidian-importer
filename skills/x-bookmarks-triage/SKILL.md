---
name: x-bookmarks-triage
description: Triage imported X (Twitter) bookmarks in the Obsidian vault — read the digest, assign topics from a controlled vocabulary, set keep/drop status, and file notes into Library/<year>/. Use when asked to triage, tag, organize, sort, or review bookmarks imported by x-bookmarks-obsidian-importer, or when a bookmark batch is sitting untriaged in Inbox/.
---

# X bookmarks triage

You are triaging a personal X-bookmarks archive. The importer already fetched, rendered and
deduplicated everything; your job is the only part a script cannot do — **deciding what each saved
post is about**, and recording that decision so it is queryable forever.

## Where things are

- **Tool repo:** `~/dev/x-bookmarks-obsidian-importer` — run every command from there.
- **Vault:** resolve with `jq -r .vaultPath ~/.config/x-bookmarks-importer/config.json`. Do not hardcode it.
- **Vocabulary:** `TOPICS.md` in the repo root. Read it before tagging anything. It is the contract.
- **Plan archive:** write plans to `data/triage-plans/YYYY-MM-DD-<reason>.json`. These are the record
  of *why* a note carries its tags and are worth more than the tags once the vault is large.

## Hard rules

1. **Tag only from `TOPICS.md`.** If nothing fits, keep the note and use `unsorted`; then tell the
   user which notes landed there and why. To add a vocabulary entry, propose it with examples and
   wait — never invent a tag mid-run.
2. **Never touch the note body.** No editing `## My notes`, no rewriting the generated sections, no
   "cleanup". `triage` only writes `topics`, `status` and (optionally) `summary`.
3. **Never fabricate a `summary`.** Leave it absent unless the user asked for summaries, or unless a
   note is genuinely long-form and you were asked to make it skimmable.
4. **Never drop a bookmark unless explicitly told to.** Default is `status: kept`. If the user says
   "triage with judgment", propose a drop list and wait for approval before applying it.
5. **Always dry-run before applying.** Report the count and the topic distribution. Do not ask for
   confirmation on individual tags — that is the tedious work you are replacing.
6. **Never run `sync` as part of triage.** It spends real API credits. Triage is local and free.
   `reingest` is also free and may be run freely.

## Procedure

### 1. See what is waiting

```bash
cd ~/dev/x-bookmarks-obsidian-importer
node src/cli.ts status                 # how many notes, current status breakdown
node src/cli.ts digest --out /tmp/digest.json
```

`digest` emits one JSON object per note: `id`, `path`, `handle`, `author`, `published`, `kind`,
`media`, current `topics`, and a ~320-character `excerpt`. It is deliberately compact — read it
instead of opening 100 notes.

If the digest is large, work in slices. The `excerpt` is cut off before `## Full article`, so for
`kind: article` notes read the note itself before tagging (they can be 20,000+ words).

### 2. Fix content gaps first, if any

If excerpts are empty, are bare `t.co` URLs, or say `Links - twitter.com`, the ingester may have run
before article/link extraction existed. That is recoverable for free from the archived API pages:

```bash
node src/cli.ts reingest     # replays data/raw/*.json, re-renders notes — no API cost
```

Then re-run `digest`. Only after this should `unsorted` even be a candidate.

### 3. Decide topics

For each note, in one pass, assign `topics` per `TOPICS.md`: 1 topic normally, 2 when the note
genuinely spans two lanes. Judge the *content*, not the author or the framing.

- Retweets and quotes: tag the content being surfaced, not the wrapper.
- Non-English posts: tag in the same vocabulary; do not translate or transliterate.
- Roadmaps and curricula: `learning` plus the domain (`career`, `ai-engineering`, …).
- Hype-thread posts about agents building trading systems: `crypto-trading` + `ai-agents`.
- Marketing-voice posts about AI changing jobs: `ai-economy`, even if the tone is personal.

Stay ruthlessly consistent with previously applied tags. If a note's existing `topics` are already
correct, skip it — do not re-tag for style.

### 4. Write the plan

```json
{
  "entries": [
    { "id": "2103348168377389204", "topics": ["ai-engineering", "learning"] },
    { "id": "2108483841866236269", "topics": ["unsorted"] }
  ]
}
```

`id` must come verbatim from the digest. Plans are idempotent and never touch an unrecognised id.

### 5. Dry-run, then apply

```bash
node src/cli.ts triage --plan data/triage-plans/$(date +%F)-batch.json --status kept --into library --dry-run
node src/cli.ts triage --plan data/triage-plans/$(date +%F)-batch.json --status kept --into library
node src/cli.ts views
```

- `--status kept` stamps the triage decision (use `--status none` to leave status alone).
- `--into library` moves notes to `Library/<published year>/`. Omit it to leave them in `Inbox/`
  when the user is triaging incrementally and wants to revisit.
- `views` rebuilds the Bases and author indexes so the dashboard reflects the new tags immediately.

### 6. Verify and report

```bash
node src/cli.ts digest --folder Library --out /tmp/lib.json
jq -r '[.[].topics[]] | group_by(.) | map({t: .[0], n: length}) | sort_by(-.n) | .[] | "\(.n)\t\(.t)"' /tmp/lib.json
```

Report to the user:

- how many notes were triaged and where they went;
- the topic distribution as a table;
- **every `unsorted` note with its id and the reason** (one line each) — this is the honest residue
  and the only thing that needs their eyes;
- anything you noticed that the importer should have caught (missing articles, dropped links, junk
  `lang` values). Do not silently work around an extraction bug — surface it.

## Environment

Node 24+ (the tool uses `node:sqlite` and native type stripping). If a command fails with
`credits depleted`, that is a billing issue on `sync` only — triage never needs credits.

Run `node src/cli.ts help` for the full flag list.
