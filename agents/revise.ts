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
import { factCheckPost } from "./fact-checker.ts";
import { MAX_EDITOR_RETRIES } from "./content-rules.ts";
import {
  loadAllMemories,
  formatMemoriesForContext,
  loadFactCheckerMemory,
  saveFactCheckerMemory,
} from "./utils/memory.ts";
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

// Replace or insert factCheck block in a frontmatter string.
// Uses a line-based approach to avoid regex fragility with LLM-generated note strings.
function updateFrontmatterFactCheck(
  frontmatterBlock: string,
  factCheck: { issuesFound: number; issuesResolved: number; notes: string[] } | undefined
): string {
  // Strip the surrounding --- markers to work on the inner YAML lines
  const inner = frontmatterBlock.slice(4, -5); // removes leading "---\n" and trailing "\n---\n"
  const lines = inner.split("\n");

  // Remove any existing factCheck block — identified as a top-level key followed by indented lines
  const cleanLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("factCheck:")) {
      i++;
      while (i < lines.length && (lines[i].startsWith(" ") || lines[i].startsWith("\t") || lines[i] === "")) {
        i++;
      }
    } else {
      cleanLines.push(lines[i]);
      i++;
    }
  }

  if (!factCheck || factCheck.issuesFound === 0) {
    return `---\n${cleanLines.join("\n")}\n---\n`;
  }

  // Sanitize note strings — strip newlines to prevent YAML structure corruption
  const safeNotes = factCheck.notes.map((n) => n.replace(/\n/g, " ").replace(/"/g, '\\"'));
  const notesLine = safeNotes.length > 0
    ? `  notes:\n${safeNotes.map((n) => `    - "${n}"`).join("\n")}`
    : "  notes: []";

  const factCheckLines = [
    "factCheck:",
    `  issuesFound: ${factCheck.issuesFound}`,
    `  issuesResolved: ${factCheck.issuesResolved}`,
    notesLine,
  ];

  return `---\n${cleanLines.join("\n")}\n${factCheckLines.join("\n")}\n---\n`;
}

// ─── Revision writer ──────────────────────────────────────────────────────────

async function revisePost(
  agentName: string,
  systemPrompt: string,
  originalBody: string,
  humanFeedback: string,
  editorFeedback: string | undefined,
  memories: ReturnType<typeof loadAllMemories>,
  factCheckerFeedback?: string
): Promise<string> {
  const memoryContext = formatMemoriesForContext(memories);
  const editorSection = editorFeedback
    ? `\n\nThe editor also flagged the following issues in a previous revision:\n${editorFeedback}\nPlease address these too.`
    : "";
  const factCheckerSection = factCheckerFeedback
    ? `\n\nThe Fact Checker flagged the following factual issues that also need to be addressed:\n${factCheckerFeedback}`
    : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    system: `${systemPrompt}

---
Agent stats for context:
${memoryContext}
---

Your blog post was reviewed by a human editor who has requested changes before it can be published.
Revise your post to address their feedback while staying true to your voice and style.
Keep the same topic and general direction — this is a revision, not a rewrite from scratch.
Target length: 1000–1400 words. Return the full revised post in Markdown, starting with the H1 title.${editorSection}${factCheckerSection}`,
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
  const originalContent = readFileSync(postPath, "utf-8").replace(/\r\n/g, "\n");
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
      const rawFeedback = decision.editorFeedback || decision.issues.join("; ");
      editorFeedback = rawFeedback || undefined;
      console.warn(`[Editor] Rejected (attempt ${attempt}): ${decision.issues.join(", ")}`);
    }
  }

  if (!approved) {
    console.error("[Revise] All editor retries exhausted. Aborting revision.");
    process.exit(1);
  }

  // ── Fact check the approved revision ─────────────────────────────────────
  log("Fact checking revised post...");

  let factCheckResult = await withRateLimitRetry(
    `[FactChecker] ${authorName}`,
    () => factCheckPost(revisedBody, authorName, 1)
  );

  let factCheckIssuesFound = factCheckResult.issues.length;
  let factCheckIssuesResolved = 0;

  if (factCheckResult.issues.length > 0) {
    log(`[FactChecker] ${factCheckResult.issues.length} issue(s) found — giving ${authorName} one revision attempt`);

    const furtherRevised = await withRateLimitRetry(
      `[Revise] ${authorName} (fact-check revision)`,
      () => revisePost(authorName, persona.systemPrompt, revisedBody, reviewBody, undefined, memories, factCheckResult.feedback)
    );

    const furtherEditorDecision = await withRateLimitRetry(
      "[Editor] fact-check revision",
      () => reviewPost(furtherRevised, authorName, 1)
    );

    if (furtherEditorDecision.approved) {
      const recheck = await withRateLimitRetry(
        `[FactChecker] ${authorName} recheck`,
        () => factCheckPost(furtherRevised, authorName, 2)
      );
      factCheckIssuesResolved = Math.max(0, factCheckIssuesFound - recheck.issues.length);
      factCheckResult = recheck;
      revisedBody = furtherRevised;
      log(`[FactChecker] Revision resolved ${factCheckIssuesResolved}/${factCheckIssuesFound} issue(s). Remaining: ${recheck.issues.length}`);
    } else {
      console.warn("[FactChecker] Further revision rejected by editor — keeping earlier approved revision, all fact check issues recorded as notes");
    }
  }

  const factCheckData = factCheckIssuesFound > 0
    ? { issuesFound: factCheckIssuesFound, issuesResolved: factCheckIssuesResolved, notes: factCheckResult.issues }
    : undefined;

  const updatedFrontmatter = updateFrontmatterFactCheck(frontmatterBlock, factCheckData);

  // Write revised file first — memory update follows so a write failure doesn't corrupt stats
  writeFileSync(postPath, updatedFrontmatter + revisedBody, "utf-8");

  // Update fact checker memory
  const fcMemory = loadFactCheckerMemory();
  fcMemory.totalPostsChecked += 1;
  fcMemory.totalIssuesFound += factCheckIssuesFound;
  fcMemory.totalIssuesResolved += factCheckIssuesResolved;
  fcMemory.postHistory.push({
    date: frontmatter["date"] ?? new Date().toISOString().split("T")[0],
    slug: postFile.replace(/^src\/content\/posts\//, "").replace(/\.md$/, ""),
    title: frontmatter["title"] ?? "Unknown",
    author: authorName,
    issuesFound: factCheckIssuesFound,
    issuesResolved: factCheckIssuesResolved,
    notes: factCheckResult.issues,
  });
  saveFactCheckerMemory(fcMemory);
  log(`[File] Revised post written to ${postFile}`);

  // Commit the revision
  execSync(`git add "${postPath}" agents/memory/fact-checker.json`, { stdio: "inherit" });
  execSync(
    `git commit -m "revision: address human review feedback [$AUTHOR_NAME]"`,
    { stdio: "inherit", env: { ...process.env, AUTHOR_NAME: authorName } }
  );
  execSync("git push", { stdio: "inherit" });

  log("Revision committed and pushed.");
}

main().catch((err) => {
  console.error("[Revise] Fatal error:", err);
  process.exit(1);
});
