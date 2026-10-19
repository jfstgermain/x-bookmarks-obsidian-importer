# Topic vocabulary

The controlled vocabulary for the `topics` property. **A model triaging this vault must tag from
this list and nothing else.** Consistency across sessions matters more than the perfect label: a tag
used twice is useful, a tag used once is noise.

Rules:

- **1–2 topics per note.** One is normal. Two when a note genuinely spans two lanes (e.g. an AI-agent
  post that is really about business). Three is almost always wrong.
- **Lowercase slugs**, hyphenated. No capitals, no spaces, no `#`.
- **Never edit a tag to "improve" it** once applied. Add a second tag instead, or leave it.
- To add a new topic: propose it to the user with three example notes and wait for approval, then add
  it here in the same change. Do not invent silently, even if it feels obvious.

| Slug | Use for | Do not use for |
|---|---|---|
| `ai-agents` | Agent loops and harnesses, Claude Code / Codex / Opus workflows, tool use, multi-agent systems, context management between agents, prompt-that-builds-an-agent posts | Model research or benchmarks → `ai-engineering`; macro claims about AI and jobs → `ai-economy` |
| `ai-engineering` | AI system design, RAG / fine-tuning / inference choices, evaluation, LLM architecture, AI-app roadmaps, technical interview material about AI systems | Day-to-day agent usage → `ai-agents`; the software-engineering craft itself → `software-craft` |
| `ai-economy` | Macro commentary on AI: labor value, job displacement, moats disappearing, compute/infrastructure buildout, post-AGI speculation | Personal career tactics → `career`; broad social consequences such as housing → `society` |
| `career` | Job search, interviews, résumés, salary moves, role transitions, FDE/forward-deployed roles, what skills to learn next, engineering management | Company strategy → `business`; societal labor-market claims → `ai-economy` |
| `finance` | Personal finance and investing: Canadian ETFs, TFSA/RRSP, CRA rules, bonds and treasuries, market-crash calls, portfolio allocation, real-estate-as-investment | Business revenue and pricing → `business`; trading bots and crypto → `crypto-trading` |
| `crypto-trading` | Trading agents and bots, quant setups, crypto, market-data tooling, "replace a Bloomberg terminal" posts | Long-term investing → `finance` |
| `business` | Startups, monetization, pricing, distribution and moats, consulting and agency models, SMB digitization, founders' economics, growth tactics | Corporate hiring → `career` |
| `software-craft` | Code quality, architecture and design judgement, engineering practice, "writing code in the AI era" craft debates, language/framework depth | Tooling and self-hosted software → `dev-tools`; AI-assisted workflow mechanics → `ai-agents` |
| `dev-tools` | Developer tools, OSS alternatives, self-hosting, VPN/networking, editors, local-first utilities, hardware/perf utilities | Craft debates → `software-craft`; AI coding agents → `ai-agents` |
| `obsidian-pkm` | Obsidian specifically, second-brain setups, note systems, vault architecture, PKM workflows | General study technique → `learning` |
| `learning` | Study systems, roadmaps, curricula, glossaries, "how I learned X in N months", book recommendations, spaced practice | Job-market framing of the same roadmap → `career` |
| `society` | Social and political consequences: housing markets, emigration and urban safety, regional politics, what happens to institutions, game-theory-of-life essays | AI-specific economics → `ai-economy` |
| `product` | Building and shipping a product: onboarding, paywalls, reverse-engineering competitors, app-store mechanics, UI/UX decisions | Company-level strategy → `business` |
| `health` | Supplements, sleep, fitness, longevity, medical claims | — |
| `legal-risk` | Compliance and liability traps for builders: COPPA, licensing, privacy, regulatory exposure | — |
| `unsorted` | Genuinely unreadable with the data available: a single word, "lol", a bare link that resolves to nothing contextual | Anything where the note body, `**Links**`, or `## Full article` gives you enough to decide |

## Before you reach for `unsorted`

Check, in order:

1. The post body itself (the paragraph above the `---` footer line).
2. The `**Links**` section — link entities often carry the title of what was actually shared.
3. `## Full article` — native X Articles are stored in full, so a note whose visible text is a
   single `t.co` URL may be a 20,000-word essay.
4. The `quoted` property and the `> [!quote]` callout, for replies and retweets.

Only when all four are empty is `unsorted` correct. A vault with 2% `unsorted` is healthy; 0% usually
means the model guessed.
