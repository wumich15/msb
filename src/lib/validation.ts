import { z } from "zod";
import { limits } from "@/lib/config";

export const uuid = z.string().uuid();

export const folderCreateSchema = z.object({
  name: z.string().trim().min(1, "A folder needs a name.").max(120),
});

export const folderUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const problemCreateSchema = z.object({
  folderId: uuid,
  title: z.string().trim().min(1, "A problem needs a title.").max(300),
  statement: z.string().max(limits.statementChars, "The statement is longer than this MVP supports.").default(""),
});

export const problemUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  folderId: uuid.optional(),
});

export const statementSchema = z.object({
  expectedVersion: z.number().int().min(0),
  statement: z.string().max(limits.statementChars, "The statement is longer than this MVP supports."),
});

export const notesSchema = z.object({
  expectedRevision: z.number().int().min(0),
  markdown: z.string().max(limits.notesChars, "These notes are longer than this MVP supports."),
});

export const statusSchema = z.object({
  status: z.enum(["not_started", "in_progress", "complete"]),
  expectedStatementVersion: z.number().int().min(0).nullable().optional(),
  expectedNotesRevision: z.number().int().min(0).nullable().optional(),
});

export const assistantToggleSchema = z.object({
  enabled: z.boolean(),
});

export const referenceChoiceSchema = z
  .object({
    choice: z.enum(["provide", "find", "reuse"]),
    expectedStatementVersion: z.number().int().min(0),
    // Required when the learner supplies their own worked solution.
    workedSolution: z.string().max(60_000).optional(),
    researchRelated: z.boolean().default(false),
  })
  .refine((value) => value.choice !== "provide" || (value.workedSolution ?? "").trim().length > 0, {
    message: "Paste the worked solution, or choose to have one found for you.",
    path: ["workedSolution"],
  });

export const messageSchema = z.object({
  requestId: z.string().min(8).max(100),
  question: z.string().trim().min(1, "Write a question first.").max(limits.questionChars),
  expectedNotesRevision: z.number().int().min(0),
  selectedExcerpt: z.string().max(limits.selectionChars).optional(),
  responseMode: z.enum(["default", "stronger_hint", "full_solution", "discuss_note_question"]).default("default"),
});

export const reportSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export const similarSchema = z.object({
  refresh: z.boolean().default(false),
});

export const saveRecommendationSchema = z.object({
  folderId: uuid,
});

export const recommendationFeedbackSchema = z.object({
  dismissed: z.boolean().optional(),
  relevance: z.enum(["useful", "same_topic_only", "unrelated"]).optional(),
});

export const exportSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("problem"), scopeId: uuid, includeReferences: z.boolean().default(false) }),
  z.object({ scope: z.literal("folder"), scopeId: uuid, includeReferences: z.boolean().default(false) }),
  z.object({ scope: z.literal("account"), scopeId: z.null().optional(), includeReferences: z.boolean().default(false) }),
]);

export const settingsSchema = z.object({
  automaticRecommendations: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  acceptAiDisclosureVersion: z.number().int().min(1).optional(),
});

export const accountDeletionSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
});
