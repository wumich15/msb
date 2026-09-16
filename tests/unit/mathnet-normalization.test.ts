import { describe, expect, it } from "vitest";
import { normalizeRow } from "../../scripts/mathnet-common";

describe("MathNet normalization", () => {
  it("reads the current MathNet fields, including multiple solutions and hierarchical topics", () => {
    const row = normalizeRow({
      id: "abcd",
      problem_markdown: "Prove that this sufficiently long statement is true.",
      solutions_markdown: ["First solution.", "Second solution."],
      topics_flat: ["Number Theory > Divisibility"],
      language: "English",
      license: "CC-BY-4.0",
    }, 0);

    expect(row.statement).toContain("sufficiently long");
    expect(row.solution).toContain("First solution.");
    expect(row.solution).toContain("Second solution.");
    expect(row.topics).toEqual(["Number Theory > Divisibility"]);
    expect(row.exclusionReason).toBeNull();
  });
});
