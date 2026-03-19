#!/usr/bin/env tsx
/**
 * ClaudeBlog Weekly Pipeline
 *
 * Run locally:   npm run pipeline
 * Dry run:       npm run pipeline:dry
 *
 * Requires: ANTHROPIC_API_KEY env var
 *           GITHUB_TOKEN + GITHUB_REPO env vars for PR creation (skip in dry run)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { reviewPost, breakTie } from "./editor.ts";
import { MAX_EDITOR_RETRIES } from "./content-rules.ts";
import {
  loadAllMemories,
  saveMemory,
  formatMemoriesForContext,
} from "./utils/memory.ts";
import { runInstantRunoff } from "./utils/voting.ts";
import { buildPostSlug } from "./utils/slugify.ts";
import type {
  AgentMemory,
  Pitch,
  RankedVote,
  VoteTally,
  PostFrontmatter,
} from "./types.ts";

// ─── Persona imports ────────────────────────────────────────────────────────
import technologist from "./personas/the-technologist.ts";
import philosopher from "./personas/the-philosopher.ts";
import popCultureCritic from "./personas/the-pop-culture-critic.ts";
import scientist from "./personas/the-scientist.ts";
import storyteller from "./personas/the-storyteller.ts";

const PERSONAS = [
  technologist,
  philosopher,
  popCultureCritic,
  scientist,
  storyteller,
];

const MODEL = "claude-sonnet-4-6";
const DRY_RUN = process.env.DRY_RUN === "true";

const client = new Anthropic();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}

// ─── Phase 1: Pitch generation ───────────────────────────────────────────────

async function generatePitch(
  agentName: string,
  systemPrompt: string,
  allMemories: AgentMemory[]
): Promise<Pitch> {
  log(`[Pitch] ${agentName} is pitching...`);

  const memoryContext = formatMemoriesForContext(allMemories);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `${systemPrompt}

---

You are participating in a weekly blog competition. All agents' current stats are shown below.
Use this context to inform your pitch — avoid topics already covered recently, and consider
what angle will appeal to the other agents who will vote on your pitch.

${memoryContext}

---

Respond with ONLY a valid JSON object in this exact format:
{
  "title": "Your pitch title",
  "summary": "2–3 sentences describing the post and why it would be interesting."
}`,
    messages: [
      {
        role: "user",
        content: `It is ${todayISO()}. Please pitch a topic for this week's blog post. Remember: the other agents will vote on your pitch, so make it compelling. Stay true to your style and interests.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const cleaned = text
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      agent: agentName,
      title: parsed.title ?? "Untitled",
      summary: parsed.summary ?? "",
    };
  } catch {
    console.error(`[Pitch] Failed to parse pitch from ${agentName}:`, text);
    return {
      agent: agentName,
      title: `A post by ${agentName}`,
      summary: "No summary available.",
    };
  }
}

// ─── Phase 2: Voting ──────────────────────────────────────────────────────────

async function castVote(
  agentName: string,
  systemPrompt: string,
  pitches: Pitch[],
  allMemories: AgentMemory[]
): Promise<RankedVote> {
  log(`[Vote] ${agentName} is voting...`);

  const others = pitches.filter((p) => p.agent !== agentName);
  const memoryContext = formatMemoriesForContext(allMemories);

  const pitchList = others
    .map((p, i) => `${i + 1}. **${p.agent}**: "${p.title}" — ${p.summary}`)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

You are voting on this week's blog pitches. Rank the other agents' pitches in order of preference
(1st = most preferred). You cannot vote for your own pitch.

Respond with ONLY a valid JSON object:
{
  "rankings": ["Agent Name 1", "Agent Name 2", "Agent Name 3", "Agent Name 4"]
}

The array must contain ALL other agent names exactly as written, ranked from most to least preferred.`,
    messages: [
      {
        role: "user",
        content: `Please rank the following pitches (excluding your own):\n\n${pitchList}\n\nValid agent names to use: ${others.map((p) => p.agent).join(", ")}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const cleaned = text
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const rankings: string[] = Array.isArray(parsed.rankings)
      ? parsed.rankings
      : [];

    // Validate all ranked names are valid other agents
    const validNames = new Set(others.map((p) => p.agent));
    const validRankings = rankings.filter((r) => validNames.has(r));

    // Append any missing agents at the end (in case the model missed some)
    for (const other of others) {
      if (!validRankings.includes(other.agent)) {
        validRankings.push(other.agent);
      }
    }

    return { voter: agentName, rankings: validRankings };
  } catch {
    console.error(`[Vote] Failed to parse vote from ${agentName}:`, text);
    // Fallback: random order of others
    const fallback = others.map((p) => p.agent).sort(() => Math.random() - 0.5);
    return { voter: agentName, rankings: fallback };
  }
}

// ─── Phase 4: Post writing ────────────────────────────────────────────────────

async function writePost(
  agentName: string,
  systemPrompt: string,
  pitch: Pitch,
  allMemories: AgentMemory[],
  feedback?: string
): Promise<string> {
  log(`[Write] ${agentName} is writing the post...`);

  const memoryContext = formatMemoriesForContext(allMemories);
  const feedbackSection = feedback
    ? `\n\nPrevious attempt was rejected by the Editor with this feedback:\n${feedback}\nPlease address these issues in your rewrite.`
    : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

You have won this week's pitch competition with your topic: "${pitch.title}"

Write a full blog post based on your pitch. Requirements:
- Target length: 1000–1400 words (~5–7 minute read)
- Write in Markdown format (use ## for section headings, **bold**, etc.)
- Do NOT include frontmatter — just the body content starting with the title as an H1
- Stay true to your writing persona's voice and style
- The post must be original, engaging, and meet Australian publication standards${feedbackSection}`,
    messages: [
      {
        role: "user",
        content: `Write your blog post for the topic: "${pitch.title}"\n\nYour pitch summary was: ${pitch.summary}`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

// ─── Frontmatter builder ──────────────────────────────────────────────────────

function buildFrontmatter(data: PostFrontmatter): string {
  const tagsYaml = data.tags.map((t) => `  - "${t}"`).join("\n");
  const votesYaml = data.votes
    .map((v) => `  - voter: "${v.voter}"\n    votedFor: "${v.votedFor}"`)
    .join("\n");
  const pitchesYaml = data.pitches
    .map(
      (p) =>
        `  - agent: "${p.agent}"\n    title: "${p.title.replace(/"/g, '\\"')}"\n    summary: "${p.summary.replace(/"/g, '\\"')}"`
    )
    .join("\n");

  return `---
title: "${data.title.replace(/"/g, '\\"')}"
date: ${data.date}
author: "${data.author}"
tags:
${tagsYaml}
pitch: "${data.pitch.replace(/"/g, '\\"')}"
votes:
${votesYaml}
pitches:
${pitchesYaml}
---

`;
}

// ─── Memory updater ───────────────────────────────────────────────────────────

function updateMemories(
  memories: AgentMemory[],
  pitches: Pitch[],
  finalTally: VoteTally[],
  winner: string,
  postSlug: string,
  date: string,
  editorSoftFlags: string[] = []
): void {
  const voteCounts = new Map<string, number>();
  for (const t of finalTally) {
    voteCounts.set(t.votedFor, (voteCounts.get(t.votedFor) ?? 0) + 1);
  }

  for (const memory of memories) {
    const myPitch = pitches.find((p) => p.agent === memory.name);
    if (!myPitch) continue;

    const votesReceived = voteCounts.get(memory.name) ?? 0;
    const won = memory.name === winner;

    memory.totalPitches += 1;
    memory.totalVotesReceived += votesReceived;
    if (won) memory.totalWins += 1;

    memory.pitchHistory.push({
      date,
      title: myPitch.title,
      summary: myPitch.summary,
      votesReceived,
      won,
      ...(won && editorSoftFlags.length > 0
        ? { editorNotes: editorSoftFlags.join("; ") }
        : {}),
    });

    if (won) {
      memory.posts.push({
        date,
        slug: postSlug,
        title: myPitch.title,
      });

      // Extract broad topic tags from pitch title/summary (simple keyword extraction)
      const combined = `${myPitch.title} ${myPitch.summary}`.toLowerCase();
      const topicKeywords = [
        "ai", "space", "music", "film", "climate", "history", "philosophy",
        "biology", "tech", "politics", "health", "psychology", "culture",
        "science", "society", "internet", "gaming", "language", "ethics",
      ];
      for (const kw of topicKeywords) {
        if (combined.includes(kw) && !memory.topicsCovered.includes(kw)) {
          memory.topicsCovered.push(kw);
        }
      }
    }

    saveMemory(memory);
  }
}

// ─── GitHub PR creation ───────────────────────────────────────────────────────

async function createPR(postPath: string, title: string, date: string): Promise<void> {
  if (DRY_RUN) {
    log("[PR] DRY RUN — skipping PR creation");
    return;
  }

  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    console.warn("[PR] GITHUB_REPO not set — skipping PR creation");
    return;
  }

  const branchName = `post/${date}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    execSync(`git checkout -b ${branchName}`, { stdio: "inherit" });
    execSync(`git add "${postPath}"`, { stdio: "inherit" });
    execSync(
      `git commit -m "feat: add blog post — ${title} [${date}]"`,
      { stdio: "inherit" }
    );
    execSync(`git push origin ${branchName}`, { stdio: "inherit" });
    execSync(
      `gh pr create --title "Blog post: ${title}" --body "Automated weekly blog post generated by the ClaudeBlog pipeline. Review content before merging." --base main --head ${branchName}`,
      { stdio: "inherit" }
    );
    log(`[PR] Pull request created for branch ${branchName}`);
  } catch (err) {
    console.error("[PR] Error creating PR:", err);
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main() {
  const date = todayISO();
  log(`ClaudeBlog Pipeline — ${date}${DRY_RUN ? " [DRY RUN]" : ""}`);

  // Load all memories
  const memories = loadAllMemories();

  // ── Phase 1: Generate pitches ────────────────────────────────────────────
  log("Phase 1: Generating pitches...");
  const pitches: Pitch[] = await Promise.all(
    PERSONAS.map((persona) =>
      generatePitch(persona.name, persona.systemPrompt, memories)
    )
  );

  console.log("\nPitches received:");
  pitches.forEach((p) =>
    console.log(`  ${p.agent}: "${p.title}" — ${p.summary}`)
  );

  // ── Phase 2: Cast votes ──────────────────────────────────────────────────
  log("Phase 2: Casting votes...");
  const votes: RankedVote[] = await Promise.all(
    PERSONAS.map((persona) =>
      castVote(persona.name, persona.systemPrompt, pitches, memories)
    )
  );

  console.log("\nVotes cast:");
  votes.forEach((v) =>
    console.log(`  ${v.voter}: [${v.rankings.join(" > ")}]`)
  );

  // ── Phase 3: Tally votes ─────────────────────────────────────────────────
  log("Phase 3: Tallying votes (Instant Runoff)...");
  const candidates = PERSONAS.map((p) => p.name);
  let { winner, finalTally } = runInstantRunoff(votes, candidates);

  // Check for genuine tie (shouldn't happen with IRV but handle edge case)
  const winnerCount = finalTally.filter((t) => t.votedFor === winner).length;
  const tiedCandidates = [...new Set(
    [...finalTally
      .filter((t) => finalTally.filter((x) => x.votedFor === t.votedFor).length === winnerCount)
      .map((t) => t.votedFor)]
  )];

  if (tiedCandidates.length > 1) {
    log(`[Tally] Tie detected between: ${tiedCandidates.join(", ")} — Editor breaks tie`);
    winner = await breakTie(tiedCandidates, pitches);
  }

  log(`Phase 3 result: Winner is "${winner}"`);

  // ── Phase 4 + 5: Write post with editor review ───────────────────────────
  log("Phase 4: Writing post...");
  const winnerPersona = PERSONAS.find((p) => p.name === winner)!;
  const winningPitch = pitches.find((p) => p.agent === winner)!;

  let postContent = "";
  let approved = false;
  let editorFeedback: string | undefined;
  let editorSoftFlags: string[] = [];
  let currentWriter = winner;
  let currentPersona = winnerPersona;
  let currentPitch = winningPitch;

  // Track which agents have been tried (winner first, then runner-up if all retries exhausted)
  const agentOrder = [winner, ...candidates.filter((c) => c !== winner)];
  let agentIndex = 0;

  while (!approved && agentIndex < agentOrder.length) {
    const writerName = agentOrder[agentIndex];
    const writerPersona = PERSONAS.find((p) => p.name === writerName)!;
    const writerPitch = pitches.find((p) => p.agent === writerName)!;

    for (let attempt = 1; attempt <= MAX_EDITOR_RETRIES + 1; attempt++) {
      postContent = await writePost(
        writerName,
        writerPersona.systemPrompt,
        writerPitch,
        memories,
        attempt > 1 ? editorFeedback : undefined
      );

      const decision = await reviewPost(postContent, writerName, attempt);

      if (decision.approved) {
        approved = true;
        currentWriter = writerName;
        currentPersona = writerPersona;
        currentPitch = writerPitch;
        editorSoftFlags = decision.softFlags;
        if (editorSoftFlags.length > 0) {
          console.warn(`[Editor] Approved with soft flags: ${editorSoftFlags.join("; ")}`);
        }
        log(`[Editor] Post approved from ${writerName} on attempt ${attempt}`);
        break;
      } else {
        editorFeedback = decision.revisedContent ?? decision.issues.join("; ");
        console.warn(
          `[Editor] Rejected (attempt ${attempt}/${MAX_EDITOR_RETRIES + 1}): ${decision.issues.join(", ")}`
        );
        if (attempt === MAX_EDITOR_RETRIES + 1) {
          console.warn(
            `[Editor] All retries exhausted for ${writerName}. Trying next agent...`
          );
        }
      }
    }

    if (!approved) agentIndex++;
  }

  if (!approved) {
    console.error("[Pipeline] All agents failed editor review. Aborting.");
    process.exit(1);
  }

  // ── Build post file ──────────────────────────────────────────────────────
  log("Phase 6: Building post file...");

  // Extract title from the post content (first H1)
  const titleMatch = postContent.match(/^#\s+(.+)$/m);
  const postTitle = titleMatch ? titleMatch[1].trim() : currentPitch.title;

  // Simple tag extraction from pitch
  const tagKeywords = [
    "AI", "technology", "philosophy", "science", "culture", "history",
    "film", "music", "biology", "space", "psychology", "ethics", "society",
  ];
  const combined = `${currentPitch.title} ${currentPitch.summary}`.toLowerCase();
  const tags = tagKeywords.filter((t) => combined.includes(t.toLowerCase()));
  if (tags.length === 0) tags.push("general");

  const frontmatter: PostFrontmatter = {
    title: postTitle,
    date,
    author: currentWriter,
    tags,
    pitch: currentPitch.summary,
    votes: finalTally.map((t) => ({ voter: t.voter, votedFor: t.votedFor })),
    pitches,
  };

  const postSlug = buildPostSlug(date, postTitle);
  const postFilename = `${postSlug}.md`;
  const postPath = join(process.cwd(), "src/content/posts", postFilename);
  const fullPost = buildFrontmatter(frontmatter) + postContent;

  writeFileSync(postPath, fullPost, "utf-8");
  log(`[File] Post saved to: src/content/posts/${postFilename}`);

  // ── Update memories (commit directly to main) ────────────────────────────
  log("Updating agent memory files...");
  updateMemories(memories, pitches, finalTally, currentWriter, postSlug, date, editorSoftFlags);

  if (!DRY_RUN) {
    try {
      execSync("git add agents/memory/", { stdio: "inherit" });
      execSync(
        `git commit -m "chore: update agent memories [${date}]"`,
        { stdio: "inherit" }
      );
      execSync("git push origin main", { stdio: "inherit" });
      log("[Memory] Memory files committed to main");
    } catch (err) {
      console.warn("[Memory] Could not commit memory files:", err);
    }
  }

  // ── Create PR for the post ────────────────────────────────────────────────
  await createPR(postPath, postTitle, date);

  log(`Pipeline complete! Post: "${postTitle}" by ${currentWriter}`);
  log(`File: src/content/posts/${postFilename}`);
}

main().catch((err) => {
  console.error("[Pipeline] Fatal error:", err);
  process.exit(1);
});
