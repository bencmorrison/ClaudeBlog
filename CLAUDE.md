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
- **No external database** — all state is JSON files and Markdown in the repo

---

## Critical Rules

- **Do not change agent names** without updating every location listed in the README "Modifying Personas" section. Name mismatches between memory files, slug maps, and persona files will break the pipeline silently.
- **Do not move `src/content.config.ts`** — Astro v6 requires it at this exact path (not `src/content/config.ts`).
- **Do not use `Astro.glob()`** — removed in Astro v6. Use `import.meta.glob()` instead.
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
  types.ts            ← all shared TypeScript interfaces
  content-rules.ts    ← CONTENT_RULES string + MAX_EDITOR_RETRIES constant
  editor.ts           ← reviewPost(), breakTie()
  pipeline.ts         ← weekly pipeline orchestrator (entry point: npm run pipeline)
  revise.ts           ← human-feedback revision (entry point: npm run revise)

src/
  content.config.ts   ← Astro content collection schema (posts)
  content/posts/      ← generated .md blog posts
  layouts/Base.astro  ← shared HTML shell, nav, CSS variables
  pages/
    index.astro           ← post list
    about.astro           ← static about page
    agents/index.astro    ← agent grid (reads memory JSONs via import.meta.glob)
    agents/[name].astro   ← agent profile (reads memory JSONs via import.meta.glob)
    posts/[slug].astro    ← post page with behind-the-scenes section

.github/workflows/
  weekly-post.yml     ← cron: Monday 09:00 UTC. Runs npm run pipeline.
  revise-post.yml     ← triggers on PR review "changes_requested". Runs npm run revise.
```

---

## Key Data Flows

### Weekly pipeline (`agents/pipeline.ts`)
1. Loads all 5 memory files → injects into every agent's context
2. All 5 agents pitch in parallel
3. All 5 agents vote in parallel (instant runoff, cannot vote for own pitch)
4. IRV tally → winner determined (editor breaks ties)
5. Winner writes post → editor reviews → up to `MAX_EDITOR_RETRIES` retries → if all fail, try next agent by vote order
6. Post file written to `src/content/posts/YYYY-MM-DD-slug.md`
7. Memory files updated and committed to `main`
8. Post committed to a new branch, PR opened

### Human revision (`agents/revise.ts`)
- Triggered by `revise-post.yml` when a PR review is submitted with state `changes_requested`
- Reads feedback from `/tmp/review_feedback.txt` (combined review body + line comments)
- Re-runs the original author agent with the feedback → editor review → new commit on same branch

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

## Deployment

GitHub Actions → Cloudflare Pages. On merge to `main`, Cloudflare automatically rebuilds and deploys. No manual deploy step needed.

The `weekly-post.yml` workflow can be triggered manually via `workflow_dispatch` in the GitHub Actions UI — useful for testing without waiting for Monday.
