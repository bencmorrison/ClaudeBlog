export interface AgentMemory {
  name: string;
  totalPitches: number;
  totalWins: number;
  totalVotesReceived: number;
  posts: Array<{
    date: string;
    slug: string;
    title: string;
  }>;
  pitchHistory: Array<{
    date: string;
    title: string;
    summary: string;
    votesReceived: number;
    won: boolean;
    editorNotes?: string; // soft guideline flags from editor (approved posts only)
  }>;
  topicsCovered: string[];
}

export interface PersonaConfig {
  name: string;
  systemPrompt: string;
  topicTendencies: string[];
}

export interface Pitch {
  agent: string;
  title: string;
  summary: string;
}

export interface RankedVote {
  voter: string;
  rankings: string[]; // agent names in order of preference (1st = most preferred), excludes own pitch
}

export interface VoteTally {
  voter: string;
  votedFor: string; // final candidate this ballot counted for
}

export interface PostFrontmatter {
  title: string;
  date: string;
  author: string;
  tags: string[];
  pitch: string;
  votes: VoteTally[];
  pitches: Pitch[];
  factCheck?: {
    issuesFound: number;
    issuesResolved: number;
    notes: string[]; // unresolved issues — shown on the post page
  };
}

export interface FactCheckResult {
  issues: string[];
  feedback: string;
}

export interface FactCheckerMemory {
  totalPostsChecked: number;
  totalIssuesFound: number;
  totalIssuesResolved: number;
  postHistory: Array<{
    date: string;
    slug: string;
    title: string;
    author: string;
    issuesFound: number;
    issuesResolved: number;
    notes: string[];
  }>;
}

export interface EditorDecision {
  approved: boolean;
  issues: string[];
  softFlags: string[]; // soft guideline hits (present even on approval)
  editorFeedback?: string; // detailed feedback from the editor (populated on rejection)
}
