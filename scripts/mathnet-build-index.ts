import { FieldValue } from "firebase-admin/firestore";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { classifyProblem } from "../src/lib/mathnet/classify.js";
import { embed } from "../src/lib/ai/voyage.js";
import { ideasToText, ideaLabel } from "../src/lib/mathnet/taxonomy.js";
import { documentTerms } from "../src/lib/mathnet/lexical.js";
import { aiConfig, versions } from "../src/lib/config.js";
import { adminFirestore, releaseId } from "./firebase-admin.js";
import { classifierPrompt } from "../src/prompts/classifier.js";
import type { IdeaProfileSchema } from "../src/lib/ai/schemas.js";
import { mathnetCategoryRoots } from "../src/lib/mathnet/categories.js";

/**
 * Classifies and embeds every eligible record of an imported release, then
 * validates and activates it atomically. Vector indexes must already be deployed
 * (`npm run firebase:deploy:rules`) before the application can query them.
 */

const revision = process.env.MATHNET_RELEASE_REVISION;
if (!revision || !process.env.OPENAI_API_KEY || !process.env.VOYAGE_API_KEY) {
  throw new Error("MATHNET_RELEASE_REVISION, OPENAI_API_KEY, and VOYAGE_API_KEY are required to build the index.");
}
const datasetId = process.env.MATHNET_DATASET_ID ?? "ShadenA/MathNet";
const release = releaseId(datasetId, revision, 1);
const db = adminFirestore();
const ideaCacheFile = resolve("data/mathnet_ideas.json");
const classifierVersion = `${versions.classifier}:${classifierPrompt.version}`;

interface MathnetIdeaCache {
  schema_version: "mathnet-ideas-1";
  dataset_id: string;
  release_revision: string | null;
  classifier_version: string | null;
  updated_at: string | null;
  note: string;
  problems: Record<string, { source_id: string; solution_hash: string; classifier_version: string; profile: IdeaProfileSchema }>;
}

let ideaCache: MathnetIdeaCache;
try {
  ideaCache = JSON.parse(await readFile(ideaCacheFile, "utf8")) as MathnetIdeaCache;
} catch {
  ideaCache = {
    schema_version: "mathnet-ideas-1",
    dataset_id: datasetId,
    release_revision: null,
    classifier_version: null,
    updated_at: null,
    note: "Public MathNet idea profiles keyed by statement hash and validated by solution hash plus classifier version. Contains no learner data.",
    problems: {},
  };
}

const releaseDoc = await db.collection("mathnet_releases").doc(release).get();
if (!releaseDoc.exists) throw new Error(`release ${release} not found; run mathnet:import first`);
if (releaseDoc.get("is_active")) throw new Error("release is already active; import a new revision or index version");

let indexed = 0;
let last: string | null = null;
for (;;) {
  let query = db.collection("mathnet_problems").where("release_id", "==", release).where("is_eligible", "==", true).orderBy("__name__").limit(25);
  if (last) query = query.startAfter(last);
  const page = await query.get();
  if (page.empty) break;
  for (const doc of page.docs) {
    const statement = doc.get("statement_markdown") as string;
    const title = (doc.get("title") as string | null) ?? "";
    const topics = (doc.get("topics") as string[] | undefined) ?? [];
    const contentHash = doc.get("content_hash") as string;
    const sourceId = doc.get("source_id") as string;
    const privateRef = db.collection("mathnet_solution_data").doc(doc.id);
    const privateDoc = await privateRef.get();
    const solution = privateDoc.get("solutions_markdown") as string | null | undefined;
    if (!solution) throw new Error(`eligible problem ${doc.id} has no solution`);
    const solutionHash = createHash("sha256").update(solution).digest("hex");

    const cached = ideaCache.problems[contentHash];
    const classifiedProfile = cached?.classifier_version === classifierVersion && cached.solution_hash === solutionHash
      ? cached.profile
      : (await classifyProblem({
          statement,
          work: null,
          referenceSolution: solution,
          evidenceKind: "checked_reference",
        })).profile;
    // MathNet's own hierarchical topic path is authoritative for catalog rows.
    const profile = { ...classifiedProfile, problem_categories: mathnetCategoryRoots(topics) };
    ideaCache.problems[contentHash] = { source_id: sourceId, solution_hash: solutionHash, classifier_version: classifierVersion, profile };
    const ideaText = ideasToText(profile.idea_ids, profile.mechanism);
    const vectors = await embed([statement, ideaText || statement], "document");
    await privateRef.set(
      {
        is_eligible: true,
        problem_categories: profile.problem_categories,
        idea_ids: profile.idea_ids,
        secondary_idea_ids: profile.secondary_idea_ids,
        mechanism: profile.mechanism,
        evidence: profile.evidence,
        evidence_kind: "checked_reference",
        confidence: profile.confidence,
        // The lexical document combines statement, topics, idea labels and mechanism.
        search_terms: documentTerms(
          `${title} ${statement} ${topics.join(" ")} ${profile.idea_ids.map(ideaLabel).join(" ")} ${profile.mechanism ?? ""}`,
        ),
        statement_embedding: FieldValue.vector(vectors.vectors[0] ?? []),
        idea_embedding: FieldValue.vector(vectors.vectors[1] ?? []),
        embedding_model: aiConfig().voyageModel,
        embedding_dimension: aiConfig().voyageDimension,
        profile_version: classifierVersion,
      },
      { merge: true },
    );
    indexed += 1;
  }
  last = page.docs[page.docs.length - 1]?.id ?? null;
  ideaCache = {
    ...ideaCache,
    dataset_id: datasetId,
    release_revision: revision,
    classifier_version: classifierVersion,
    updated_at: new Date().toISOString(),
  };
  await writeFile(ideaCacheFile, `${JSON.stringify(ideaCache, null, 2)}\n`);
  if (page.size < 25) break;
}

const { activateMathnetRelease } = await import("../src/lib/db/transactions/mathnet.js");
const activation = await activateMathnetRelease(release);
console.log(JSON.stringify({ indexed, activation }, null, 2));
