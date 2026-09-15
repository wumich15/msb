import taxonomy from "../../../data/idea-taxonomy.json";

/**
 * The controlled vocabulary of reusable solution ideas.
 *
 * It is a checked-in file, not an administered table: the MVP does not need an
 * ontology editor, and a versioned file makes it obvious which vocabulary a stored
 * profile was written against.
 */

export interface Idea {
  id: string;
  label: string;
  subjects: string[];
  description: string;
}

export const TAXONOMY_VERSION: string = taxonomy.version;
export const IDEAS: Idea[] = taxonomy.ideas as Idea[];

const BY_ID = new Map(IDEAS.map((idea) => [idea.id, idea]));

export function isKnownIdea(id: string): boolean {
  return BY_ID.has(id);
}

export function ideaLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Drops ids the model invented, so a stored profile always matches the vocabulary. */
export function keepKnownIdeas(ids: string[]): string[] {
  return ids.filter((id) => BY_ID.has(id));
}

/** The vocabulary as it is presented to a classifier or reranker. */
export function vocabularyForPrompt(): string {
  return IDEAS.map((idea) => `${idea.id}: ${idea.label} — ${idea.description}`).join("\n");
}

export function ideasToText(ideaIds: string[], mechanism: string | null): string {
  const labels = ideaIds.map(ideaLabel).join("; ");
  return [labels, mechanism ?? ""].filter(Boolean).join(". ");
}
