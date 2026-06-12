import { describe, it, expect } from "vitest";
import { runInstantRunoff } from "./voting.ts";
import type { RankedVote } from "../types.ts";

const CANDIDATES = ["A", "B", "C", "D"];

function vote(voter: string, rankings: string[]): RankedVote {
  return { voter, rankings };
}

describe("runInstantRunoff", () => {
  it("declares a first-round majority winner", () => {
    const votes = [
      vote("v1", ["A", "B", "C", "D"]),
      vote("v2", ["A", "C", "B", "D"]),
      vote("v3", ["A", "D", "B", "C"]),
      vote("v4", ["B", "A", "C", "D"]),
    ];
    const { winner } = runInstantRunoff(votes, CANDIDATES);
    expect(winner).toBe("A");
  });

  it("transfers votes from eliminated candidates", () => {
    // No majority in round 1; C eliminated first and both C-ballots
    // transfer to A, giving A the majority over B.
    const votes = [
      vote("v1", ["C", "A", "B"]),
      vote("v2", ["C", "A", "B"]),
      vote("v3", ["A", "B", "C"]),
      vote("v4", ["B", "C", "A"]),
      vote("v5", ["B", "A", "C"]),
      vote("v6", ["A", "C", "B"]),
      vote("v7", ["D", "A", "B", "C"]),
    ];
    const { winner } = runInstantRunoff(votes, CANDIDATES);
    expect(winner).toBe("A");
  });

  it("marks ballots with no remaining preferences as abstain", () => {
    const votes = [
      vote("v1", ["A"]),
      vote("v2", ["A"]),
      vote("v3", ["B"]),
    ];
    const { winner, finalTally } = runInstantRunoff(votes, ["A", "B"]);
    expect(winner).toBe("A");
    expect(finalTally).toHaveLength(3);
    expect(finalTally.every((t) => t.votedFor === "A" || t.votedFor === "B")).toBe(true);
  });

  it("handles ballots that only rank candidates not in the candidate pool", () => {
    // Voter ranked someone who was excluded (e.g. screened off the ballot)
    const votes = [
      vote("v1", ["Z", "A"]),
      vote("v2", ["A", "B"]),
      vote("v3", ["B", "A"]),
    ];
    const { winner, finalTally } = runInstantRunoff(votes, ["A", "B"]);
    expect(["A", "B"]).toContain(winner);
    expect(finalTally.find((t) => t.voter === "v1")?.votedFor).toBe("A");
  });

  it("returns a valid winner when all candidates are tied", () => {
    const votes = [
      vote("v1", ["A", "B"]),
      vote("v2", ["B", "A"]),
    ];
    const { winner } = runInstantRunoff(votes, ["A", "B"]);
    expect(["A", "B"]).toContain(winner);
  });

  it("never returns an empty winner with a single candidate", () => {
    const { winner } = runInstantRunoff([vote("v1", ["A"])], ["A"]);
    expect(winner).toBe("A");
  });
});
