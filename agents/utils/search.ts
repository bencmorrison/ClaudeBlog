/**
 * Web search helper — wraps client.messages.create with the web_search tool
 * and handles the server-side agentic loop (pause_turn continuation).
 *
 * Web search is server-side: Anthropic runs the searches. The client only
 * needs to handle pause_turn (server hit its 10-iteration limit) by
 * re-sending the accumulated messages to continue.
 */

import Anthropic from "@anthropic-ai/sdk";

const WEB_SEARCH_TOOL = {
  type: "web_search_20260209" as const,
  name: "web_search" as const,
};

const MAX_CONTINUATIONS = 5;

export async function runWithWebSearch(
  client: Anthropic,
  params: {
    model: string;
    max_tokens: number;
    system: string;
    userMessage: string;
  }
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: params.userMessage },
  ];

  // Note: if a RateLimitError (429) is thrown on any iteration — including
  // mid-loop after a pause_turn continuation — it propagates out of this
  // function. The caller (pipeline.ts / revise.ts) is responsible for retry
  // via withRateLimitRetry. On retry, the full web search restarts from
  // scratch (accumulated messages are lost), which is acceptable.
  // Track the longest text block seen across all iterations. The model sometimes
  // outputs its primary content (full article or JSON pitch) in a pause_turn
  // response and then only a brief planning note on the final end_turn — taking
  // the longest text block recovers the real content in those cases.
  let longestText = "";

  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const response = await client.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      tools: [WEB_SEARCH_TOOL],
      messages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.text.length > longestText.length) {
      longestText = textBlock.text;
    }

    if (response.stop_reason === "end_turn") {
      if (!textBlock && longestText === "") {
        console.warn("[search] end_turn with no text block and no text seen in prior iterations — returning empty string");
      } else if (!textBlock) {
        console.warn("[search] end_turn with no text block — returning longest text from prior iterations");
      }
      return longestText;
    }

    if (response.stop_reason === "pause_turn") {
      // Server-side loop hit its iteration limit — append assistant turn and re-send
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    // Any other stop reason (max_tokens, stop_sequence, etc.) — return best text we have
    console.warn(`[search] Unexpected stop_reason "${response.stop_reason}" — returning longest text seen`);
    return longestText;
  }

  console.warn(`[search] MAX_CONTINUATIONS (${MAX_CONTINUATIONS}) exhausted — returning longest text seen`);
  return longestText;
}
