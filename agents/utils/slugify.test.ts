import { describe, it, expect } from "vitest";
import { slugify, buildPostSlug } from "./slugify.ts";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("The Man Who Said No")).toBe("the-man-who-said-no");
  });

  it("strips punctuation and special characters", () => {
    expect(slugify("Wait — What?! (Really)")).toBe("wait-what-really");
  });

  it("collapses repeated whitespace and hyphens", () => {
    expect(slugify("a   b -- c")).toBe("a-b-c");
  });

  it("caps length at 80 characters", () => {
    expect(slugify("word ".repeat(40)).length).toBeLessThanOrEqual(80);
  });
});

describe("buildPostSlug", () => {
  it("prefixes the date", () => {
    expect(buildPostSlug("2026-06-12", "Hello World")).toBe("2026-06-12-hello-world");
  });
});
