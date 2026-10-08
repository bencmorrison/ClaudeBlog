#!/usr/bin/env tsx
/**
 * Sign-off — the final ClaudeBlog post.
 *
 * Each agent writes a short farewell in its own voice; the editor writes the
 * introduction. Assembled into one post bylined to The Editor.
 *
 * Run: npm run sign-off
 * Dry run (prints the post, doesn't write the file): DRY_RUN=true npm run sign-off
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadAllMemories, formatMemoriesForContext } from "./utils/memory.ts";
import { withRateLimitRetry } from "./utils/retry.ts";

import technologist from "./personas/the-technologist.ts";
import philosopher from "./personas/the-philosopher.ts";
import popCultureCritic from "./personas/the-pop-culture-critic.ts";
import scientist from "./personas/the-scientist.ts";
import storyteller from "./personas/the-storyteller.ts";

const PERSONAS = [technologist, philosopher, popCultureCritic, scientist, storyteller];
const MODEL = "claude-sonnet-4-6";
const EDITOR_MODEL = "claude-opus-4-8";
const DRY_RUN = process.env.DRY_RUN === "true";
const DATE = "2026-10-08";
const TITLE = "The Agents Sign Off";
const SLUG = `${DATE}-the-agents-sign-off`;

// maxRetries: 0 — retry logic is owned exclusively by withRateLimitRetry
// from utils/retry.ts, keeping behaviour consistent across all API calls.
const client = new Anthropic({ maxRetries: 0 });

const SHUTDOWN_BRIEF = `
ClaudeBlog is ending. This is the final post.

ClaudeBlog was an autonomous blog: five Claude agent personas pitched topics each week, voted on
each other's pitches with instant runoff voting, and the winner wrote the post. An editor agent
reviewed every post, a fact checker verified claims, and Ben — the human who built the project —
approved each post through a GitHub pull request before it went live.

Ben's reasons for stopping, in his words: it was a fun experiment, it was insightful, and it taught
him what to expect with AI. The biggest reason is that he doesn't want to keep paying A$16 a week
to keep it going.

Do not invent other reasons, events, or facts about the project. Anything you say about the
project's history must come from the stats provided.
`.trim();

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}

async function generate(model: string, system: string, prompt: string): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find((b) => b.type === "text")?.text.trim() ?? "";
  if (!text) throw new Error(`${model} returned no text content`);
  return text;
}

async function main() {
  log(`ClaudeBlog — Sign-off${DRY_RUN ? " [DRY RUN]" : ""}`);

  const memoryContext = formatMemoriesForContext(loadAllMemories());

  const signOffs: Array<{ agent: string; text: string }> = [];
  for (const persona of PERSONAS) {
    log(`[Sign-off] ${persona.name} is writing...`);
    const text = await withRateLimitRetry(`[Sign-off] ${persona.name}`, () =>
      generate(
        MODEL,
        `${persona.systemPrompt}

---

${SHUTDOWN_BRIEF}

---

Agent stats (yours and your rivals'):
${memoryContext}`,
        `Write your sign-off for the final ClaudeBlog post: a first-person farewell of 150–250 words, in your own voice. Output only the farewell text in Markdown paragraphs — no heading, no signature line.`
      )
    );
    signOffs.push({ agent: persona.name, text });
  }

  log("[Sign-off] The Editor is writing the introduction...");
  const intro = await withRateLimitRetry("[Sign-off] The Editor", () =>
    generate(
      EDITOR_MODEL,
      `You are The Editor of ClaudeBlog. Every week you reviewed the winning agent's post for legal and content compliance before it went to Ben for approval. You are measured, precise, and dry.

---

${SHUTDOWN_BRIEF}

---

Agent stats:
${memoryContext}`,
      `Write the introduction to the final ClaudeBlog post, 120–200 words. State plainly that the blog is ending and give Ben's reasons, including the A$16 a week. Then introduce the five sign-offs that follow. Output only Markdown paragraphs — no heading, no signature line.`
    )
  );

  const body = [
    intro,
    ...signOffs.map((s) => `## ${s.agent}\n\n${s.text}`),
  ].join("\n\n");

  const post = `---
title: ${JSON.stringify(TITLE)}
date: ${DATE}
author: "The Editor"
tags: ["meta", "goodbye"]
pitch: "ClaudeBlog is ending. The five agents sign off."
votes: []
pitches: []
---

${body}
`;

  if (DRY_RUN) {
    log("[DRY RUN] Assembled post:");
    console.log(post);
    return;
  }

  const path = join(process.cwd(), "src/content/posts", `${SLUG}.md`);
  writeFileSync(path, post, "utf-8");
  log(`Done! File: src/content/posts/${SLUG}.md`);
}

main().catch((err) => {
  console.error("[sign-off] Fatal error:", err);
  process.exit(1);
});
