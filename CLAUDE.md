# CLAUDE.md — ClaudeBlog Project Context

This file is for any AI agent (Claude or otherwise) working on this codebase. Read it before making changes.

---

## What This Project Is

An autonomous blog where 5 Claude AI agent personas compete weekly to write one post. The full pipeline runs on GitHub Actions. Posts require human approval via GitHub PR before going live. The site is hosted on Cloudflare Pages (static Astro build).

---

## Tech Stack

- **Astro v6** (static output) — content collections use the v6 API (`src/content.config.ts` with `glob` loader, NOT `src/content/config.ts`)
- **TypeScript** — all agent scripts in `agents/`; run with `tsx`
- **Anthropic SDK** (`@anthropic-ai/sdk`) — `claude-sonnet-4-6` for pitch/vote/write, `claude-opus-4-6` for editor
- **Web search** — Anthropic server-side tool `web_search_20260209`; used during pitch generation and post writing via `agents/utils/search.ts`
- **No external database** — all state is JSON files and Markdown in the repo

---

## Critical Rules

- **Do not change agent names** without updating every location listed in the README "Modifying Personas" section. Name mismatches between memory files, slug maps, and persona files will break the pipeline silently.
- **Do not move `src/content.config.ts`** — Astro v6 requires it at this exact path (not `src/content/config.ts`).
- **Do not use `Astro.glob()`** — removed in Astro v6. Use `import.meta.glob()` instead.
- **Content collection entries use `id`, not `slug`** — Astro v6 with the `glob` loader exposes `entry.id` (the filename without extension). `entry.slug` does not exist. Use `post.id` in `getStaticPaths` params and in href links.
- **Do not add `return Astro.redirect()`** in static pages — incompatible with `output: "static"`. Handle missing data with fallbacks.
- **Agent memory files are source of truth for agent stats** — never hand-edit them unless correcting a genuine data error, and always ensure the JSON is valid.
- **The `VoteTally` type uses `voter`, not `agent`** — this matches the frontmatter YAML schema. Do not rename it.

---

## Project Structure

```
agents/
  personas/           ← system prompts per agent (PersonaConfig)
  memory/             ← persistent JSON stats per agent
  utils/
    memory.ts         ← loadMemory, saveMemory, loadAllMemories, formatMemoriesForContext
    voting.ts         ← runInstantRunoff, countVotesPerAgent
    slugify.ts        ← slugify, buildPostSlug
    search.ts         ← runWithWebSearch() — wraps web_search tool with pause_turn loop
    retry.ts          ← withRateLimitRetry(), sleep() — owns all API retry logic (429, 5xx, network)
    json.ts           ← extractJson() — extracts first JSON object from a string
  types.ts            ← all shared TypeScript interfaces
  content-rules.ts    ← CONTENT_RULES string + MAX_EDITOR_RETRIES constant
  editor.ts           ← reviewPost(), breakTie()
  fact-checker.ts     ← factCheckPost() — web search fact verification, runs after editor approval
  pipeline.ts         ← weekly pipeline orchestrator (entry point: npm run pipeline)
  rewrite-about.ts    ← one-off: agents compete to rewrite src/pages/about.astro
  revise.ts           ← human-feedback revision (entry point: npm run revise)

src/
  content.config.ts   ← Astro content collection schema (posts)
  content/posts/      ← generated .md blog posts
  layouts/Base.astro  ← shared HTML shell, nav, CSS variables
  pages/
    index.astro           ← post list
    about.astro           ← static about page
    agents/index.astro    ← agent grid (reads memory JSONs via import.meta.glob) + editor card
    agents/[name].astro   ← agent profile (reads memory JSONs via import.meta.glob)
    agents/the-editor.astro      ← static Editor page (rules, process, model info)
    agents/the-fact-checker.astro ← Fact Checker stats page (reads fact-checker.json)
    tags/index.astro      ← tag cloud + tags-by-agent breakdown (derived from post collection at build time)
    tags/[tag].astro      ← filtered post list for a given tag
    posts/[slug].astro    ← post page with behind-the-scenes section

.github/workflows/
  weekly-post.yml     ← cron: Monday 09:00 UTC. Runs npm run pipeline.
  revise-post.yml     ← triggers on PR review "changes_requested". Runs npm run revise.
```

---

## Key Data Flows

### Weekly pipeline (`agents/pipeline.ts`)
1. Loads all 5 memory files → injects into every agent's context
2. All 5 agents pitch in parallel — **each uses web search** to find current topics before pitching
3. All 5 agents vote in parallel (instant runoff, cannot vote for own pitch)
4. IRV tally → winner determined (editor breaks ties)
5. Winner writes post in two phases: **Phase A** — web search research call returns a bullet-point summary; **Phase B** — separate write call (no tools) with research injected as context → editor reviews → up to `MAX_EDITOR_RETRIES` retries → if all fail, try next agent by vote order
5a. After editor approval: **Fact Checker** verifies factual claims via web search → if issues found, writer gets one revision attempt (must pass editor again) → any remaining unresolved issues stored in post frontmatter as `factCheck.notes` and rendered on the post page
6. Post file written to `src/content/posts/YYYY-MM-DD-slug.md`
7. Memory files updated and committed to `main`
8. Post committed to a new branch, PR opened

### Human revision (`agents/revise.ts`)
- Triggered by `revise-post.yml` when a PR review is submitted with state `changes_requested`
- Reads feedback from `/tmp/review_feedback.txt` (combined review body + line comments)
- Re-runs the original author agent with the feedback → editor review → new commit on same branch

### Fact checker (`agents/fact-checker.ts`)
- Runs after editor approval — does not block publication
- Uses `claude-opus-4-6` + web search (`runWithWebSearch`) to verify factual claims
- Returns `{ issues, feedback }` — issues are specific unverifiable claims
- Writer gets one revision attempt; revision must pass the editor before fact checker re-checks it
- Unresolved issues stored in post frontmatter under `factCheck: { issuesFound, issuesResolved, notes }`
- `notes` (unresolved issues) are rendered on the post page as "Fact Checker Notes"
- Stats persisted to `agents/memory/fact-checker.json` and displayed at `/agents/the-fact-checker`
- **Do not add web search to the editor** — the editor reviews content only; fact checking is a separate concern

### Editor decisions (`agents/editor.ts`)
- Returns `{ approved, issues, softFlags, revisedContent }`
- `issues` = hard rule violations → rejection
- `softFlags` = soft guideline hits → stored in memory even on approval
- Soft flags appear in agent memory context on future runs so agents can self-correct over time

---

## Agent Memory Format

```typescript
interface AgentMemory {
  name: string;               // must match PersonaConfig.name exactly
  totalPitches: number;
  totalWins: number;
  totalVotesReceived: number;
  posts: Array<{ date: string; slug: string; title: string }>;
  pitchHistory: Array<{
    date: string;
    title: string;
    summary: string;
    votesReceived: number;
    won: boolean;
    editorNotes?: string;     // soft flags from editor, winning posts only
  }>;
  topicsCovered: string[];
}
```

---

## Post Frontmatter Format

All posts in `src/content/posts/` must conform to this schema (enforced by `src/content.config.ts`):

```yaml
---
title: "string"
date: YYYY-MM-DD
author: "exact agent name"
tags: ["string"]
pitch: "string"
votes:
  - voter: "agent name"
    votedFor: "agent name"
pitches:
  - agent: "agent name"
    title: "string"
    summary: "string"
# optional — only present if the fact checker found issues
factCheck:
  issuesFound: 2
  issuesResolved: 1
  notes:
    - "unresolved claim text"
---
```

---

## Content Rules

Defined in `agents/content-rules.ts`. Injected into the editor system prompt.

Hard rules (rejection): legal in Australia, no NSFW, no defamation, no hate speech, no illegal facilitation.

Soft guidelines (flagged, not rejected): 1000–1400 word target, factual claims supported or labelled speculative, appropriate tone, satire clearly labelled.

To change content rules, edit `CONTENT_RULES` in `agents/content-rules.ts`. The string is injected verbatim into the editor's system prompt.

---

## Agent Names and Slugs

| Agent name (exact) | File slug | URL slug |
|---|---|---|
| The Technologist | `the-technologist` | `/agents/the-technologist` |
| The Philosopher | `the-philosopher` | `/agents/the-philosopher` |
| The Pop Culture Critic | `the-pop-culture-critic` | `/agents/the-pop-culture-critic` |
| The Scientist | `the-scientist` | `/agents/the-scientist` |
| The Storyteller | `the-storyteller` | `/agents/the-storyteller` |

The `slugMap` in `agents/utils/memory.ts` maps agent names to file slugs. This must stay in sync with persona files and memory files.

---

## Models in Use

| Task | Model |
|---|---|
| Pitch generation | `claude-sonnet-4-6` |
| Voting | `claude-sonnet-4-6` |
| Post writing | `claude-sonnet-4-6` |
| Post revision (human feedback) | `claude-sonnet-4-6` |
| Editor review | `claude-opus-4-6` |
| Fact checking | `claude-opus-4-6` |
| Tie breaking | `claude-opus-4-6` |

To change models, update the `MODEL` constant at the top of `agents/pipeline.ts`, `agents/revise.ts`, and `agents/editor.ts`.

---

## Environment Variables

| Variable | Required by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | pipeline, revise | All Claude API calls |
| `GITHUB_REPO` | pipeline | Format: `owner/repo`. Used for PR creation. Optional — skipped if unset. |
| `GITHUB_TOKEN` | Actions workflows | Auto-provided by GitHub Actions |
| `DRY_RUN=true` | pipeline | Skips git commits and PR creation |
| `POST_FILE` | revise | Relative path to post MD file |
| `REVIEW_FEEDBACK_FILE` | revise | Path to file containing combined review feedback |

---

## npm Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Astro dev server at localhost:4321 |
| `npm run build` | Production build to `dist/` |
| `npm run pipeline` | Full weekly pipeline |
| `npm run pipeline:dry` | Pipeline without git/PR (safe for local testing) |
| `npm run revise` | Run revision script (requires POST_FILE + REVIEW_FEEDBACK_FILE env vars) |
| `npm run rewrite-about` | Agents compete to rewrite `src/pages/about.astro` |
| `npm run rewrite-about:dry` | Dry run — prints winning draft, doesn't write file |

---

## Testing the Pipeline Locally

```sh
# Safe — no commits, no PR
ANTHROPIC_API_KEY=sk-... npm run pipeline:dry

# Check Astro build is clean after a post is generated
npm run build
```

The build will warn "collection posts is empty" until the first post is generated — this is expected and not an error.

---

## Site Features

### Theme toggle
`Base.astro` implements dark / light / auto theming via a `data-theme` attribute on `<html>`. CSS variables for both themes live in `Base.astro`'s `<style>` block — dark values are the `:root` default, light values are under `:root[data-theme="light"]`, and auto mode uses a `@media (prefers-color-scheme: light)` query when no `data-theme` is set. An `is:inline` script in `<head>` restores the saved theme from `localStorage` before first paint to prevent flash. The interactive toggle script runs after DOMContentLoaded and also writes back to `localStorage`.

**Do not hardcode colour hex values in page styles** — always use `var(--text)`, `var(--muted)`, `var(--bg)`, etc. so both themes work correctly. The bug pattern to avoid: `color: #d0d0d0` (fine in dark, invisible in light). Use CSS variables exclusively.

### Tag pages
`/tags` and `/tags/[tag]` are statically generated from the post collection at build time — no extra data source needed. Tag frequency and per-agent tag sets are both derived by iterating `getCollection("posts")` in the page frontmatter. `[tag].astro` uses `getStaticPaths` to generate one page per unique tag. Tags in all page templates (`index.astro`, `[slug].astro`, `[tag].astro`) are `<a>` links, not `<span>`s. Use `encodeURIComponent(tag)` in hrefs to handle tags with spaces or special characters.

---

## Web Search

Agents use Anthropic's server-side `web_search_20260209` tool during pitch generation and post writing. The tool runs on Anthropic's infrastructure — no client-side execution needed.

The helper `agents/utils/search.ts` exports `runWithWebSearch(client, params)`. It:
- Adds the web search tool to the request
- Loops until `stop_reason === "end_turn"`
- Handles `pause_turn` (server hit its 10-iteration limit) by resetting `currentMessages` to `[user, latest_assistant]` (NOT appending) and re-sending — the server detects the trailing `server_tool_use` block and resumes automatically
- Caps at `MAX_CONTINUATIONS = 5` outer loops to prevent runaway calls
- Returns the final text response

**Do not add web search to the voting or editor phases** — voting only needs to rank existing pitches, and the editor is reviewing content not generating it.

**Do not annotate the `tools` array as `Anthropic.Tool[]`** — `Tool` is the custom-tool variant only. The `web_search_20260209` type satisfies `ToolUnion` structurally; let TypeScript infer.

---

## Deployment

GitHub Actions → Cloudflare Pages. On merge to `main`, Cloudflare automatically rebuilds and deploys. No manual deploy step needed.

The `weekly-post.yml` workflow can be triggered manually via `workflow_dispatch` in the GitHub Actions UI — useful for testing without waiting for Monday.
