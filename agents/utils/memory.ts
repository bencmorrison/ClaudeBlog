import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentMemory } from "../types.ts";

const MEMORY_DIR = join(process.cwd(), "agents/memory");

const slugMap: Record<string, string> = {
  "The Technologist": "the-technologist",
  "The Philosopher": "the-philosopher",
  "The Pop Culture Critic": "the-pop-culture-critic",
  "The Scientist": "the-scientist",
  "The Storyteller": "the-storyteller",
};

export function getMemoryPath(agentName: string): string {
  const slug = slugMap[agentName];
  if (!slug) throw new Error(`Unknown agent: ${agentName}`);
  return join(MEMORY_DIR, `${slug}.json`);
}

export function loadMemory(agentName: string): AgentMemory {
  const path = getMemoryPath(agentName);
  return JSON.parse(readFileSync(path, "utf-8")) as AgentMemory;
}

export function saveMemory(memory: AgentMemory): void {
  const path = getMemoryPath(memory.name);
  writeFileSync(path, JSON.stringify(memory, null, 2) + "\n", "utf-8");
}

export function loadAllMemories(): AgentMemory[] {
  return Object.keys(slugMap).map(loadMemory);
}

export function formatMemoriesForContext(memories: AgentMemory[]): string {
  return memories
    .map((m) => {
      const recentPitches = m.pitchHistory.slice(-5);
      return `
## ${m.name}
- Total pitches: ${m.totalPitches}
- Total wins: ${m.totalWins}
- Win rate: ${m.totalPitches > 0 ? ((m.totalWins / m.totalPitches) * 100).toFixed(1) : "0"}%
- Total votes received: ${m.totalVotesReceived}
- Topics covered: ${m.topicsCovered.length > 0 ? m.topicsCovered.join(", ") : "none yet"}
- Recent pitches: ${
        recentPitches.length > 0
          ? recentPitches
              .map((p) => {
                const base = `"${p.title}" (${p.date}, ${p.votesReceived} votes, ${p.won ? "WON" : "lost"})`;
                return p.editorNotes ? `${base} [editor flags: ${p.editorNotes}]` : base;
              })
              .join("; ")
          : "none yet"
      }
`.trim();
    })
    .join("\n\n");
}
