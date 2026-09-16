import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type SourceRow = Record<string, unknown>;

export interface NormalizedMathnetRow {
  sourceId: string;
  title: string | null;
  statement: string;
  solution: string | null;
  finalAnswer: string | null;
  language: string | null;
  country: string | null;
  competition: string | null;
  topics: string[];
  problemType: string | null;
  license: string | null;
  sourceUrl: string | null;
  hasImages: boolean;
  isEnglish: boolean;
  isTextComplete: boolean;
  hasSolution: boolean;
  rightsCleared: boolean;
  exclusionReason: string | null;
  contentHash: string;
  raw: SourceRow;
}

export async function loadSourceRows(file: string): Promise<SourceRow[]> {
  const text = await readFile(file, "utf8");
  if (file.endsWith(".jsonl") || file.endsWith(".ndjson")) {
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (!isObject(value)) throw new Error(`row ${index + 1} is not an object`);
      return value;
    });
  }
  const value = JSON.parse(text) as unknown;
  const rows = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.rows) ? value.rows : null;
  if (!rows) throw new Error("expected a JSON array, { rows: [...] }, JSONL, or NDJSON file");
  return rows.map((row, index) => {
    if (!isObject(row)) throw new Error(`row ${index + 1} is not an object`);
    return row;
  });
}

export function normalizeRow(row: SourceRow, index: number): NormalizedMathnetRow {
  const statement = text(row, ["problem_markdown", "statement", "problem", "question", "problem_statement", "text"]) ?? "";
  const solution = solutionText(row);
  const language = text(row, ["language", "lang"]);
  const license = text(row, ["license", "licence", "rights"]);
  const sourceId = String(text(row, ["id", "source_id", "problem_id", "uuid"]) ?? index + 1);
  const sourceUrl = text(row, ["url", "source_url", "link"]);
  const explicitImages = boolean(row, ["has_images", "has_diagram", "diagram_required"]);
  const hasImages = explicitImages || /!\[[^\]]*\]\(|<img\b|\b(figure|diagram)\s+(above|below)\b/i.test(statement);
  const isEnglish = !language || /^(en|eng|english)$/i.test(language);
  const isTextComplete = statement.trim().length >= 20 && !hasImages;
  const hasSolution = Boolean(solution?.trim());
  const rightsCleared = boolean(row, ["rights_cleared", "redistributable", "permission_granted"]) ||
    /public domain|cc0|cc[- ]by|creative commons|apache|mit/i.test(license ?? "");
  const exclusionReason = !isEnglish
    ? "non_english"
    : !statement.trim()
      ? "missing_statement"
      : !isTextComplete
        ? "diagram_or_incomplete_text"
        : !hasSolution
          ? "missing_solution"
          : !rightsCleared
            ? "rights_not_cleared"
            : null;

  return {
    sourceId,
    title: text(row, ["title", "name"]),
    statement,
    solution,
    finalAnswer: text(row, ["final_answer", "short_answer"]),
    language,
    country: text(row, ["country"]),
    competition: text(row, ["competition", "contest", "source"]),
    topics: stringList(row, ["topics_flat", "topics", "tags", "subject"]),
    problemType: text(row, ["problem_type", "type"]),
    license,
    sourceUrl,
    hasImages,
    isEnglish,
    isTextComplete,
    hasSolution,
    rightsCleared,
    exclusionReason,
    contentHash: createHash("sha256").update(statement.trim()).digest("hex"),
    raw: row,
  };
}

export function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(row: SourceRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function boolean(row: SourceRow, keys: string[]): boolean {
  return keys.some((key) => row[key] === true || row[key] === 1 || row[key] === "true");
}

function solutionText(row: SourceRow): string | null {
  const direct = text(row, ["solution", "answer", "proof", "solution_text"]);
  if (direct) return direct;
  const solutions = row.solutions_markdown;
  if (!Array.isArray(solutions)) return null;
  const usable = solutions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return usable.length > 0 ? usable.join("\n\n---\n\n") : null;
}

function stringList(row: SourceRow, keys: string[]): string[] {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
    if (typeof value === "string") return value.split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function isObject(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
