import type { RankedVote, VoteTally } from "../types.ts";

/**
 * Instant Runoff Voting (IRV) implementation.
 * Each voter ranks candidates in preference order.
 * Candidates are eliminated one-by-one until one has a majority.
 * Returns the winner's name and the final tally showing which candidate each ballot counted for.
 */
export function runInstantRunoff(
  votes: RankedVote[],
  candidates: string[]
): { winner: string; finalTally: VoteTally[] } {
  let remaining = new Set(candidates);
  let currentRankings = votes.map((v) => ({
    voter: v.voter,
    preferences: v.rankings.filter((name) => remaining.has(name)),
  }));

  while (true) {
    // Count first-preference votes for each remaining candidate
    const counts = new Map<string, number>();
    for (const candidate of remaining) counts.set(candidate, 0);

    for (const ballot of currentRankings) {
      const top = ballot.preferences[0];
      if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
    }

    // Majority must be based on active ballots (those still expressing a
    // preference), not the original voter count. Exhausted ballots should not
    // inflate the threshold and prevent a winner from being declared.
    const activeBallots = currentRankings.filter((b) => b.preferences.length > 0).length;
    const majority = Math.floor(activeBallots / 2) + 1;

    // Check for majority
    for (const [candidate, count] of counts) {
      if (count >= majority) {
        const finalTally = currentRankings.map((ballot) => ({
          voter: ballot.voter,
          votedFor: ballot.preferences[0] ?? "abstain",
        }));
        return { winner: candidate, finalTally };
      }
    }

    // Eliminate candidate with fewest votes
    let minCount = Infinity;
    let toEliminate = "";
    for (const [candidate, count] of counts) {
      if (count < minCount) {
        minCount = count;
        toEliminate = candidate;
      }
    }

    // If only one or two candidates remain (or all tied), pick the one with
    // the highest vote count. In a true tie the pipeline's downstream tie-
    // detection will catch it and call breakTie — we just need to return a
    // valid (non-empty) winner string here.
    if (remaining.size <= 2 || !toEliminate) {
      let maxCount = -1;
      let topCandidate = "";
      for (const [candidate, count] of counts) {
        if (count > maxCount) {
          maxCount = count;
          topCandidate = candidate;
        }
      }
      // Defensive fallback: counts is initialised from remaining (always ≥1
      // entry at this point), so topCandidate should always be set. Guard
      // anyway to avoid returning an empty winner string.
      if (!topCandidate) topCandidate = [...remaining][0];
      const finalTally = currentRankings.map((ballot) => ({
        voter: ballot.voter,
        votedFor: ballot.preferences[0] ?? "abstain",
      }));
      return { winner: topCandidate, finalTally };
    }

    remaining.delete(toEliminate);
    currentRankings = currentRankings.map((ballot) => ({
      voter: ballot.voter,
      preferences: ballot.preferences.filter((name) => remaining.has(name)),
    }));
  }
}

