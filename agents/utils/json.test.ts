import { describe, it, expect } from "vitest";
import { extractJson } from "./json.ts";

describe("extractJson", () => {
  it("extracts a bare JSON object", () => {
    expect(JSON.parse(extractJson('{"a": 1}'))).toEqual({ a: 1 });
  });

  it("extracts from a fenced code block", () => {
    const text = 'Here you go:\n```json\n{"title": "x"}\n```\nDone.';
    expect(JSON.parse(extractJson(text))).toEqual({ title: "x" });
  });

  it("extracts from a fenced block without a language tag", () => {
    const text = '```\n{"a": true}\n```';
    expect(JSON.parse(extractJson(text))).toEqual({ a: true });
  });

  it("extracts JSON surrounded by prose", () => {
    const text = 'Let me think about this. {"rankings": [2, 1]} That is my answer.';
    expect(JSON.parse(extractJson(text))).toEqual({ rankings: [2, 1] });
  });

  it("handles nested objects via brace counting", () => {
    const text = 'prefix {"a": {"b": {"c": 1}}, "d": 2} suffix';
    expect(JSON.parse(extractJson(text))).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("ignores braces inside string values", () => {
    const text = '{"summary": "uses {braces} and \\"quotes\\" inside"}';
    expect(JSON.parse(extractJson(text))).toEqual({
      summary: 'uses {braces} and "quotes" inside',
    });
  });

  it("returns {} when no JSON is present", () => {
    expect(extractJson("no json here at all")).toBe("{}");
    expect(JSON.parse(extractJson(""))).toEqual({});
  });
});
