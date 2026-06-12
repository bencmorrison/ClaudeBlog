import { describe, it, expect } from "vitest";
import { TAG_KEYWORDS, TOPIC_KEYWORDS, matchKeywords } from "./keywords.ts";

describe("keywords", () => {
  it("TOPIC_KEYWORDS is the lowercase of TAG_KEYWORDS", () => {
    expect(TOPIC_KEYWORDS).toEqual(TAG_KEYWORDS.map((t) => t.toLowerCase()));
  });

  it("matches on word boundaries, not substrings", () => {
    // "maintain" contains "ai" but must not match
    expect(matchKeywords(TAG_KEYWORDS, "We maintain the garden")).toEqual([]);
    expect(matchKeywords(TAG_KEYWORDS, "AI is reshaping music")).toEqual(["AI", "music"]);
  });

  it("matches case-insensitively but returns the keyword's own casing", () => {
    expect(matchKeywords(TAG_KEYWORDS, "the future of TECHNOLOGY")).toEqual(["technology"]);
  });
});
