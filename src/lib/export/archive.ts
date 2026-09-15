import "server-only";
import JSZip from "jszip";
import { versions } from "@/lib/config";
import { ideaLabel } from "@/lib/mathnet/taxonomy";
import type { ExportSnapshot } from "@/lib/export/snapshot";
import type { ExportScope, ProblemRow, ReferenceSolutionPrivateRow } from "@/lib/db/types";

/**
 * Builds the export archive.
 *
 * The result is a study log, not a character-by-character edit history: statements,
 * the latest saved notes, milestone snapshots, status history, visible chat, idea
 * classifications with their provenance, and source credits. LaTeX source is
 * preserved exactly as written.
 */

export interface ArchiveInput {
  snapshot: ExportSnapshot;
  scope: ExportScope;
  scopeId: string | null;
  includeReferences: boolean;
  /** Only populated when the learner explicitly asked to include them. */
  references: Map<string, ReferenceSolutionPrivateRow[]>;
  revealedIdeaProblemIds: Set<string>;
}

const STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

/** Keeps a filename safe and collision-free; ids are appended, never trusted alone. */
export function safeName(value: string, maxLength = 60): string {
  const cleaned = (value || "untitled")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "untitled").slice(0, maxLength).toLowerCase();
}

export async function buildArchive(input: ArchiveInput): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { snapshot } = input;
  const zip = new JSZip();
  const date = snapshot.snapshotAt.slice(0, 10);

  const foldersById = new Map(snapshot.folders.map((folder) => [folder.id, folder]));

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        schema_version: versions.exportSchema,
        generated_at: new Date().toISOString(),
        snapshot_at: snapshot.snapshotAt,
        scope: input.scope,
        scope_id: input.scopeId,
        includes_reference_solutions: input.includeReferences,
        counts: {
          folders: snapshot.folders.length,
          problems: snapshot.problems.length,
          chat_messages: [...snapshot.messages.values()].reduce((total, list) => total + list.length, 0),
        },
        notes: [
          "Mathematical notation is preserved as LaTeX source.",
          "This is a study log, not an edit history: it records saved notes and milestone snapshots.",
          input.includeReferences
            ? "SPOILER WARNING: this archive contains reference solutions and hidden idea tags because that option was selected."
            : "Reference solutions and unrevealed solution-derived idea tags are excluded.",
        ],
      },
      null,
      2,
    ),
  );

  const studyLog = {
    schema_version: versions.exportSchema,
    snapshot_at: snapshot.snapshotAt,
    folders: snapshot.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      created_at: folder.created_at,
    })),
    problems: snapshot.problems.map((problem) => serializeProblem(problem, input)),
  };
  zip.file("study-log.json", JSON.stringify(studyLog, null, 2));

  for (const problem of snapshot.problems) {
    const folder = foldersById.get(problem.folder_id);
    const folderPath = `folders/${safeName(folder?.name ?? "project")}-${problem.folder_id}`;
    const fileName = `${safeName(problem.title)}-${problem.id}.md`;
    // The id suffix prevents collisions, and no path separator survives safeName.
    zip.file(`${folderPath}/${fileName}`, renderProblemMarkdown(problem, input, folder?.name ?? "Project"));
  }

  zip.file("sources.json", JSON.stringify(buildSources(input), null, 2));

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, fileName: `math-study-buddy-export-${date}.zip` };
}

function serializeProblem(problem: ProblemRow, input: ArchiveInput) {
  const { snapshot } = input;
  const statements = snapshot.statements.get(problem.id) ?? [];
  const events = snapshot.events.get(problem.id) ?? [];
  const messages = snapshot.messages.get(problem.id) ?? [];
  const profiles = snapshot.ideaProfiles.get(problem.id) ?? [];
  const showIdeas = problem.status === "complete" || input.revealedIdeaProblemIds.has(problem.id) || input.includeReferences;

  return {
    id: problem.id,
    folder_id: problem.folder_id,
    title: problem.title,
    status: problem.status,
    status_label: STATUS_LABELS[problem.status] ?? problem.status,
    created_at: problem.created_at,
    completed_at: problem.completed_at,
    imported_source_id: problem.imported_source_id,
    statement_versions: statements
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((version) => ({
        version: version.version,
        markdown: version.statement_markdown,
        source_kind: version.source_kind,
        source_metadata: version.source_metadata,
        created_at: version.created_at,
      })),
    notes: {
      revision: snapshot.notes.get(problem.id)?.revision ?? 0,
      markdown: snapshot.notes.get(problem.id)?.markdown ?? "",
      saved_at: snapshot.notes.get(problem.id)?.saved_at ?? null,
    },
    status_history: events.map((event) => ({
      kind: event.kind,
      from_status: event.from_status,
      to_status: event.to_status,
      statement_version: event.statement_version,
      notes_revision: event.notes_revision,
      notes_snapshot: event.notes_snapshot,
      created_at: event.created_at,
    })),
    conversation: messages.map((message) => ({
      role: message.role,
      content: message.content,
      // The revision makes clear which saved notes a turn was asked against.
      notes_revision: message.notes_revision,
      selected_excerpt: message.selected_excerpt,
      statement_version: message.statement_version,
      response_mode: message.response_mode,
      is_operational: message.is_operational,
      created_at: message.created_at,
    })),
    idea_classifications: profiles.map((profile) => ({
      // Solution-derived tags stay hidden unless completion or an explicit choice reveals them.
      idea_ids: showIdeas ? profile.idea_ids : [],
      idea_labels: showIdeas ? profile.idea_ids.map(ideaLabel) : [],
      safe_tags: profile.safe_tags,
      mechanism: showIdeas ? profile.mechanism : null,
      confidence: profile.confidence,
      evidence_kind: profile.evidence_kind,
      is_provisional: profile.is_provisional,
      classifier_version: profile.classifier_version,
      created_at: profile.created_at,
      withheld: !showIdeas,
    })),
    reference_solutions: input.includeReferences
      ? (input.references.get(problem.id) ?? []).map((reference) => ({
          provenance: reference.provenance,
          statement_version: reference.statement_version,
          artifact: reference.artifact,
          check_summary: reference.check_result?.summary ?? null,
          unresolved_gaps: reference.check_result?.unresolved_gaps ?? [],
          sources: reference.source_urls,
          attribution: reference.attribution,
        }))
      : undefined,
    recommendations: input.snapshot.recommendations
      .filter((entry) => entry.problemId === problem.id)
      .map((entry) => ({
        source_id: entry.sourceId,
        title: entry.title,
        relationship: entry.relationship,
        source_url: entry.sourceUrl,
        attribution: entry.attribution,
      })),
  };
}

function renderProblemMarkdown(problem: ProblemRow, input: ArchiveInput, folderName: string): string {
  const { snapshot } = input;
  const statements = (snapshot.statements.get(problem.id) ?? []).slice().sort((a, b) => a.version - b.version);
  const current = statements[statements.length - 1];
  const notes = snapshot.notes.get(problem.id);
  const events = snapshot.events.get(problem.id) ?? [];
  const messages = snapshot.messages.get(problem.id) ?? [];
  const showIdeas = problem.status === "complete" || input.revealedIdeaProblemIds.has(problem.id) || input.includeReferences;
  const profiles = snapshot.ideaProfiles.get(problem.id) ?? [];

  const lines: string[] = [
    `# ${problem.title}`,
    "",
    `Project: ${folderName}`,
    `Status: ${STATUS_LABELS[problem.status] ?? problem.status}`,
    `Statement version: ${problem.current_statement_version}`,
    problem.completed_at ? `Completed: ${problem.completed_at}` : "",
    problem.imported_source_id ? `Imported from MathNET record ${problem.imported_source_id}` : "",
    "",
    "## Statement",
    "",
    current?.statement_markdown ?? "_No statement saved._",
    "",
    "## Notes",
    "",
    notes?.markdown?.trim() ? notes.markdown : "_No notes saved._",
    "",
  ];

  if (statements.length > 1) {
    lines.push("## Earlier statement versions", "");
    for (const version of statements.slice(0, -1)) {
      lines.push(`### Version ${version.version} (${version.created_at})`, "", version.statement_markdown, "");
    }
  }

  if (events.length > 0) {
    lines.push("## Study history", "");
    for (const event of events) {
      const transition = event.to_status
        ? `${STATUS_LABELS[event.from_status ?? ""] ?? "—"} → ${STATUS_LABELS[event.to_status] ?? event.to_status}`
        : event.kind;
      lines.push(`- ${event.created_at}: ${transition}`);
      if (event.notes_snapshot) {
        lines.push("", "  <details><summary>Notes at this milestone</summary>", "", event.notes_snapshot, "", "  </details>", "");
      }
    }
    lines.push("");
  }

  if (messages.length > 0) {
    lines.push("## Assistant conversation", "");
    for (const message of messages) {
      const who = message.role === "user" ? "You" : message.is_operational ? "Assistant (status)" : "Assistant";
      const revision = message.notes_revision !== null ? ` — notes revision ${message.notes_revision}` : "";
      lines.push(`**${who}** (${message.created_at}${revision})`, "", message.content, "");
    }
  }

  if (showIdeas && profiles.length > 0) {
    const latest = profiles[profiles.length - 1];
    if (latest) {
      lines.push(
        "## Solution ideas",
        "",
        `Ideas: ${latest.idea_ids.map(ideaLabel).join("; ") || "unknown"}`,
        latest.mechanism ? `Mechanism: ${latest.mechanism}` : "",
        `Evidence: ${latest.evidence_kind.replace(/_/g, " ")} (confidence ${latest.confidence.toFixed(2)})`,
        "",
      );
    }
  }

  if (input.includeReferences) {
    const references = input.references.get(problem.id) ?? [];
    if (references.length > 0) {
      lines.push("## Reference solutions (spoiler)", "");
      for (const reference of references) {
        lines.push(`Provenance: ${reference.provenance.replace(/_/g, " ")}`, "");
        if (reference.artifact) {
          lines.push(reference.artifact.restated_problem, "");
          for (const step of reference.artifact.steps) {
            lines.push(`- ${step.claim} — ${step.justification}`);
          }
          lines.push("", `Conclusion: ${reference.artifact.conclusion}`, "");
        }
        for (const source of reference.source_urls ?? []) {
          lines.push(`Source: ${source.url} — ${source.author ?? "unknown author"} — ${source.license ?? "license unknown"}`);
        }
        lines.push("");
      }
    }
  }

  return lines.filter((line) => line !== undefined).join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function buildSources(input: ArchiveInput) {
  const credits: Array<Record<string, unknown>> = [];

  for (const entry of input.snapshot.recommendations) {
    credits.push({
      kind: "mathnet_record",
      source_id: entry.sourceId,
      title: entry.title,
      url: entry.sourceUrl,
      attribution: entry.attribution,
    });
  }

  for (const problem of input.snapshot.problems) {
    for (const version of input.snapshot.statements.get(problem.id) ?? []) {
      if (version.source_kind === "mathnet") {
        credits.push({ kind: "imported_statement", problem_id: problem.id, metadata: version.source_metadata });
      }
    }
    if (input.includeReferences) {
      for (const reference of input.references.get(problem.id) ?? []) {
        for (const source of reference.source_urls ?? []) {
          // Credits travel with reused material into every displayed adaptation.
          credits.push({
            kind: "reference_source",
            problem_id: problem.id,
            url: source.url,
            author: source.author,
            license: source.license,
            revision_link: source.revision_link,
            modification_note: source.modification_note,
          });
        }
      }
    }
  }

  return { schema_version: versions.exportSchema, credits };
}
