# x-bookmarks-obsidian-importer

Import your X (Twitter) bookmarks into a dedicated Obsidian vault using the **official X API v2**,
with a local SQLite database as the source of truth and idempotent, edit-safe note rendering.

Target vault: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/X`

## Why the API and not a scraper

X has no bookmark export. The account data archive deliberately excludes bookmarks, and every
browser-extension or userscript approach reads your session cookies and breaks when X rotates its
internal GraphQL query ids.

The API has one large advantage since X moved to pay-per-use pricing: `GET /2/users/:id/bookmarks`
is classified as an **Owned Read at $0.001 per resource returned**. A 5,000-bookmark backlog costs
about **$5**, once. After that, a daily sync of 20 new bookmarks costs $0.02.

Nothing about your account is scraped, no cookies are read, and the only credential stored is an
OAuth 2.0 token you can revoke from your X account at any time.

## Design principles

1. **The vault is a projection, not the source of truth.** Every note is generated from
   `data/bookmarks.db`. Delete the vault and rebuild it; nothing is lost.
2. **Every page of raw API JSON is archived** under `data/raw/` before parsing, so a rendering bug
   never costs you API spend.
3. **Re-rendering is idempotent.** Notes are matched on the post `id`, never on filename or path, so
   moving or renaming a note is safe.
4. **Your edits win.** The importer refreshes its own frontmatter keys and replaces the generated
   body, but the body of any note you have edited is preserved, and `status` / `topics` / `summary`
   are yours from the moment the note is created.
5. **Triage, not auto-categorisation.** Bookmarks arrive as `status: inbox`; you promote them to
   `kept` or `dropped`. Sorting 5,000 posts by an LLM produces an archive you still never read.

## Requirements

- Node 24+ (uses the built-in `node:sqlite` and native TypeScript type stripping — there is no build
  step)
- An X developer account and app with OAuth 2.0 enabled

## Setup

### 1. Create the X app

1. Go to <https://developer.x.com/en/portal/dashboard> and create a project + app (free to create).
2. In the app's **User authentication settings**, click *Set up* and configure:
   - **App permissions:** Read
   - **Type of App:** Public client *(not* confidential — there is no client secret)
   - **Callback URI:** `http://localhost:8787/callback`
   - **Website URL:** anything valid, e.g. `https://github.com/`
3. Copy the **OAuth 2.0 Client ID** from *Keys and tokens*.
4. Add credits to your developer account. Credits are **prepaid** — a zero balance returns
   `402 Payment Required` on the first call. About $1 per 1,000 bookmarked posts.

### 2. Install and configure

```bash
cd ~/dev/x-bookmarks-obsidian-importer
npm install

# Point the importer at the vault and create Inbox/, Library/, Authors/, Bases/, 05_Attachments/
node src/cli.ts init --vault "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/X"

# One-time browser authorisation (opens a localhost callback listener)
node src/cli.ts auth --client-id <YOUR_CLIENT_ID>

# Verify everything: scopes, API reachability, vault access
node src/cli.ts doctor
```

Credentials land in `~/.config/x-bookmarks-importer/credentials.json` (mode `0600`, outside this
repo). The refresh token rotates on every refresh and is persisted atomically, so scheduled syncs
keep working without you re-authorising.

### 3. First import

```bash
node src/cli.ts sync      # pull bookmarks into SQLite (+ media), ~$0.001 per post
node src/cli.ts render    # write the notes
node src/cli.ts views     # rebuild .base views and per-author index notes
```

Or all three at once:

```bash
node src/cli.ts all
```

Then open the `X` vault in Obsidian and start at `00 Dashboard.md`.

## Commands

| Command | What it does |
|---|---|
| `init --vault <path>` | Save config, create the vault skeleton, write `.base` views. `--force` also rewrites `00 Dashboard.md` and `AGENTS.md` |
| `auth --client-id <id>` | OAuth 2.0 PKCE authorisation; stores refreshable tokens |
| `doctor` | Node version, vault, scopes, credential refresh, API reachability |
| `sync` | Fetch bookmarks → SQLite → `data/raw/`, then download media. Add `--since last` for a cheap top-up |
| `render` | Database → markdown notes (only notes marked dirty) |
| `views` | Regenerate `Bases/*.base` and `Authors/@handle.md` (authors above `authorIndexMinPosts`) |
| `digest` | Print a compact JSON digest (id, excerpt, current topics) of notes awaiting triage |
| `triage --plan <file> --into library` | Apply topics/status from a JSON plan and file notes into `Library/<year>/` |
| `reingest` | Replay `data/raw/*.json` through the ingester and re-render — **free**, no API calls |
| `all` | `sync` + `render` + `views` |
| `status` | Counts, estimated spend, last sync, triage breakdown |

Useful flags: `--since <post-id>|last`, `--limit <n>`, `--max-pages <n>`, `--no-media`, `--force`,
`--verbose`, `--vault <path>`.

Triaging a large backlog in batches:

```bash
node src/cli.ts render --limit 25
```

## What a note looks like

`Inbox/2026-03-14 - @janedoe - Reliability beats cleverness.md`

```markdown
---
id: "1234567890"
url: https://x.com/janedoe/status/1234567890
handle: "@janedoe"
author: Jane Doe
published: 2026-03-14
added: 2026-10-18
kind: quote
thread: https://x.com/janedoe/status/1111111111
quoted: https://x.com/other/status/999
media: [photo]
status: inbox
topics: []
---

Reliability beats cleverness.

![[1234567890-1.jpg|architecture diagram]]

> [!quote] Quoted · @other · 2026-01-02
> the thing being quoted
>
> [Open quoted post](https://x.com/other/status/999)

---
[View on X](https://x.com/janedoe/status/1234567890) · [Thread](https://x.com/janedoe/status/1111111111) · [[@janedoe]] · imported 2026-10-18

## My notes

```

| Property | Owner | Notes |
|---|---|---|
| `id`, `url`, `handle`, `author`, `published`, `added`, `lang`, `kind`, `thread`, `quoted`, `article`, `media` | importer | Refreshed on every sync |
| `status` | you | `inbox` → `kept` / `dropped`. Seeded once, never overwritten |
| `topics`, `summary` | you | Seeded once, never overwritten |

`added` is **when the importer first saw the bookmark**, not when you bookmarked it — X's API
returns no bookmark timestamp. It is named `added` rather than `saved` for that reason.

## How the organization works

Folders are deliberately shallow; everything expressive happens through properties and Bases.

- `Library/<year>/` — where triaged notes live. `Bases/Library.base` gives you *Recent* (last 25 by
  import date), *Library* (grouped by year) and *Dropped*.
- `Inbox/` — untriaged. `Bases/Inbox.base` gives you a 10-item reading queue (oldest first) plus a
  full untriaged table sorted by recency. Empty once you have triaged a batch.
- `Authors/@handle.md` — generated index of everything you saved from that account, but only for
  authors you saved from **more than once** (`authorIndexMinPosts`, default 2). Single-post authors
  are plain text in the note footer instead of a wikilink, so neither the folder nor the graph fills
  up with one-off files. On a 97-bookmark vault this is 87 accounts → 6 index notes.
- `05_Attachments/` — downloaded images and video posters, named `<post-id>-<n>.<ext>` so the vault
  survives the post being deleted.
- `00 Dashboard.md` — Recent, Library, Authors, Topics, and the triage queue, all as embedded Bases.
  Rewrite it with `init --vault <path> --force`.
- `AGENTS.md` — the schema contract, if you point an AI agent at this vault.

Triage loop: open the dashboard → read the queue → add `topics`, set `status: kept`, add notes under
`## My notes`, move the file to `Library/YYYY/`. The importer follows the note by `id`, so moving it
never breaks anything.

## Incremental syncs (`--since`)

X bills per post **returned**, not per post that is new to you. Re-reading a 2,000-bookmark list
every day costs ~$2/day even when nothing changed. `--since` fixes that.

The bookmark list is ordered **newest-bookmarked first**, so once you reach a post you already have,
everything below it is already imported. The importer stops there.

```bash
# Daily top-up: stop at the topmost post of the previous run
node src/cli.ts all --since last

# Stop at a specific post id (from a note's `id:` property or its URL)
node src/cli.ts sync --since 1801234567890123456
```

- `--since last` uses a watermark the importer saves after every run (visible in `status` as
  *incremental watermark*).
- If the watermark post was unbookmarked or deleted, it never appears and the run quietly falls back
  to reading the whole list, with a warning.
- An incremental run stops early, so it is recorded as **partial**. That is deliberate: it cannot
  prove a bookmark was removed, so `status` keeps reporting the last complete scan's view.
- Run a full `sync` occasionally (weekly is plenty) to refresh completeness tracking and pick up
  engagement-count changes on older bookmarks.

## Costs and rate limits

- **$0.001 per post returned** (Owned Read), prepaid in credits at `console.x.com`.
- A full 2,000-bookmark scan is ~$2. A `--since last` daily top-up is ~$0.10 (one page).
- `status` tracks cumulative estimated spend.
- 180 requests / 15 minutes per user, 100 posts per page. The client waits out `429`s using
  `x-rate-limit-reset` and retries `5xx` with exponential backoff.
- The field-name profile that worked is remembered, so incremental runs make a single request
  instead of probing the modern names first.
- Use `--max-pages` / `--limit` to cap a run. `--no-media` skips the CDN downloads.

## Reliability details worth knowing

- **Field-name rename tolerance.** X is migrating `tweet.fields` → `post.fields`,
  `referenced_tweets` → `referenced_posts`, `note_tweet` → `note_post`. The client tries the modern
  names first and automatically retries with legacy names if the API rejects them.
- **"No longer bookmarked" is only claimed after a complete scan.** A run that stops at `--limit` or
  `--max-pages` is recorded as partial; `status` won't claim a bookmark disappeared based on it.
- **Long posts** use `note_post.text` (full text), not the truncated `text`.
- **Retweets** keep the wrapper's id but render the original content.
- **Video** is linked, with the poster frame cached. Full mp4s are opt-in via `downloadVideo`.

## Scheduling a daily sync

`~/Library/LaunchAgents/com.jfstgermain.x-bookmarks.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jfstgermain.x-bookmarks</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd $HOME/dev/x-bookmarks-obsidian-importer &amp;&amp; node src/cli.ts all --since last >> data/sync.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>/tmp/x-bookmarks.err</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jfstgermain.x-bookmarks.plist
```

```bash
node src/cli.ts all --since last   # daily, ~$0.10
node src/cli.ts all                # weekly full refresh, ~$2 per 2k bookmarks
```

## Triaging at scale

Tagging 97 bookmarks by hand is an hour of clicking. The importer exposes a two-step loop that
lets a script or an AI session do the reading while you keep the decision:

```bash
# 1. Get a compact digest of everything untriaged
node src/cli.ts digest --out /tmp/digest.json

# 2. Write a plan: [{ "id": "...", "topics": ["ai-agents", "finance"] }, ...]
node src/cli.ts triage --plan plan.json --into library --status kept --dry-run
node src/cli.ts triage --plan plan.json --into library --status kept
```

Notes are matched by `id`, so a plan can be re-run safely, applied to notes already in `Library/`,
and will never touch a note it does not recognise (unknown ids are reported, not guessed at).
`--into library` moves each note to `Library/<published year>/`.

Keep plan files in `data/triage-plans/` — they are the record of *why* a note is tagged the way
it is, which is worth more than the tags themselves once the vault is large.

## What the ingester extracts

| Source field | Lands in the note as |
|---|---|
| `note_post.text` | the full long-post body (not the truncated `text`) |
| `article.plain_text` | `## Full article` — the complete body of native X Articles, 8k–30k chars |
| `article.preview_text` | an opening paragraph, so link-only posts still read |
| `entities.urls` | `**Links**` — expanded URLs with their titles, instead of dead `t.co` stubs |
| `referenced_posts` | an inline quote/retweet callout |
| `attachments.media_keys` | downloaded images / video posters under `05_Attachments/` |

Because every API page is archived verbatim in `data/raw/`, new extraction logic can be applied
retroactively with `reingest` at zero cost — that is how the article bodies above were recovered
after the first import had already dropped them.

## Project layout

```
src/
  cli.ts          command dispatch and orchestration
  auth.ts         OAuth 2.0 PKCE + refresh-token rotation
  xapi.ts         API client, pagination, field-profile fallback, page ingestion
  db.ts           SQLite schema, dedupe, provenance, run bookkeeping
  render.ts       note building + idempotent vault writer
  triage.ts       digest generation + topic/status plan application
  frontmatter.ts  Obsidian-safe YAML encoding and merge rules
  media.ts        media downloads
  views.ts        .base views + per-author indexes
  vault-docs.ts   dashboard and AGENTS.md templates
test/             61 tests: YAML encoding, merge rules, note rendering,
                  article/link extraction, dedupe, media mapping, triage plans,
                  and an end-to-end run against a mock API
```

```bash
npm test          # node --test
npm run typecheck # tsc --noEmit
```

## Limitations

- X exposes no bookmark timestamp and no "date unbookmarked".
- Bookmarks you remove on X stay in the vault (by design — the vault is an archive). `status` reports
  how many are no longer bookmarked; nothing is deleted automatically.
- Desktop-only workflow in practice: syncing writes files locally, which iCloud then syncs to
  Obsidian mobile.
