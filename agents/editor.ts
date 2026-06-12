import Anthropic from "@anthropic-ai/sdk";
import { CONTENT_RULES } from "./content-rules.ts";
import { extractJson } from "./utils/json.ts";
import type { EditorDecision } from "./types.ts";

// maxRetries: 0 — retry logic is owned exclusively by withRateLimitRetry
// from utils/retry.ts, used by callers (pipeline.ts, revise.ts) at their
// call sites. This keeps retry semantics consistent across all API calls.
const client = new Anthropic({ maxRetries: 0 });
const MODEL = "claude-opus-4-8";

// CONTENT_RULES supplies the role description and rule set.
// EDITOR_SYSTEM adds only the strict output-format instruction on top.
const EDITOR_SYSTEM = `
${CONTENT_RULES}

Respond with ONLY a valid JSON object — no markdown, no preamble, no text outside the JSON:
{
  "approved": true | false,
  "issues": ["hard rule violations — these cause rejection; empty array if approved"],
  "softFlags": ["soft guideline hits even if approved — e.g. word count, unsupported claims; empty array if none"],
  "feedback": "detailed notes for the writer if rejected, empty string if approved"
}
`.trim();

export async function reviewPost(
  postContent: string,
  agentName: string,
  attempt: number
): Promise<EditorDecision> {
  console.log(
    `[Editor] Reviewing post by ${agentName} (attempt ${attempt})...`
  );

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: EDITOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Please review the following blog post submitted by "${agentName}":\n\n---\n${postContent}\n---`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";

  try {
    const parsed = JSON.parse(extractJson(text));
    const approved = Boolean(parsed.approved);
    const issues: string[] = Array.isArray(parsed.issues) ? parsed.issues : [];
    const feedback: string = parsed.feedback || "";

    // A rejection with no issues is a malformed response — use feedback as fallback
    // so the writer always gets a reason and the log isn't empty.
    if (!approved && issues.length === 0) {
      console.warn("[Editor] Rejection returned no issues — using feedback field as fallback.");
      issues.push(feedback || "Editor rejected without specifying issues.");
    }

    return {
      approved,
      issues,
      softFlags: Array.isArray(parsed.softFlags) ? parsed.softFlags : [],
      editorFeedback: feedback,
    };
  } catch {
    console.error("[Editor] Failed to parse editor response:", text);
    return {
      approved: false,
      issues: ["Editor response parsing failed — treating as rejection."],
      softFlags: [],
      editorFeedback: "The editor could not parse your post. Please rewrite it clearly.",
    };
  }
}

export interface CurrencyScreenResult {
  current: boolean;
  reason: string;
}

const CURRENCY_SCREEN_SYSTEM = `
You are the Editor of a blog whose mission is covering current events. Before pitches go
to a vote, you screen each one for genuine currency.

A pitch PASSES only if a current event — something from roughly the past two weeks — is
the actual subject of the proposed post: new information, an ongoing debate, fresh
developments, live consequences.

A pitch FAILS if it uses a recent date as a pretext for a piece about the past. Anniversary
retrospectives, "X years on" pieces, historical episodes pegged to a milestone, and profiles
of long-dead figures all fail — however well-crafted. The test: would this post be
meaningfully different if written six months ago? If no, it fails.

Respond with ONLY a valid JSON object — no markdown, no text outside the JSON:
{
  "current": true | false,
  "reason": "one or two sentences explaining the decision; if it fails, say what would make it pass"
}
`.trim();

export async function screenPitchCurrency(pitch: {
  agent: string;
  title: string;
  summary: string;
}): Promise<CurrencyScreenResult> {
  console.log(`[Editor] Screening pitch from ${pitch.agent} for currency...`);

  // Sydney date, matching the pipeline's post-dating convention
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: CURRENCY_SCREEN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `It is ${today}. Screen this pitch:\n\nTitle: "${pitch.title}"\nSummary: ${pitch.summary}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(extractJson(text));
    return {
      current: Boolean(parsed.current),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // Fail open — a flaky screen response shouldn't knock a pitch off the ballot.
    console.warn(`[Editor] Could not parse currency screen for ${pitch.agent} — passing by default:`, text);
    return { current: true, reason: "Screen response unparseable — passed by default." };
  }
}

export async function breakTie(
  candidates: string[],
  pitches: Array<{ agent: string; title: string; summary: string }>
): Promise<string> {
  console.log(`[Editor] Breaking tie between: ${candidates.join(", ")}`);

  const pitchContext = pitches
    .filter((p) => candidates.includes(p.agent))
    .map((p) => `**${p.agent}**: "${p.title}" — ${p.summary}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: `You are the Editor of a blog. When voting results in a tie, you cast the deciding vote.
Choose the pitch you believe will make the most interesting blog post for a general adult audience.
Respond with ONLY the name of the winning agent, exactly as written. No other text.`,
    messages: [
      {
        role: "user",
        content: `The following pitches are tied. Choose one winner:\n\n${pitchContext}`,
      },
    ],
  });

  let chosen: string;
  if (response.content[0].type === "text") {
    chosen = response.content[0].text.trim();
  } else {
    console.warn("[Editor] breakTie: response was not a text block — falling back to first candidate.");
    chosen = candidates[0];
  }

  if (!candidates.includes(chosen)) {
    console.warn(`[Editor] breakTie: returned "${chosen}" which is not a valid candidate — falling back to first candidate.`);
    return candidates[0];
  }
  return chosen;
}
