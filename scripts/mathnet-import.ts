import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { checksum, loadSourceRows, normalizeRow } from "./mathnet-common.js";

const sourceFile = process.env.MATHNET_SOURCE_FILE;
const revision = process.env.MATHNET_RELEASE_REVISION;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!sourceFile || !revision || !url || !key) {
  throw new Error("MATHNET_SOURCE_FILE, MATHNET_RELEASE_REVISION, NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SECRET_KEY are required.");
}

const datasetId = process.env.MATHNET_DATASET_ID ?? "ShadenA/MathNet";
const file = resolve(sourceFile);
const sourceRows = await loadSourceRows(file);
const rows = sourceRows.map(normalizeRow);
const eligible = rows.filter((row) => row.exclusionReason === null);
const exclusions: Record<string, number> = {};
for (const row of rows) if (row.exclusionReason) exclusions[row.exclusionReason] = (exclusions[row.exclusionReason] ?? 0) + 1;
const sourceChecksum = checksum(JSON.stringify(sourceRows));
const manifest = {
  datasetId,
  revision,
  importedAt: new Date().toISOString(),
  sourceFile: file,
  sourceChecksumSha256: sourceChecksum,
  importedCount: rows.length,
  eligibleCount: eligible.length,
  exclusionCounts: exclusions,
  licenses: [...new Set(rows.map((row) => row.license ?? "unspecified"))].sort(),
  eligibilityRules: ["English", "text-complete", "no required image/diagram", "solution present", "redistribution rights cleared"],
};

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data: release, error: releaseError } = await supabase.from("mathnet_releases").upsert({
  dataset_id: datasetId,
  revision,
  schema_version: "mathnet-normalized-1",
  import_manifest: manifest,
  imported_count: rows.length,
  eligible_count: eligible.length,
  exclusion_counts: exclusions,
  license: manifest.licenses.join(", "),
  source_url: `https://huggingface.co/datasets/${datasetId}/tree/${revision}`,
  checksums: { source_sha256: sourceChecksum },
  index_version: 1,
  is_active: false,
}, { onConflict: "dataset_id,revision,index_version" }).select("id").single();
if (releaseError || !release) throw new Error(releaseError?.message ?? "release insert failed");

for (let offset = 0; offset < rows.length; offset += 200) {
  const batch = rows.slice(offset, offset + 200);
  const { data: problems, error } = await supabase.from("mathnet_problems").upsert(batch.map((row) => ({
    release_id: release.id,
    source_id: row.sourceId,
    title: row.title,
    statement_markdown: row.statement,
    language: row.language,
    country: row.country,
    competition: row.competition,
    topics: row.topics,
    problem_type: row.problemType,
    source_locator: { url: row.sourceUrl, dataset: datasetId, revision },
    content_hash: row.contentHash,
    is_english: row.isEnglish,
    is_text_complete: row.isTextComplete,
    has_images: row.hasImages,
    has_solution: row.hasSolution,
    rights_cleared: row.rightsCleared,
    exclusion_reason: row.exclusionReason,
    is_eligible: row.exclusionReason === null,
    attribution: { license: row.license, source_url: row.sourceUrl, dataset: datasetId, revision },
  })), { onConflict: "release_id,source_id" }).select("id,source_id");
  if (error || !problems) throw new Error(error?.message ?? `problem import failed at ${offset}`);
  const bySource = new Map(problems.map((problem) => [problem.source_id as string, problem.id as string]));
  const solutions = batch.filter((row) => row.solution).map((row) => ({
    mathnet_problem_id: bySource.get(row.sourceId),
    release_id: release.id,
    solutions_markdown: row.solution,
    final_answer: row.finalAnswer,
  })).filter((row) => row.mathnet_problem_id);
  if (solutions.length) {
    const { error: solutionError } = await supabase.from("mathnet_solution_data").upsert(solutions, { onConflict: "mathnet_problem_id" });
    if (solutionError) throw new Error(solutionError.message);
  }
}

await mkdir(resolve("data"), { recursive: true });
await writeFile(resolve("data/mathnet-import-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve("data/mathnet-quarantine.jsonl"), rows.filter((row) => row.exclusionReason).map((row) => JSON.stringify({ sourceId: row.sourceId, reason: row.exclusionReason, raw: row.raw })).join("\n") + "\n");
const fixtureLimit = Math.max(100, Math.min(300, Number(process.env.MATHNET_FIXTURE_LIMIT ?? 300)));
await writeFile(resolve("data/mathnet-fixtures.json"), `${JSON.stringify(eligible.slice(0, fixtureLimit).map(({ raw: _raw, ...row }) => row), null, 2)}\n`);
console.log(JSON.stringify({ releaseId: release.id, ...manifest }, null, 2));
