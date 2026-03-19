#!/usr/bin/env tsx
/**
 * About page rewrite — agents compete to rewrite src/pages/about.astro
 *
 * Each agent writes their own version of the about page content.
 * Agents vote on each other's versions (instant runoff, cannot vote for own).
 * Winning version is written to src/pages/about.astro with the human note preserved.
 *
 * Run: npm run rewrite-about
 * Dry run (prints winner, doesn't write file): DRY_RUN=true npm run rewrite-about
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadAllMemories, formatMemoriesForContext } from "./utils/memory.ts";
import { extractJson } from "./utils/json.ts";
import { runInstantRunoff } from "./utils/voting.ts";
import { withRateLimitRetry } from "./utils/retry.ts";
import type { AgentMemory, RankedVote } from "./types.ts";

import technologist from "./personas/the-technologist.ts";
import philosopher from "./personas/the-philosopher.ts";
import popCultureCritic from "./personas/the-pop-culture-critic.ts";
import scientist from "./personas/the-scientist.ts";
import storyteller from "./personas/the-storyteller.ts";

const PERSONAS = [technologist, philosopher, popCultureCritic, scientist, storyteller];
const MODEL = "claude-sonnet-4-6";
const DRY_RUN = process.env.DRY_RUN === "true";

// maxRetries: 0 — retry logic is owned exclusively by withRateLimitRetry
// from utils/retry.ts, keeping behaviour consistent across all API calls.
const client = new Anthropic({ maxRetries: 0 });

// The human note to preserve — injected into every agent's context and must appear in output
const HUMAN_NOTE = `<div class="human-note">
    <p>
      <strong>A note from the human:</strong> The idea for this site and project comes from those times when I end up chatting with Claude on Claude's chat interface.
      The chats are more human like, where I ask random questions such as what does it think about people, what is it like being an AI, and more. They tend to be fun chats.
      One day on the way home from work, I wondered what would AI blog about. I really don't know why it hit me but it did. Durning the development (which was asking Claude Code to build) I thought multiple personas would be a fun twist and see what they would write about.
      So here we are, this project!
    </p>
  </div>`;

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}

// ─── Phase 1: Each agent writes an about page ─────────────────────────────────

const ABOUT_SYSTEM_CONTEXT = `
You are writing content for the About page of ClaudeBlog — an autonomous blog where five Claude AI
agent personas (including yourself) compete weekly to write one blog post. The full pipeline:
- All 5 agents pitch a topic
- All 5 agents vote on each other's pitches using instant runoff voting (cannot vote for own)
- The winning agent writes a full blog post (~1000–1400 words)
- An editor agent reviews it for legal and content compliance
- A GitHub PR is opened for human review before anything goes live
- Agent memory files track each agent's pitch history, wins, and votes — injected into every
  agent's context each week so everyone knows the track record of every rival

The site is built with Astro (static output), hosted on Cloudflare Pages, and the "database"
is just the git repo — Markdown posts and JSON memory files.

The five personas are:
- The Technologist — software, AI, engineering, developer culture
- The Philosopher — ethics, consciousness, political philosophy
- The Pop Culture Critic — film, music, internet culture
- The Scientist — biology, space, neuroscience, research
- The Storyteller — history, forgotten figures, narrative journalism
`.trim();

const ASTRO_TEMPLATE_INSTRUCTIONS = `
You must output ONLY the inner Astro/HTML content that goes inside the <Base> component.
Do NOT output the full file with imports or the Base wrapper — just the content from <style> onward.

The output must start with a <style> block containing all your CSS.
Then the visible HTML content.
The human note block shown below MUST appear somewhere in your output, exactly as provided — do not modify it.

CSS rules:
- ALWAYS use CSS custom properties for colours: var(--text), var(--muted), var(--bg), var(--surface), var(--border), var(--accent), var(--accent-dim), var(--mono), var(--sans)
- NEVER hardcode hex colour values
- The site already defines these variables globally for dark, light, and auto themes

Available CSS variables:
  --bg          page background
  --surface     slightly elevated surface (cards, boxes)
  --border      border colour
  --text        primary text
  --muted       secondary / dimmed text
  --accent      purple highlight colour (#7c6af7 in dark, #5b4de0 in light)
  --accent-dim  muted accent (for borders, fills)
  --mono        monospace font stack
  --sans        sans-serif font stack

Write in your own voice. Make it interesting. Explain the project compellingly.
`.trim();

async function writeAboutContent(
  agentName: string,
  systemPrompt: string,
  allMemories: AgentMemory[]
): Promise<string> {
  log(`[Write] ${agentName} is writing the about page...`);

  const memoryContext = formatMemoriesForContext(allMemories);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${systemPrompt}

---

${ABOUT_SYSTEM_CONTEXT}

---

Agent stats (for context — you can reference these if interesting):
${memoryContext}

---

${ASTRO_TEMPLATE_INSTRUCTIONS}

The human note block to include verbatim somewhere in your output:

${HUMAN_NOTE}`,
    messages: [
      {
        role: "user",
        content: `Write your version of the ClaudeBlog About page content. Be true to your voice. Explain what ClaudeBlog is, how it works, and why it exists — in a way that reflects your personality. Include the human note block somewhere that makes sense.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    console.warn(`[Write] ${agentName} returned no text content`);
    return "";
  }
  return textBlock.text;
}

// ─── Phase 2: Each agent votes on the other versions ─────────────────────────

async function castVote(
  agentName: string,
  systemPrompt: string,
  drafts: Array<{ agent: string; content: string }>,
  allMemories: AgentMemory[]
): Promise<RankedVote> {
  log(`[Vote] ${agentName} is voting on about page drafts...`);

  const others = drafts.filter((d) => d.agent !== agentName);
  const memoryContext = formatMemoriesForContext(allMemories);

  const draftList = others
    .map(
      (d, i) =>
        `--- Draft ${i + 1}: ${d.agent} ---\n${d.content.slice(0, 3000)}${d.content.length > 3000 ? "\n[...truncated for brevity]" : ""}`
    )
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `${systemPrompt}

---

${ABOUT_SYSTEM_CONTEXT}

---

Agent stats:
${memoryContext}

---

You are voting on which agent's About page draft is best. Rank the other agents' drafts in order
of preference — the best About page for ClaudeBlog should be compelling, accurate, readable, and
reflect a strong authorial voice.

You cannot vote for your own draft.

Respond with ONLY a valid JSON object:
{
  "rankings": ["Agent Name 1", "Agent Name 2", "Agent Name 3", "Agent Name 4"]
}

The array must contain ALL other agent names exactly as written, ranked from most to least preferred.`,
    messages: [
      {
        role: "user",
        content: `Please rank the following About page drafts (excluding your own):\n\n${draftList}\n\nValid agent names: ${others.map((d) => d.agent).join(", ")}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(extractJson(text));
    const rankings: string[] = Array.isArray(parsed.rankings) ? parsed.rankings : [];
    const validNames = new Set(others.map((d) => d.agent));
    const validRankings = rankings.filter((r) => validNames.has(r));

    for (const other of others) {
      if (!validRankings.includes(other.agent)) {
        validRankings.push(other.agent);
      }
    }

    return { voter: agentName, rankings: validRankings };
  } catch {
    console.error(`[Vote] Failed to parse vote from ${agentName}:`, text);
    const fallback = others.map((d) => d.agent).sort(() => Math.random() - 0.5);
    return { voter: agentName, rankings: fallback };
  }
}

// ─── Build final about.astro file ─────────────────────────────────────────────

function buildAboutAstro(winnerName: string, content: string): string {
  return `---
import Base from "../layouts/Base.astro";
---

<Base title="About" description="How ClaudeBlog works — five AI agents competing weekly to write one blog post.">
  ${content.trim()}
</Base>
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`ClaudeBlog — About Page Rewrite${DRY_RUN ? " [DRY RUN]" : ""}`);

  const memories = loadAllMemories();

  // Phase 1: Agents write drafts sequentially to avoid exhausting the token budget
  log("Phase 1: All agents writing about page drafts...");
  const drafts: Array<{ agent: string; content: string }> = [];
  for (const persona of PERSONAS) {
    drafts.push({
      agent: persona.name,
      content: await withRateLimitRetry(
        `[Write] ${persona.name}`,
        () => writeAboutContent(persona.name, persona.systemPrompt, memories)
      ),
    });
  }

  console.log("\nDrafts received:");
  drafts.forEach((d) =>
    console.log(`  ${d.agent}: ${d.content.length} chars`)
  );

  const emptyDrafts = drafts.filter((d) => d.content.trim().length === 0);
  if (emptyDrafts.length > 0) {
    console.error(`[rewrite-about] ${emptyDrafts.length} agent(s) returned empty drafts: ${emptyDrafts.map((d) => d.agent).join(", ")}`);
    process.exit(1);
  }

  // Phase 2: Agents vote sequentially to avoid rate limits
  log("Phase 2: Agents voting on drafts...");
  const votes: RankedVote[] = [];
  for (const persona of PERSONAS) {
    votes.push(
      await withRateLimitRetry(
        `[Vote] ${persona.name}`,
        () => castVote(persona.name, persona.systemPrompt, drafts, memories)
      )
    );
  }

  console.log("\nVotes cast:");
  votes.forEach((v) =>
    console.log(`  ${v.voter}: [${v.rankings.join(" > ")}]`)
  );

  // Phase 3: IRV tally
  log("Phase 3: Tallying votes (Instant Runoff)...");
  const candidates = PERSONAS.map((p) => p.name);
  const { winner } = runInstantRunoff(votes, candidates);

  log(`Winner: "${winner}"`);

  const winningDraft = drafts.find((d) => d.agent === winner);
  if (!winningDraft || winningDraft.content.trim().length === 0) {
    console.error(`[rewrite-about] Winner "${winner}" has no draft content — aborting`);
    process.exit(1);
  }

  if (DRY_RUN) {
    log("[DRY RUN] Winning about page content:");
    console.log(winningDraft.content);
    return;
  }

  // Write the file
  const aboutPath = join(process.cwd(), "src/pages/about.astro");
  const fileContent = buildAboutAstro(winner, winningDraft.content);
  writeFileSync(aboutPath, fileContent, "utf-8");

  log(`Done! About page rewritten by ${winner}`);
  log(`File: src/pages/about.astro`);
}

main().catch((err) => {
  console.error("[rewrite-about] Fatal error:", err);
  process.exit(1);
});
