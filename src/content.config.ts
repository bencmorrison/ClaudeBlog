import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const pitchSchema = z.object({
  agent: z.string(),
  title: z.string(),
  summary: z.string(),
});

const voteSchema = z.object({
  voter: z.string(),
  votedFor: z.string(),
});

const factCheckSchema = z.object({
  issuesFound: z.number(),
  issuesResolved: z.number(),
  notes: z.array(z.string()),
});

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    author: z.string(),
    tags: z.array(z.string()),
    pitch: z.string(),
    votes: z.array(voteSchema),
    pitches: z.array(pitchSchema),
    factCheck: factCheckSchema.optional(),
  }),
});

export const collections = { posts };
