import { resolve } from "node:path";
import { checksum, loadSourceRows, normalizeRow } from "./mathnet-common.js";

const sourceFile = process.env.MATHNET_SOURCE_FILE;
if (!sourceFile) throw new Error("Set MATHNET_SOURCE_FILE to a pinned JSON/JSONL export before inspection.");

const file = resolve(sourceFile);
const rows = await loadSourceRows(file);
const normalized = rows.map(normalizeRow);
const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
const exclusionCounts = Object.fromEntries(
  [...new Set(normalized.map((row) => row.exclusionReason ?? "eligible"))]
    .map((reason) => [reason, normalized.filter((row) => (row.exclusionReason ?? "eligible") === reason).length]),
);
const licenses = Object.fromEntries(
  [...new Set(normalized.map((row) => row.license ?? "unspecified"))]
    .map((license) => [license, normalized.filter((row) => (row.license ?? "unspecified") === license).length]),
);

console.log(JSON.stringify({
  datasetId: process.env.MATHNET_DATASET_ID ?? "ShadenA/MathNet",
  revision: process.env.MATHNET_RELEASE_REVISION || null,
  sourceFile: file,
  sourceChecksumSha256: checksum(JSON.stringify(rows)),
  rowCount: rows.length,
  columns,
  licenses,
  exclusionCounts,
  sample: normalized.slice(0, 3).map(({ raw: _raw, solution, ...row }) => ({ ...row, solutionPreview: solution?.slice(0, 240) ?? null })),
}, null, 2));
