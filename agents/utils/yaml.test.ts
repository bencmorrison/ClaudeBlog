import { describe, it, expect } from "vitest";
import { yamlEscapeInline } from "./yaml.ts";

describe("yamlEscapeInline", () => {
  it("escapes double quotes", () => {
    expect(yamlEscapeInline('he said "no"')).toBe('he said \\"no\\"');
  });

  it("escapes backslashes before quotes", () => {
    // A raw backslash-quote sequence must not produce an unescaped quote
    expect(yamlEscapeInline('path\\"x')).toBe('path\\\\\\"x');
  });

  it("survives a trailing backslash", () => {
    expect(yamlEscapeInline("ends with \\")).toBe("ends with \\\\");
  });

  it("collapses newlines to spaces", () => {
    expect(yamlEscapeInline("line one\nline two\r\nline three")).toBe(
      "line one line two line three"
    );
  });

  it("round-trips through a YAML-style double-quoted scalar", () => {
    const nasty = 'a "quoted" value with \\ backslash\nand newline';
    const escaped = yamlEscapeInline(nasty);
    // JSON double-quoted strings are a subset of YAML double-quoted scalars —
    // if JSON.parse accepts it, YAML will too.
    expect(() => JSON.parse(`"${escaped}"`)).not.toThrow();
  });
});
