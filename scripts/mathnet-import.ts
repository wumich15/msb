import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checksum, loadSourceRows, normalizeRow } from "./mathnet-common.js";
import { adminFirestore, mathnetProblemId, releaseId } from "./firebase-admin.js";
import { documentTerms } from "../src/lib/mathnet/lexical.js";
import { mathnetCategoryRoots } from "../src/lib/mathnet/categories.js";

/**
 * Imports a pinned MathNET export into Firestore as an inactive release.
 *
 * Statements go to `mathnet_problems`; solutions and everything derived from them
 * go to the server-only `mathnet_solution_data` collection. The release is never
 * activated here: `npm run mathnet:index` classifies, embeds, validates and then
 * activates atomically.
 */

const sourceFile = process.env.MATHNET_SOURCE_FILE;
const revision = process.env.MATHNET_RELEASE_REVISION;
if (!sourceFile || !revision) {
  throw new Error("MATHNET_SOURCE_FILE and MATHNET_RELEASE_REVISION are required (plus Firebase Admin credentials or emulator hosts).");
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

const db = adminFirestore();
const indexVersion = 1;
const release = releaseId(datasetId, revision, indexVersion);
const now = new Date().toISOString();

await db.collection("mathnet_releases").doc(release).set(
  {
    id: release,
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
    index_version: indexVersion,
    is_active: false,
    validated_at: null,
    activated_at: null,
    created_at: now,
  },
  { merge: true },
);

for (let offset = 0; offset < rows.length; offset += 200) {
  const batch = db.batch();
  for (const row of rows.slice(offset, offset + 200)) {
    const id = mathnetProblemId(release, row.sourceId);
    batch.set(db.collection("mathnet_problems").doc(id), {
      id,
      release_id: release,
      source_id: row.sourceId,
      title: row.title,
      statement_markdown: row.statement,
      language: row.language,
      country: row.country,
      competition: row.competition,
      topics: row.topics,
      topic_roots: mathnetCategoryRoots(row.topics),
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
      created_at: now,
    });
    if (row.solution) {
      batch.set(
        db.collection("mathnet_solution_data").doc(id),
        {
          id,
          mathnet_problem_id: id,
          release_id: release,
          is_eligible: row.exclusionReason === null,
          solutions_markdown: row.solution,
          final_answer: row.finalAnswer,
          problem_categories: mathnetCategoryRoots(row.topics),
          idea_ids: [],
          secondary_idea_ids: [],
          mechanism: null,
          evidence: [],
          evidence_kind: "statement_only",
          confidence: 0,
          search_terms: documentTerms(`${row.title ?? ""} ${row.statement} ${row.topics.join(" ")}`),
          statement_embedding: null,
          idea_embedding: null,
          embedding_model: null,
          embedding_dimension: null,
          profile_version: null,
          created_at: now,
        },
        { merge: true },
      );
    }
  }
  await batch.commit();
}

await mkdir(resolve("data"), { recursive: true });
await writeFile(resolve("data/mathnet-import-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  resolve("data/mathnet-quarantine.jsonl"),
  rows.filter((row) => row.exclusionReason).map((row) => JSON.stringify({ sourceId: row.sourceId, reason: row.exclusionReason, raw: row.raw })).join("\n") + "\n",
);
const fixtureLimit = Math.max(100, Math.min(300, Number(process.env.MATHNET_FIXTURE_LIMIT ?? 300)));
await writeFile(
  resolve("data/mathnet-fixtures.json"),
  `${JSON.stringify(eligible.slice(0, fixtureLimit).map(({ raw: _raw, ...row }) => row), null, 2)}\n`,
);
console.log(JSON.stringify({ releaseId: release, ...manifest }, null, 2));
