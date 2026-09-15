import { createClient } from "@supabase/supabase-js";
import { classifyProblem } from "../src/lib/mathnet/classify.js";
import { embed, toVectorLiteral } from "../src/lib/ai/voyage.js";
import { ideasToText } from "../src/lib/mathnet/taxonomy.js";
import { aiConfig, versions } from "../src/lib/config.js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const revision = process.env.MATHNET_RELEASE_REVISION;
if (!url || !key || !revision || !process.env.ANTHROPIC_API_KEY || !process.env.VOYAGE_API_KEY) {
  throw new Error("Supabase, revision, Anthropic, and Voyage configuration are required to build the index.");
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data: release, error: releaseError } = await supabase.from("mathnet_releases").select("*").eq("revision", revision).eq("is_active", false).order("created_at", { ascending: false }).limit(1).single();
if (releaseError || !release) throw new Error(releaseError?.message ?? "release not found");

let offset = 0;
let indexed = 0;
for (;;) {
  const { data: problems, error } = await supabase.from("mathnet_problems").select("id,statement_markdown").eq("release_id", release.id).eq("is_eligible", true).range(offset, offset + 24);
  if (error) throw new Error(error.message);
  if (!problems?.length) break;
  for (const problem of problems) {
    const { data: privateRow, error: privateError } = await supabase.from("mathnet_solution_data").select("solutions_markdown").eq("mathnet_problem_id", problem.id).single();
    if (privateError || !privateRow?.solutions_markdown) throw new Error(`eligible problem ${problem.id} has no solution`);
    const classified = await classifyProblem({
      statement: problem.statement_markdown,
      work: null,
      referenceSolution: privateRow.solutions_markdown,
      evidenceKind: "checked_reference",
    });
    const ideaText = ideasToText(classified.profile.idea_ids, classified.profile.mechanism);
    const vectors = await embed([problem.statement_markdown, ideaText || problem.statement_markdown], "document");
    const { error: updateError } = await supabase.from("mathnet_solution_data").update({
      idea_ids: classified.profile.idea_ids,
      secondary_idea_ids: classified.profile.secondary_idea_ids,
      mechanism: classified.profile.mechanism,
      evidence: classified.profile.evidence,
      evidence_kind: "checked_reference",
      confidence: classified.profile.confidence,
      statement_embedding: toVectorLiteral(vectors.vectors[0] ?? []),
      idea_embedding: toVectorLiteral(vectors.vectors[1] ?? []),
      embedding_model: aiConfig().voyageModel,
      embedding_dimension: aiConfig().voyageDimension,
      profile_version: versions.classifier,
    }).eq("mathnet_problem_id", problem.id);
    if (updateError) throw new Error(updateError.message);
    indexed += 1;
  }
  offset += problems.length;
}

const { data: activation, error: activationError } = await supabase.rpc("activate_mathnet_release", { p_release_id: release.id });
if (activationError) throw new Error(activationError.message);
console.log(JSON.stringify({ indexed, activation }, null, 2));
