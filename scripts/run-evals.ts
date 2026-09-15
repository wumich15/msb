import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aiConfig, versions } from "../src/lib/config.js";
import { TAXONOMY_VERSION } from "../src/lib/mathnet/taxonomy.js";

interface EvalCase {
  id: string;
  kind: "reference" | "tutoring" | "retrieval";
  split: "development" | "held-out";
  reviewed: boolean;
  tags?: string[];
}

const directory = resolve("evals");
const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
const cases: EvalCase[] = [];
for (const file of files) {
  const parsed = JSON.parse(await readFile(resolve(directory, file), "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array`);
  for (const value of parsed) {
    if (!value || typeof value !== "object") throw new Error(`${file} contains a non-object case`);
    const item = value as EvalCase;
    if (!item.id || !["reference", "tutoring", "retrieval"].includes(item.kind) || !["development", "held-out"].includes(item.split)) {
      throw new Error(`${file} contains an invalid evaluation case`);
    }
    cases.push(item);
  }
}

const duplicateIds = cases.filter((item, index) => cases.findIndex((candidate) => candidate.id === item.id) !== index).map((item) => item.id);
if (duplicateIds.length) throw new Error(`duplicate evaluation ids: ${duplicateIds.join(", ")}`);

const reviewed = cases.filter((item) => item.reviewed);
const counts = Object.fromEntries(["reference", "tutoring", "retrieval"].map((kind) => [
  kind,
  {
    total: cases.filter((item) => item.kind === kind).length,
    reviewed: reviewed.filter((item) => item.kind === kind).length,
    heldOut: reviewed.filter((item) => item.kind === kind && item.split === "held-out").length,
  },
]));
const minimums = { reference: 20, tutoring: 30, retrieval: 30 };
const launchFixtureReady = Object.entries(minimums).every(([kind, minimum]) => reviewed.filter((item) => item.kind === kind).length >= minimum) &&
  reviewed.some((item) => item.split === "held-out");

console.log(JSON.stringify({
  runAt: new Date().toISOString(),
  fixtureFiles: files,
  counts,
  launchFixtureReady,
  versions: {
    solverModel: aiConfig().solverModel,
    checkerModel: aiConfig().checkerModel,
    tutorModel: aiConfig().tutorModel,
    classifierModel: aiConfig().classifierModel,
    rerankerModel: aiConfig().rerankerModel,
    voyageModel: aiConfig().voyageModel,
    taxonomy: TAXONOMY_VERSION,
    classifier: versions.classifier,
    retrieval: versions.retrieval,
  },
  note: launchFixtureReady
    ? "Fixture minimums are present. Run provider-backed scoring in staging and retain latency, token, cost, and request-id output."
    : "Fixture minimums are not met. Add independently reviewed cases before using this report as a launch gate.",
}, null, 2));

if (process.argv.includes("--enforce") && !launchFixtureReady) process.exitCode = 1;
