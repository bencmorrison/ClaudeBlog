import { describe, it, expect } from "vitest";
import { getConsecutiveWins } from "./memory.ts";
import type { AgentMemory } from "../types.ts";

function memoryWith(history: Array<{ date: string; won: boolean }>): AgentMemory {
  return {
    name: "Test Agent",
    totalPitches: history.length,
    totalWins: history.filter((h) => h.won).length,
    totalVotesReceived: 0,
    posts: [],
    pitchHistory: history.map((h) => ({
      date: h.date,
      title: "t",
      summary: "s",
      votesReceived: 0,
      won: h.won,
    })),
    topicsCovered: [],
  };
}

describe("getConsecutiveWins", () => {
  it("returns 0 with no history", () => {
    expect(getConsecutiveWins(memoryWith([]))).toBe(0);
  });

  it("counts the streak from the most recent entry", () => {
    const m = memoryWith([
      { date: "2026-01-01", won: false },
      { date: "2026-01-08", won: true },
      { date: "2026-01-15", won: true },
    ]);
    expect(getConsecutiveWins(m)).toBe(2);
  });

  it("resets when the most recent pitch lost", () => {
    const m = memoryWith([
      { date: "2026-01-01", won: true },
      { date: "2026-01-08", won: true },
      { date: "2026-01-15", won: false },
    ]);
    expect(getConsecutiveWins(m)).toBe(0);
  });

  it("sorts by date rather than relying on array order", () => {
    const m = memoryWith([
      { date: "2026-01-15", won: true },
      { date: "2026-01-01", won: false },
      { date: "2026-01-08", won: true },
    ]);
    expect(getConsecutiveWins(m)).toBe(2);
  });
});
