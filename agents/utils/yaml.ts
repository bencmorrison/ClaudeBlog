/**
 * Escape a string for use inside a double-quoted single-line YAML scalar.
 *
 * Backslashes must be escaped before quotes — otherwise a value ending in `\`
 * or containing `\"` produces invalid YAML. Newlines are collapsed to spaces
 * because the callers emit single-line quoted scalars; a raw newline would
 * break the YAML structure.
 */
export function yamlEscapeInline(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}
