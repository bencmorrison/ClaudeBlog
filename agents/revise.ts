#!/usr/bin/env tsx
/**
 * ClaudeBlog Post Revision Script
 *
 * Triggered by a GitHub PR review with "changes_requested".
 * Reads the existing post, passes human feedback to the original agent,
 * runs the revised post through the editor, and commits the result.
 *
 * Requires env vars:
 *   ANTHROPIC_API_KEY
 *   POST_FILE              — relative path to the post markdown file (e.g. src/content/posts/2026-03-19-foo.md)
 *   REVIEW_FEEDBACK_FILE   — path to a file containing the combined review feedback (body + line comments)
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { reviewPost } from "./editor.ts";
import { MAX_EDITOR_RETRIES } from "./content-rules.ts";
import { loadAllMemories, formatMemoriesForContext } from "./utils/memory.ts";
import { withRateLimitRetry } from "./utils/retry.ts";
import technologist from "./personas/the-technologist.ts";
import philosopher from "./personas/the-philosopher.ts";
import popCultureCritic from "./personas/the-pop-culture-critic.ts";
import scientist from "./personas/the-scientist.ts";
import storyteller from "./personas/the-storyteller.ts";

const PERSONAS = [technologist, philosopher, popCultureCritic, scientist, storyteller];
const MODEL = "claude-sonnet-4-6";
// maxRetries: 0 — retry logic is owned exclusively by withRateLimitRetry
// from utils/retry.ts, keeping behaviour consistent across all API calls.
const client = new Anthropic({ maxRetries: 0 });

function log(msg: string) {
  console.log(`\n${"─".repeat(60)}\n${msg}\n${"─".repeat(60)}`);
}

// ─── Parse frontmatter from an existing post file ────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("No frontmatter found in post file");

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, "$1");
    result[key] = value;
  }
  return result;
}

function extractBody(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

function extractFrontmatterBlock(content: string): string {
  const match = content.match(/^(---\n[\s\S]*?\n---\n)/);
  return match ? match[1] : "";
}

// ─── Revision writer ──────────────────────────────────────────────────────────

async function revisePost(
  agentName: string,
  systemPrompt: string,
  originalBody: string,
  humanFeedback: string,
  editorFeedback: string | undefined,
  memories: ReturnType<typeof loadAllMemories>
): Promise<string> {
  const memoryContext = formatMemoriesForContext(memories);
  const editorSection = editorFeedback
    ? `\n\nThe editor also flagged the following issues in a previous revision:\n${editorFeedback}\nPlease address these too.`
    : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

Your blog post was reviewed by a human editor who has requested changes before it can be published.
Revise your post to address their feedback while staying true to your voice and style.
Keep the same topic and general direction — this is a revision, not a rewrite from scratch.
Target length: 1000–1400 words. Return the full revised post in Markdown, starting with the H1 title.${editorSection}`,
    messages: [
      {
        role: "user",
        content: `Your original post:\n\n${originalBody}\n\n---\n\nHuman reviewer feedback:\n${humanFeedback}\n\nPlease revise your post accordingly.`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : originalBody;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const postFile = process.env.POST_FILE;
  const feedbackFile = process.env.REVIEW_FEEDBACK_FILE;

  if (!postFile || !feedbackFile) {
    console.error("Missing required env vars: POST_FILE, REVIEW_FEEDBACK_FILE");
    process.exit(1);
  }

  const reviewBody = readFileSync(feedbackFile, "utf-8").trim();
  if (!reviewBody) {
    console.error("Review feedback file is empty");
    process.exit(1);
  }

  const postPath = join(process.cwd(), postFile);
  const originalContent = readFileSync(postPath, "utf-8");
  const frontmatter = parseFrontmatter(originalContent);
  const frontmatterBlock = extractFrontmatterBlock(originalContent);
  const originalBody = extractBody(originalContent);

  const authorName = frontmatter["author"];
  if (!authorName) {
    console.error("Could not determine author from frontmatter");
    process.exit(1);
  }

  const persona = PERSONAS.find((p) => p.name === authorName);
  if (!persona) {
    console.error(`No persona found for author: ${authorName}`);
    process.exit(1);
  }

  log(`Revising post by ${authorName}`);
  log(`Human feedback: ${reviewBody}`);

  const memories = loadAllMemories();
  let revisedBody = "";
  let approved = false;
  let editorFeedback: string | undefined;

  for (let attempt = 1; attempt <= MAX_EDITOR_RETRIES + 1; attempt++) {
    revisedBody = await withRateLimitRetry(
      `[Revise] ${authorName} attempt ${attempt}`,
      () => revisePost(
        authorName,
        persona.systemPrompt,
        originalBody,
        reviewBody,
        attempt > 1 ? editorFeedback : undefined,
        memories
      )
    );

    const decision = await withRateLimitRetry(
      `[Editor] reviewPost attempt ${attempt}`,
      () => reviewPost(revisedBody, authorName, attempt)
    );

    if (decision.approved) {
      if (decision.softFlags.length > 0) {
        console.warn(`[Editor] Approved with soft flags: ${decision.softFlags.join("; ")}`);
      }
      approved = true;
      log(`[Editor] Revision approved on attempt ${attempt}`);
      break;
    } else {
      editorFeedback = decision.revisedContent ?? decision.issues.join("; ");
      console.warn(`[Editor] Rejected (attempt ${attempt}): ${decision.issues.join(", ")}`);
    }
  }

  if (!approved) {
    console.error("[Revise] All editor retries exhausted. Aborting revision.");
    process.exit(1);
  }

  // Write revised file (preserve original frontmatter)
  writeFileSync(postPath, frontmatterBlock + revisedBody, "utf-8");
  log(`[File] Revised post written to ${postFile}`);

  // Commit the revision
  execSync(`git add "${postPath}"`, { stdio: "inherit" });
  execSync(
    `git commit -m "revision: address human review feedback [${authorName}]"`,
    { stdio: "inherit" }
  );
  execSync("git push", { stdio: "inherit" });

  log("Revision committed and pushed.");
}

main().catch((err) => {
  console.error("[Revise] Fatal error:", err);
  process.exit(1);
});
