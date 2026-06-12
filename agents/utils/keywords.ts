/**
 * Single source of truth for topic/tag keywords.
 *
 * TAG_KEYWORDS (display case) drive post frontmatter tags; the same list
 * lowercased drives the topicsCovered field in agent memory. Previously these
 * were two divergent hardcoded lists in pipeline.ts.
 */
export const TAG_KEYWORDS = [
  "AI",
  "technology",
  "philosophy",
  "science",
  "culture",
  "history",
  "film",
  "music",
  "biology",
  "space",
  "psychology",
  "ethics",
  "society",
  "climate",
  "politics",
  "health",
  "internet",
  "gaming",
  "language",
] as const;

export const TOPIC_KEYWORDS = TAG_KEYWORDS.map((t) => t.toLowerCase());

/** Word-boundary match of a keyword list against lowercased text. */
export function matchKeywords(keywords: readonly string[], text: string): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => new RegExp(`\\b${kw.toLowerCase()}\\b`).test(lower));
}
