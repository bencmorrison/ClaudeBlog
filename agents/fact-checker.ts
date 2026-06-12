import Anthropic from "@anthropic-ai/sdk";
import { runWithWebSearch } from "./utils/search.ts";
import { extractJson } from "./utils/json.ts";
import type { FactCheckResult } from "./types.ts";

// maxRetries: 0 — retry logic is owned exclusively by withRateLimitRetry
const client = new Anthropic({ maxRetries: 0 });
const MODEL = "claude-opus-4-8";

const FACT_CHECKER_SYSTEM = `You are a meticulous fact checker for a blog. Your job is to verify specific factual claims made in blog posts using web search.

For each significant factual claim — statistics, dates, attributions, scientific findings, historical events, named research studies — search for supporting or contradicting evidence.

You are NOT checking for opinion, style, tone, or quality. Only verifiable facts.

Be precise: cite the specific claim that cannot be verified, not a vague category.

Respond with ONLY a valid JSON object — no markdown, no preamble, no text outside the JSON:
{
  "issues": ["specific claim that could not be verified or appears inaccurate — include enough context to identify it in the post"],
  "feedback": "detailed notes for the writer explaining each issue and what corrections to consider — empty string if no issues"
}

If all checked claims are accurate or no significant factual claims exist, return empty arrays and an empty feedback string.`.trim();

export async function factCheckPost(
  postContent: string,
  agentName: string,
  attempt: number
): Promise<FactCheckResult> {
  console.log(`[FactChecker] Checking post by ${agentName} (attempt ${attempt})...`);

  let text: string;
  try {
    text = await runWithWebSearch(client, {
      model: MODEL,
      max_tokens: 2048,
      system: FACT_CHECKER_SYSTEM,
      userMessage: `Please fact-check the following blog post by "${agentName}":\n\n---\n${postContent}\n---`,
    });
  } catch (err) {
    // Re-throw transient API errors — the outer withRateLimitRetry wrapper handles
    // retries. Swallowing a 429/529 here would bypass retry logic entirely.
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) throw err;
    // Genuine web search tool failure — don't block publication
    console.warn("[FactChecker] Web search failed — treating as no issues:", err);
    return { issues: [], feedback: "" };
  }

  try {
    const parsed = JSON.parse(extractJson(text));
    const issues: string[] = Array.isArray(parsed.issues) ? parsed.issues : [];
    const feedback: string = typeof parsed.feedback === "string" ? parsed.feedback : "";

    if (issues.length > 0) {
      console.log(`[FactChecker] Found ${issues.length} issue(s):`);
      issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
    } else {
      console.log("[FactChecker] No issues found.");
    }

    return { issues, feedback };
  } catch {
    console.error("[FactChecker] Failed to parse response:", text);
    return { issues: [], feedback: "" };
  }
}
