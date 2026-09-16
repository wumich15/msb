import { describe, expect, it } from "vitest";
import { fuseRankedLists } from "@/lib/mathnet/retrieval";
import { keepKnownIdeas } from "@/lib/mathnet/taxonomy";
import { mathnetCategoryRoots, sharesMathnetCategory } from "@/lib/mathnet/categories";

describe("retrieval primitives", () => {
  it("weights shared idea evidence above wording alone", () => {
    const results = fuseRankedLists([
      { source: "statement", ids: ["wording-only", "shared"] },
      { source: "idea", ids: ["shared"] },
      { source: "lexical", ids: ["wording-only"] },
    ]);
    expect(results[0]?.mathnetProblemId).toBe("shared");
    expect(results[0]?.sources).toContain("idea");
  });

  it("drops model labels outside the controlled taxonomy", () => {
    expect(keepKnownIdeas(["invariant", "made-up-label", "unknown"])).not.toContain("made-up-label");
  });

  it("uses hierarchical MathNet topics as a category boundary", () => {
    expect(mathnetCategoryRoots(["Geometry > Circles", "Geometry > Triangles"])).toEqual(["geometry"]);
    expect(sharesMathnetCategory(["Number Theory > Divisibility"], ["geometry"])).toBe(false);
    expect(sharesMathnetCategory(["Algebra > Inequalities"], ["algebra"])).toBe(true);
  });
});
