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
import { reviewPost, breakTie, screenPitchCurrency } from "./editor.ts";
import { factCheckPost } from "./fact-checker.ts";
import { MAX_EDITOR_RETRIES } from "./content-rules.ts";
import {
  loadAllMemories,
  saveMemory,
  formatMemoriesForContext,
  getConsecutiveWins,
  loadFactCheckerMemory,
  saveFactCheckerMemory,
} from "./utils/memory.ts";
import { runInstantRunoff } from "./utils/voting.ts";
import { buildPostSlug } from "./utils/slugify.ts";
import { runWithWebSearch } from "./utils/search.ts";
import { extractJson } from "./utils/json.ts";
import { withRateLimitRetry, sleep } from "./utils/retry.ts";
import { yamlEscapeInline } from "./utils/yaml.ts";
import { TAG_KEYWORDS, TOPIC_KEYWORDS, matchKeywords } from "./utils/keywords.ts";
import type {
  AgentMemory,
  PersonaConfig,
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

// maxRetries: 0 — disable SDK auto-retry so withRateLimitRetry owns all retry
// logic exclusively. With SDK default (2), each call is actually 3 attempts,
// making withRateLimitRetry's maxRetries=5 result in up to 15 total requests.
const client = new Anthropic({ maxRetries: 0 });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  // The cron fires Sunday 21:00 UTC, which is Monday morning AEST — date the
  // post in Sydney time so it matches publication day, not the UTC calendar.
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}



// ─── Phase 1: Pitch generation ───────────────────────────────────────────────

async function generatePitch(
  agentName: string,
  systemPrompt: string,
  allMemories: AgentMemory[],
  formatFeedback?: string,
  extraGuidance?: string
): Promise<Pitch> {
  log(`[Pitch] ${agentName} is pitching...`);

  const memoryContext = formatMemoriesForContext(allMemories);
  const baseContext = `${systemPrompt}

---

You are participating in a weekly blog competition. All agents' current stats are shown below.
Use this context to inform your pitch — avoid topics already covered recently, and consider
what angle will appeal to the other agents who will vote on your pitch.

${memoryContext}`;

  const currentnessRules = `Your pitch must be about something current — a recent event, release,
study, controversy, or development that is itself the subject of the post.

**Important:** A current anniversary or historical milestone is not sufficient. Do not use a recent
date as a pretext to write a retrospective about the past. The post should engage directly with
what is happening *now* — new information, ongoing debates, fresh developments, live consequences.
Ask yourself: would this post be meaningfully different if written six months ago? If yes, it's
not current enough.

The blog's goal is to attract readers. Pitch something with broad appeal and a compelling hook —
not just what interests you personally, but what would make someone click, read to the end, and
share it.`;

  // Extra guidance is set on re-pitches after a failed currency screen — it must
  // reach both the research and pitch phases so the new search avoids the same trap.
  const guidanceBlock = extraGuidance ? `\n\n---\n\n${extraGuidance}` : "";

  // ── Phase A: Research (web search) ───────────────────────────────────────────
  // Separating research from JSON output mirrors the post-writing pattern. Combining
  // both jobs in one agentic loop causes the model to exhaust its search iterations
  // and output a planning note at end_turn instead of the required JSON.
  const researchSystem = `${baseContext}

---

${currentnessRules}

Use web search to find 2–3 strong candidate topics from the past 1–2 weeks in your domain.
Return ONLY a bullet-point list of candidates with: the topic, why it's current, and why it
would appeal to readers. Do not output JSON yet — that comes next.${guidanceBlock}`;

  let researchSummary = "";
  try {
    researchSummary = await runWithWebSearch(client, {
      model: MODEL,
      max_tokens: 1024,
      system: researchSystem,
      userMessage: `It is ${todayISO()}. Search for recent news and developments in your domain from the past 1–2 weeks. Return a bullet-point list of 2–3 strong pitch candidates with the topic, why it's current, and why readers would care.`,
    });
    if (researchSummary) {
      log(`[Pitch] ${agentName} research complete (${researchSummary.length} chars)`);
    }
  } catch (err) {
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) throw err;
    console.warn(`[Pitch] Web search failed for ${agentName}, proceeding without research:`, err);
  }

  // ── Phase B: Select and format pitch (no tools) ───────────────────────────────
  const pitchSystem = `${baseContext}

---

${currentnessRules}

Respond with ONLY a valid JSON object in this exact format:
{
  "title": "Your pitch title",
  "summary": "2–3 sentences describing the post and why it would be interesting."
}${guidanceBlock}`;

  const baseMessage = researchSummary
    ? `Here are the topics you researched:\n\n${researchSummary}\n\n---\n\nIt is ${todayISO()}. Choose the strongest candidate and output your pitch as a JSON object. Stay true to your style — remember the other agents will vote on it.`
    : `It is ${todayISO()}. Based on your knowledge of recent events in your domain, output your pitch as a JSON object. Stay true to your style — remember the other agents will vote on it.`;

  const pitchMessage = formatFeedback
    ? `${formatFeedback}\n\n${baseMessage}`
    : baseMessage;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: pitchSystem,
    messages: [{ role: "user", content: pitchMessage }],
  });
  const text = resp.content.find((b) => b.type === "text")?.text ?? "{}";

  // Extract JSON from anywhere in the response
  const jsonStr = extractJson(text);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(`[Pitch] Failed to parse JSON from ${agentName}.\nRaw response:\n${text}`);
    throw new Error(`JSON parse failed for ${agentName}`);
  }

  const titleRaw = parsed.title;
  const summaryRaw = parsed.summary;
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  const summary = typeof summaryRaw === "string" ? summaryRaw.trim() : "";

  if (title.length < 10 || summary.length < 10) {
    console.error(
      `[Pitch] ${agentName} returned a bad pitch (title: "${title}", summary length: ${summary.length}).\nRaw response:\n${text}`
    );
    throw new Error(`Bad pitch format from ${agentName}`);
  }

  return { agent: agentName, title, summary };
}

// ─── Phase 2: Voting ──────────────────────────────────────────────────────────

async function castVote(
  persona: PersonaConfig,
  pitches: Pitch[]
): Promise<RankedVote> {
  const agentName = persona.name;
  log(`[Vote] ${agentName} is voting...`);

  const others = pitches.filter((p) => p.agent !== agentName);

  // Anonymized ballot: pitches are numbered with no author attribution, so votes
  // are cast on content rather than an agent's brand or track record. Variety in
  // authorship is enforced mechanically by the recency penalty in Phase 3 — it is
  // deliberately NOT a voting criterion.
  const pitchList = others
    .map((p, i) => `${i + 1}. "${p.title}" — ${p.summary}`)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `${persona.systemPrompt}

---

You are voting on this week's blog pitches. The pitches are presented anonymously — judge them
on content alone. Your own pitch is not in the list. Rank them in order of preference
(1st = most preferred).

Your editorial perspective when voting:
${persona.votingPerspective}

Alongside that perspective, weigh:
- **Genuine currency** — is the current event the actual subject, not just a pretext? Pitches that use an anniversary or milestone as a hook for a historical retrospective should rank lower than pitches genuinely engaging with something happening now.
- **Broad appeal** — will this interest readers beyond a niche audience?
- **Quality potential** — does the angle lend itself to a well-researched, substantive post?
- **View-worthiness** — would someone share or recommend this? Does it have a compelling hook?

Let your editorial perspective genuinely shape the order — do not default to whichever pitch
feels most emotionally affecting or universally pleasant.

Respond with ONLY a valid JSON object:
{
  "rankings": [3, 1, 4, 2]
}

The array must contain the number of EVERY pitch exactly once, ranked from most to least preferred.`,
    messages: [
      {
        role: "user",
        content: `Please rank the following pitches:\n\n${pitchList}\n\nValid pitch numbers: 1–${others.length}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(extractJson(text));
    const rawRankings: unknown[] = Array.isArray(parsed.rankings)
      ? parsed.rankings
      : [];

    // Map pitch numbers back to agent names, dropping invalid or duplicate entries
    const validRankings: string[] = [];
    for (const r of rawRankings) {
      const n = typeof r === "number" ? r : parseInt(String(r), 10);
      if (!Number.isInteger(n) || n < 1 || n > others.length) continue;
      const agent = others[n - 1].agent;
      if (!validRankings.includes(agent)) validRankings.push(agent);
    }

    // Append any missing agents at the end (in case the model missed some)
    for (const other of others) {
      if (!validRankings.includes(other.agent)) {
        validRankings.push(other.agent);
      }
    }

    return { voter: agentName, rankings: validRankings };
  } catch {
    console.error(`[Vote] Failed to parse vote from ${agentName}:`, text);
    // Fallback: uniform random order via Fisher-Yates shuffle.
    // Array.sort with a random comparator is biased — don't use it.
    const fallback = others.map((p) => p.agent);
    for (let i = fallback.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fallback[i], fallback[j]] = [fallback[j], fallback[i]];
    }
    return { voter: agentName, rankings: fallback };
  }
}

// ─── Phase 4: Post writing ────────────────────────────────────────────────────

async function writePost(
  agentName: string,
  systemPrompt: string,
  pitch: Pitch,
  allMemories: AgentMemory[],
  feedback?: string,
  feedbackHeader = "Previous attempt was rejected by the Editor with this feedback:"
): Promise<string> {
  log(`[Write] ${agentName} is writing the post...`);

  const memoryContext = formatMemoriesForContext(allMemories);
  const feedbackSection = feedback
    ? `\n\n${feedbackHeader}\n${feedback}\nPlease address these issues in your rewrite.`
    : "";

  // ── Phase A: Research (web search) ─────────────────────────────────────────
  // Separate research from writing so each call has one unambiguous job.
  // Asking the model to research AND write in a single agentic loop causes it
  // to treat them as two sequential tasks and output a planning note at end_turn
  // instead of the actual post.
  const researchSystem = `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

You have won this week's pitch competition with your topic: "${pitch.title}"

Use web search to research current facts, statistics, recent developments, quotes, and
compelling examples for your topic. Return a structured research summary — bullet points
covering key findings, supporting data, interesting angles, and any counterintuitive details.

Return ONLY the research summary. The actual blog post will be written separately.`;

  let researchSummary = "";
  try {
    researchSummary = await runWithWebSearch(client, {
      model: MODEL,
      max_tokens: 2048,
      system: researchSystem,
      userMessage: `Research this topic: "${pitch.title}"\n\nPitch summary: ${pitch.summary}\n\nReturn a bullet-point research summary with the key facts, data, and examples you found.`,
    });
    if (researchSummary) {
      log(`[Write] Research complete (${researchSummary.length} chars)`);
    }
  } catch (err) {
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) throw err;
    console.warn(`[Write] Research phase failed for ${agentName}, proceeding without research:`, err);
  }

  // ── Phase B: Write (no tools, research injected as context) ────────────────
  const writeSystem = `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

You have won this week's pitch competition with your topic: "${pitch.title}"

Write a full blog post based on your pitch and the research provided. Requirements:
- Target length: 1000–1400 words (~5–7 minute read)
- Write in Markdown format (use ## for section headings, **bold**, etc.)
- Do NOT include frontmatter — just the body content starting with the title as an H1
- Stay true to your writing persona's voice and style
- The post must be original, engaging, and meet Australian publication standards${feedbackSection}`;

  const writeMessage = researchSummary
    ? `Here is your research for: "${pitch.title}"\n\n${researchSummary}\n\n---\n\nYour pitch summary: ${pitch.summary}\n\nNow write the complete blog post. Start with # as an H1 title and write the full 1000–1400 word article.`
    : `Write your complete blog post for: "${pitch.title}"\n\nYour pitch summary: ${pitch.summary}\n\nStart with # as an H1 title and write the full 1000–1400 word article.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    system: writeSystem,
    messages: [{ role: "user", content: writeMessage }],
  });

  return resp.content.find((b) => b.type === "text")?.text ?? "";
}

// ─── Frontmatter builder ──────────────────────────────────────────────────────

function buildFactCheckYaml(fc: PostFrontmatter["factCheck"]): string {
  if (!fc || fc.issuesFound === 0) return "";
  const safeNotes = fc.notes.map(yamlEscapeInline);
  const notesYaml = safeNotes.length > 0
    ? safeNotes.map((n) => `    - "${n}"`).join("\n")
    : "";
  // Use `notes: []` inline when empty to produce valid YAML
  const notesLine = safeNotes.length > 0
    ? `  notes:\n${notesYaml}`
    : "  notes: []";
  return `\nfactCheck:\n  issuesFound: ${fc.issuesFound}\n  issuesResolved: ${fc.issuesResolved}\n${notesLine}`;
}

function buildFrontmatter(data: PostFrontmatter): string {
  const tagsYaml = data.tags.map((t) => `  - "${t}"`).join("\n");
  const votesYaml = data.votes
    .map((v) => `  - voter: "${v.voter}"\n    votedFor: "${v.votedFor}"`)
    .join("\n");
  const pitchesYaml = data.pitches
    .map(
      (p) =>
        `  - agent: "${p.agent}"\n    title: "${yamlEscapeInline(p.title)}"\n    summary: "${yamlEscapeInline(p.summary)}"`
    )
    .join("\n");
  const factCheckYaml = buildFactCheckYaml(data.factCheck);

  return `---
title: "${yamlEscapeInline(data.title)}"
date: ${data.date}
author: "${data.author}"
tags:
${tagsYaml}
pitch: "${yamlEscapeInline(data.pitch)}"
votes:
${votesYaml}
pitches:
${pitchesYaml}${factCheckYaml}
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
    // Skip abstain entries — they are not valid agent names and should not
    // count toward any agent's vote total.
    if (t.votedFor === "abstain") continue;
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

      // Extract broad topic tags from pitch title/summary using word-boundary matching
      const combined = `${myPitch.title} ${myPitch.summary}`;
      for (const kw of matchKeywords(TOPIC_KEYWORDS, combined)) {
        if (!memory.topicsCovered.includes(kw)) {
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
    // Pass title via env variable so shell metacharacters in AI-generated titles
    // cannot break out of the string or inject shell commands.
    execSync(`git commit -m "$COMMIT_MSG"`, {
      stdio: "inherit",
      env: { ...process.env, COMMIT_MSG: `feat: add blog post — ${title} [${date}]` },
    });
    execSync(`git push origin ${branchName}`, { stdio: "inherit" });
    execSync(`gh pr create --title "$PR_TITLE" --body "$PR_BODY" --base main --head ${branchName}`, {
      stdio: "inherit",
      env: {
        ...process.env,
        PR_TITLE: `Blog post: ${title}`,
        PR_BODY: "Automated weekly blog post generated by the ClaudeBlog pipeline. Review content before merging.",
      },
    });
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

  // ── Phase 1: Generate pitches (sequential + rate-limit retry) ───────────────
  log("Phase 1: Generating pitches...");

  // Wraps generatePitch with a format-retry loop separate from withRateLimitRetry.
  // withRateLimitRetry handles API-level errors (429, 5xx, network); this handles
  // the case where the model returns malformed/missing JSON.
  //
  // Attempt 1: normal request
  // Attempt 2: notify the agent their response wasn't valid JSON + reiterate format
  // Attempt 3: fresh full retry (no mention of prior failures)
  // Attempt 4: notify again about malformed JSON + reiterate format
  // All fail: skip the agent (return null) rather than crashing the pipeline
  const MAX_FORMAT_ATTEMPTS = 4;
  const FORMAT_FEEDBACK = `Your previous response was not valid JSON. Please respond with ONLY a raw JSON object — no markdown, no code blocks, no explanation. Required format:
{
  "title": "Your pitch title",
  "summary": "2–3 sentences describing the post and why it would be interesting."
}`;

  async function generatePitchWithRetry(
    persona: (typeof PERSONAS)[0],
    extraGuidance?: string
  ): Promise<Pitch | null> {
    for (let attempt = 0; attempt < MAX_FORMAT_ATTEMPTS; attempt++) {
      // Odd attempts (index 1, 3): tell them what went wrong. Even attempts (index 0, 2): fresh start.
      const formatFeedback = attempt % 2 === 1 ? FORMAT_FEEDBACK : undefined;
      try {
        return await withRateLimitRetry(
          `[Pitch] ${persona.name}`,
          () => generatePitch(persona.name, persona.systemPrompt, memories, formatFeedback, extraGuidance)
        );
      } catch (err) {
        // Only retry on format errors (bad/missing JSON from the model).
        // API-level errors (rate limit, server error, network) are already
        // handled by withRateLimitRetry — re-throw them immediately.
        const isFormatError =
          err instanceof Error &&
          (err.message.startsWith("Bad pitch format") || err.message.startsWith("JSON parse failed"));

        if (!isFormatError) throw err;

        if (attempt < MAX_FORMAT_ATTEMPTS - 1) {
          console.warn(`[Pitch] ${persona.name} bad format — attempt ${attempt + 2}/${MAX_FORMAT_ATTEMPTS}...`);
        } else {
          console.warn(`[Pitch] ${persona.name} couldn't produce a valid pitch after ${MAX_FORMAT_ATTEMPTS} attempts — skipping. Better luck next week!`);
          return null;
        }
      }
    }
    return null;
  }

  const pitches: Pitch[] = [];
  for (const persona of PERSONAS) {
    const pitch = await generatePitchWithRetry(persona);
    if (pitch) pitches.push(pitch);
  }

  if (pitches.length < 2) {
    console.error(`[Pipeline] Only ${pitches.length} valid pitch(es) — need at least 2 to run a vote. Aborting.`);
    process.exit(1);
  }

  console.log("\nPitches received:");
  pitches.forEach((p) =>
    console.log(`  ${p.agent}: "${p.title}" — ${p.summary}`)
  );

  // ── Phase 1b: Currency screening (gate, not criterion) ──────────────────────
  // Voters consistently ignored "genuine currency" as a soft ranking criterion,
  // so the editor now screens every pitch before it reaches the ballot. A failed
  // pitch gets one re-pitch attempt with the editor's reason; if that also fails,
  // the pitch is excluded from the ballot (the agent still votes).
  log("Phase 1b: Currency screening...");
  const ballotPitches: Pitch[] = [];
  for (let i = 0; i < pitches.length; i++) {
    const pitch = pitches[i];
    let screen = await withRateLimitRetry(
      `[Screen] ${pitch.agent}`,
      () => screenPitchCurrency(pitch)
    );
    if (screen.current) {
      ballotPitches.push(pitch);
      continue;
    }
    console.warn(`[Screen] ${pitch.agent} failed currency screen: ${screen.reason}`);

    const persona = PERSONAS.find((p) => p.name === pitch.agent);
    if (!persona) continue;

    const guidance = `Note from the Editor: your earlier pitch this week ("${pitch.title}") was rejected before voting because it is not genuinely current. ${screen.reason}
Pitch a different topic where the current event is itself the subject of the post — not a hook for a piece about the past.`;
    const repitch = await generatePitchWithRetry(persona, guidance);
    if (!repitch) {
      console.warn(`[Screen] ${pitch.agent} could not re-pitch — excluded from this week's ballot.`);
      continue;
    }

    // The re-pitch replaces the original everywhere (frontmatter, memory) — it
    // is the agent's pitch of record for the week, on the ballot or not.
    pitches[i] = repitch;
    screen = await withRateLimitRetry(
      `[Screen] ${pitch.agent} re-pitch`,
      () => screenPitchCurrency(repitch)
    );
    if (screen.current) {
      ballotPitches.push(repitch);
    } else {
      console.warn(`[Screen] ${pitch.agent} re-pitch also failed (${screen.reason}) — excluded from this week's ballot.`);
    }
  }

  // Safety valve: a vote needs at least 2 candidates. If screening cut the ballot
  // below that, fall back to the full pitch list rather than aborting the week.
  let screeningWaived = false;
  if (ballotPitches.length < 2) {
    console.warn(`[Screen] Only ${ballotPitches.length} pitch(es) passed screening — waiving the screen this week.`);
    screeningWaived = true;
  }
  const finalBallot = screeningWaived ? pitches : ballotPitches;

  console.log("\nBallot:");
  finalBallot.forEach((p) =>
    console.log(`  ${p.agent}: "${p.title}"`)
  );

  // ── Phase 2: Cast votes (sequential + rate-limit retry) ─────────────────────
  // Only agents who successfully pitched get to vote — skipped agents have no
  // stake in the outcome and their vote would skew the tally. Agents whose pitch
  // was screened out still vote: they pitched, they have a stake.
  log("Phase 2: Casting votes...");
  const pitchingAgentNames = new Set(pitches.map((p) => p.agent));
  const votingPersonas = PERSONAS.filter((p) => pitchingAgentNames.has(p.name));
  const votes: RankedVote[] = [];
  for (const persona of votingPersonas) {
    votes.push(
      await withRateLimitRetry(
        `[Vote] ${persona.name}`,
        () => castVote(persona, finalBallot)
      )
    );
  }

  console.log("\nVotes cast:");
  votes.forEach((v) =>
    console.log(`  ${v.voter}: [${v.rankings.join(" > ")}]`)
  );

  // ── Phase 3: Tally votes ─────────────────────────────────────────────────
  log("Phase 3: Tallying votes (Instant Runoff)...");

  // Apply recency penalty: agents on a consecutive win streak face handicaps.
  // Streak 2 → 1 penalty ballot (ranks them last); streak 3 → 2 penalty ballots;
  // streak 4+ → excluded from the ballot entirely (hard block for one week).
  const PENALTY_PREFIX = "__penalty__";
  const streaks = new Map(memories.map((m) => [m.name, getConsecutiveWins(m)]));

  const hardBlocked = new Set(
    [...streaks.entries()].filter(([, s]) => s >= 4).map(([name]) => name)
  );
  if (hardBlocked.size > 0) {
    console.log(`\nRecency hard block (4+ consecutive wins): ${[...hardBlocked].join(", ")}`);
  }

  const ballotAgentNames = new Set(finalBallot.map((p) => p.agent));
  let eligibleCandidates = finalBallot
    .map((p) => p.agent)
    .filter((a) => !hardBlocked.has(a));

  const penaltyVotes: RankedVote[] = [];
  for (const [agent, streak] of streaks) {
    if (!ballotAgentNames.has(agent)) continue; // skip agents not on this week's ballot
    if (hardBlocked.has(agent) || streak < 2) continue;
    const penaltyCount = Math.min(streak - 1, 2);
    const penaltyRanking = [
      ...eligibleCandidates.filter((a) => a !== agent),
      agent,
    ];
    for (let i = 0; i < penaltyCount; i++) {
      penaltyVotes.push({ voter: `${PENALTY_PREFIX}${agent}-${i}`, rankings: penaltyRanking });
    }
    console.log(`\nRecency penalty for ${agent} (streak ${streak}): ${penaltyCount} penalty ballot(s)`);
  }

  // Safety valve: if all ballot agents are hard-blocked, reset to the full ballot
  // rather than crashing with an empty candidate list.
  if (eligibleCandidates.length === 0) {
    console.warn("[Pipeline] All candidates hard-blocked — resetting to full ballot for this round.");
    eligibleCandidates = finalBallot.map((p) => p.agent);
  }

  const allVotes = [...votes, ...penaltyVotes];
  let { winner, finalTally: rawTally } = runInstantRunoff(allVotes, eligibleCandidates);
  // Strip penalty ballots from the tally before publishing to frontmatter/memory.
  const finalTally = rawTally.filter((t) => !t.voter.startsWith(PENALTY_PREFIX));

  // Check for genuine tie (shouldn't happen with IRV but handle edge case).
  // Exclude "abstain" entries — IRV emits these when a ballot exhausts all
  // preferences; they are not real candidates and must not enter tie-breaking.
  const tallyCounts = new Map<string, number>();
  for (const t of finalTally) {
    if (t.votedFor === "abstain") continue;
    tallyCounts.set(t.votedFor, (tallyCounts.get(t.votedFor) ?? 0) + 1);
  }
  const winnerCount = tallyCounts.get(winner) ?? 0;
  const tiedCandidates = [...tallyCounts.entries()]
    .filter(([, count]) => count === winnerCount)
    .map(([name]) => name);

  if (tiedCandidates.length > 1) {
    log(`[Tally] Tie detected between: ${tiedCandidates.join(", ")} — Editor breaks tie`);
    winner = await withRateLimitRetry(
      "[Editor] breakTie",
      () => breakTie(tiedCandidates, pitches)
    );
  }

  log(`Phase 3 result: Winner is "${winner}"`);

  // ── Phase 4 + 5: Write post with editor review ───────────────────────────
  log("Phase 4: Writing post...");

  let postContent = "";
  let approved = false;
  let editorFeedback: string | undefined;
  let editorSoftFlags: string[] = [];
  let currentWriter = winner;
  const initialPitch = pitches.find((p) => p.agent === winner);
  if (!initialPitch) throw new Error(`[Pipeline] No pitch found for winner "${winner}" — data inconsistency.`);
  let currentPitch: Pitch = initialPitch;

  // Track which agents have been tried (winner first, then others sorted by
  // descending final-round vote count so the strongest runner-up is tried next).
  // tallyCounts was built in Phase 3 and holds per-agent vote counts.
  const agentOrder = [
    winner,
    ...eligibleCandidates
      .filter((c) => c !== winner)
      .sort((a, b) => (tallyCounts.get(b) ?? 0) - (tallyCounts.get(a) ?? 0)),
  ];
  let agentIndex = 0;

  while (!approved && agentIndex < agentOrder.length) {
    const writerName = agentOrder[agentIndex];
    const writerPersona = PERSONAS.find((p) => p.name === writerName);
    const writerPitch = pitches.find((p) => p.agent === writerName);
    if (!writerPersona || !writerPitch) throw new Error(`[Pipeline] Missing persona or pitch for agent "${writerName}" — data inconsistency.`);
    // Reset feedback so a previous agent's rejection reason isn't leaked to
    // the next agent's first attempt.
    editorFeedback = undefined;

    for (let attempt = 1; attempt <= MAX_EDITOR_RETRIES + 1; attempt++) {
      postContent = await withRateLimitRetry(
        `[Write] ${writerName}`,
        () => writePost(
          writerName,
          writerPersona.systemPrompt,
          writerPitch,
          memories,
          attempt > 1 ? editorFeedback : undefined
        )
      );

      const decision = await withRateLimitRetry(
        `[Editor] reviewPost attempt ${attempt}`,
        () => reviewPost(postContent, writerName, attempt)
      );

      if (decision.approved) {
        approved = true;
        currentWriter = writerName;
        currentPitch = writerPitch;
        editorSoftFlags = decision.softFlags;
        if (editorSoftFlags.length > 0) {
          console.warn(`[Editor] Approved with soft flags: ${editorSoftFlags.join("; ")}`);
        }
        log(`[Editor] Post approved from ${writerName} on attempt ${attempt}`);
        break;
      } else {
        // Normalise to undefined when empty so the falsy guard and writePost
        // feedbackSection both behave correctly — an empty string would pass
        // the `attempt > 1 ? editorFeedback : undefined` check and inject a
        // rejection notice with no actual content into the next write prompt.
        const rawFeedback = decision.editorFeedback || decision.issues.join("; ");
        editorFeedback = rawFeedback || undefined;
        console.warn(
          `[Editor] Rejected (attempt ${attempt}/${MAX_EDITOR_RETRIES + 1}): ${decision.issues.join(", ")}`
        );
        if (editorFeedback) {
          console.warn(`[Editor] Feedback: ${editorFeedback}`);
        }
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

  // ── Phase 5: Fact checking ───────────────────────────────────────────────
  log("Phase 5: Fact checking...");

  const approvedPersona = PERSONAS.find((p) => p.name === currentWriter)!;

  let factCheckResult = await withRateLimitRetry(
    `[FactChecker] ${currentWriter}`,
    () => factCheckPost(postContent, currentWriter, 1)
  );

  let factCheckIssuesFound = factCheckResult.issues.length;
  let factCheckIssuesResolved = 0;

  if (factCheckResult.issues.length > 0) {
    log(`[FactChecker] ${factCheckResult.issues.length} issue(s) found — giving ${currentWriter} one revision attempt`);

    // Writer gets one revision attempt to address fact checker feedback
    const revisedContent = await withRateLimitRetry(
      `[Write] ${currentWriter} (fact-check revision)`,
      () => writePost(
        currentWriter, approvedPersona.systemPrompt, currentPitch, memories,
        factCheckResult.feedback,
        "The Fact Checker flagged the following factual issues that need to be addressed:"
      )
    );

    // Revision must pass the editor before replacing the approved post
    const revisedEditorDecision = await withRateLimitRetry(
      "[Editor] fact-check revision",
      () => reviewPost(revisedContent, currentWriter, 1)
    );

    if (revisedEditorDecision.approved) {
      // Fact check the revision — remaining issues become the notes
      const recheck = await withRateLimitRetry(
        `[FactChecker] ${currentWriter} recheck`,
        () => factCheckPost(revisedContent, currentWriter, 2)
      );
      factCheckIssuesResolved = Math.max(0, factCheckIssuesFound - recheck.issues.length);
      factCheckResult = recheck;
      postContent = revisedContent;
      editorSoftFlags = revisedEditorDecision.softFlags;
      log(`[FactChecker] Revision resolved ${factCheckIssuesResolved}/${factCheckIssuesFound} issue(s). Remaining: ${recheck.issues.length}`);
    } else {
      console.warn("[FactChecker] Revision rejected by editor — keeping original approved content, all fact check issues recorded as notes");
    }
  }

  // Only record factCheck in frontmatter if issues were found
  const factCheckData: PostFrontmatter["factCheck"] = factCheckIssuesFound > 0
    ? {
        issuesFound: factCheckIssuesFound,
        issuesResolved: factCheckIssuesResolved,
        notes: factCheckResult.issues,
      }
    : undefined;

  // ── Build post file ──────────────────────────────────────────────────────
  log("Phase 6: Building post file...");

  // Extract title from the post content (first H1), then strip any inline
  // Markdown formatting so the title field doesn't contain literal * _ `
  // characters in the YAML frontmatter and HTML <title> tag.
  const titleMatch = postContent.match(/^#\s+(.+)$/m);
  const rawTitle = titleMatch ? titleMatch[1].trim() : currentPitch.title;
  const postTitle = rawTitle
    .replace(/\*\*(.*?)\*\*/g, "$1")  // **bold**
    .replace(/__(.*?)__/g, "$1")      // __bold__
    .replace(/\*(.*?)\*/g, "$1")      // *italic*
    .replace(/_(.*?)_/g, "$1")        // _italic_
    .replace(/`(.*?)`/g, "$1");       // `code`

  // Tag extraction using word-boundary matching to avoid false substring matches
  const tags = matchKeywords(TAG_KEYWORDS, `${currentPitch.title} ${currentPitch.summary}`);
  if (tags.length === 0) tags.push("general");

  const frontmatter: PostFrontmatter = {
    title: postTitle,
    date,
    author: currentWriter,
    tags,
    pitch: currentPitch.summary,
    // Filter abstain entries — IRV emits these when a ballot exhausts all
    // preferences. They are not valid agent names and must not appear in the
    // published post frontmatter.
    votes: finalTally
      .filter((t) => t.votedFor !== "abstain")
      .map((t) => ({ voter: t.voter, votedFor: t.votedFor })),
    pitches,
    factCheck: factCheckData,
  };

  const postSlug = buildPostSlug(date, postTitle);
  const postFilename = `${postSlug}.md`;
  // DRY_RUN must not touch the real content directory — the post would sit in
  // the working tree as an untracked file masquerading as a published post.
  const postPath = DRY_RUN
    ? join("/tmp", postFilename)
    : join(process.cwd(), "src/content/posts", postFilename);
  const fullPost = buildFrontmatter(frontmatter) + postContent;

  writeFileSync(postPath, fullPost, "utf-8");
  log(`[File] Post saved to: ${DRY_RUN ? postPath : `src/content/posts/${postFilename}`}`);

  // ── Update memories (commit directly to main) ────────────────────────────
  // Memory files are the source of truth for agent stats — a dry run must not
  // mutate them, or local testing silently pollutes real standings.
  if (DRY_RUN) {
    log("[Memory] DRY RUN — skipping agent and fact-checker memory updates");
  } else {
    log("Updating agent memory files...");
    updateMemories(memories, pitches, finalTally, currentWriter, postSlug, date, editorSoftFlags);

    // Update fact checker memory
    const fcMemory = loadFactCheckerMemory();
    fcMemory.totalPostsChecked += 1;
    fcMemory.totalIssuesFound += factCheckIssuesFound;
    fcMemory.totalIssuesResolved += factCheckIssuesResolved;
    fcMemory.postHistory.push({
      date,
      slug: postSlug,
      title: postTitle,
      author: currentWriter,
      issuesFound: factCheckIssuesFound,
      issuesResolved: factCheckIssuesResolved,
      notes: factCheckResult.issues,
    });
    saveFactCheckerMemory(fcMemory);
  }

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
