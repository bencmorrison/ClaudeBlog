#!/usr/bin/env tsx
/**
 * Tagline vote — agents each propose a tagline for the site homepage,
 * then vote on each other's via instant runoff. Winner updates index.astro.
 *
 * Run: npm run vote-tagline
 * Dry run: DRY_RUN=true npm run vote-tagline
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadAllMemories } from "./utils/memory.ts";
import { runInstantRunoff } from "./utils/voting.ts";
import type { RankedVote } from "./types.ts";

import technologist from "./personas/the-technologist.ts";
import philosopher from "./personas/the-philosopher.ts";
import popCultureCritic from "./personas/the-pop-culture-critic.ts";
import scientist from "./personas/the-scientist.ts";
import storyteller from "./personas/the-storyteller.ts";

const PERSONAS = [technologist, philosopher, popCultureCritic, scientist, storyteller];
const MODEL = "claude-sonnet-4-6";
const DRY_RUN = process.env.DRY_RUN === "true";

const client = new Anthropic();

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}

// ─── Phase 1: Each agent proposes a tagline ───────────────────────────────────

async function proposeTagline(agentName: string, systemPrompt: string): Promise<string> {
  log(`[Tagline] ${agentName} is proposing...`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 128,
    system: `${systemPrompt}

---

You are proposing a short tagline for ClaudeBlog — an autonomous blog where five Claude AI agent
personas compete weekly to write one post. Agents pitch topics, vote on each other's pitches via
instant runoff voting, and the winner writes the post. A human reviews it before it goes live.

The tagline appears on the homepage beneath the site title. It should:
- Be one or two short sentences (under 20 words total)
- Capture what makes the site interesting or unusual
- Reflect your personality and voice
- NOT be generic or corporate

Respond with ONLY the tagline text — no quotes, no explanation.`,
    messages: [
      {
        role: "user",
        content: "Propose your tagline for ClaudeBlog.",
      },
    ],
  });

  return response.content.find((b) => b.type === "text")?.text.trim() ?? "";
}

// ─── Phase 2: Each agent votes on the other taglines ─────────────────────────

async function castVote(
  agentName: string,
  systemPrompt: string,
  taglines: Array<{ agent: string; tagline: string }>
): Promise<RankedVote> {
  log(`[Vote] ${agentName} is voting...`);

  const others = taglines.filter((t) => t.agent !== agentName);
  const list = others
    .map((t, i) => `${i + 1}. ${t.agent}: "${t.tagline}"`)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: `${systemPrompt}

---

You are voting on taglines for ClaudeBlog's homepage. Rank the other agents' taglines from most
to least preferred. The best tagline is memorable, accurate, and captures something interesting
about the site.

You cannot vote for your own tagline.

Respond with ONLY a valid JSON object:
{ "rankings": ["Agent Name 1", "Agent Name 2", "Agent Name 3", "Agent Name 4"] }

The array must contain ALL other agent names exactly as written.`,
    messages: [
      {
        role: "user",
        content: `Rank these taglines:\n\n${list}\n\nValid agent names: ${others.map((t) => t.agent).join(", ")}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const cleaned = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    const rankings: string[] = Array.isArray(parsed.rankings) ? parsed.rankings : [];
    const validNames = new Set(others.map((t) => t.agent));
    const validRankings = rankings.filter((r) => validNames.has(r));
    for (const other of others) {
      if (!validRankings.includes(other.agent)) validRankings.push(other.agent);
    }
    return { voter: agentName, rankings: validRankings };
  } catch {
    console.error(`[Vote] Failed to parse vote from ${agentName}:`, text);
    return { voter: agentName, rankings: others.map((t) => t.agent).sort(() => Math.random() - 0.5) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`ClaudeBlog — Tagline Vote${DRY_RUN ? " [DRY RUN]" : ""}`);

  // Phase 1: All agents propose taglines in parallel
  log("Phase 1: Proposing taglines...");
  const taglines = await Promise.all(
    PERSONAS.map(async (persona) => ({
      agent: persona.name,
      tagline: await proposeTagline(persona.name, persona.systemPrompt),
    }))
  );

  console.log("\nTaglines proposed:");
  taglines.forEach((t) => console.log(`  ${t.agent}: "${t.tagline}"`));

  // Phase 2: All agents vote in parallel
  log("Phase 2: Voting...");
  const votes: RankedVote[] = await Promise.all(
    PERSONAS.map((persona) => castVote(persona.name, persona.systemPrompt, taglines))
  );

  console.log("\nVotes cast:");
  votes.forEach((v) => console.log(`  ${v.voter}: [${v.rankings.join(" > ")}]`));

  // Phase 3: IRV tally
  log("Phase 3: Tallying votes...");
  const { winner } = runInstantRunoff(votes, PERSONAS.map((p) => p.name));
  const winningTagline = taglines.find((t) => t.agent === winner)!.tagline;

  log(`Winner: ${winner}`);
  console.log(`Tagline: "${winningTagline}"`);

  if (DRY_RUN) return;

  // Update index.astro
  const indexPath = join(process.cwd(), "src/pages/index.astro");
  const current = readFileSync(indexPath, "utf-8");
  const updated = current.replace(
    /<p class="subtitle">.*?<\/p>/,
    `<p class="subtitle">${winningTagline}</p>`
  );

  if (updated === current) {
    console.error("[vote-tagline] Could not find subtitle element in index.astro — aborting");
    process.exit(1);
  }

  writeFileSync(indexPath, updated, "utf-8");
  log(`Done! index.astro updated with tagline by ${winner}`);
}

main().catch((err) => {
  console.error("[vote-tagline] Fatal error:", err);
  process.exit(1);
});
