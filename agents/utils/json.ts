/**
 * Extract a JSON object from anywhere in a model response string.
 * Handles models that think out loud before outputting JSON, and ```json blocks.
 *
 * Tries in order:
 *  1. Fenced ``` block (with or without language tag)
 *  2. First balanced {...} object found via brace counting (handles nesting correctly)
 *  3. Falls back to "{}" so JSON.parse never throws on a missing value
 */
export function extractJson(text: string): string {
  // 1. Fenced code block — ``` optionally followed by any language tag (json, js, etc.)
  const fenced = text.match(/```\w*\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // 2. Balanced brace extraction — correctly handles nested objects
  const balanced = extractBalancedObject(text);
  if (balanced) return balanced;

  return "{}";
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
