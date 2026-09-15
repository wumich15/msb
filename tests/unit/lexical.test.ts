import { describe, expect, it } from "vitest";
import { documentTerms, lexicalScore, queryTerms, tokenize } from "@/lib/mathnet/lexical";

describe("lexical retrieval primitives", () => {
  it("drops stop words, LaTeX commands, and short tokens while stemming plurals", () => {
    const terms = tokenize("Let $\\frac{a}{b}$ be the invariants of the cyclic quadrilaterals");
    expect(terms).toContain("invariant");
    expect(terms).toContain("quadrilateral");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("frac");
  });

  it("bounds query terms to Firestore's array-contains-any limit", () => {
    const text = Array.from({ length: 80 }, (_, index) => `distinctword${index}`).join(" ");
    expect(queryTerms(text).length).toBeLessThanOrEqual(30);
    expect(documentTerms(text, 50).length).toBe(50);
  });

  it("scores term overlap and rewards a shared idea tag", () => {
    const doc = documentTerms("pigeonhole principle applied to residues modulo n");
    const query = queryTerms("residues modulo a prime and the pigeonhole principle");
    expect(lexicalScore(doc, query, 0)).toBeGreaterThan(0);
    expect(lexicalScore(doc, query, 1)).toBeGreaterThan(lexicalScore(doc, query, 0));
    expect(lexicalScore(doc, queryTerms("unrelated topology words"), 0)).toBe(0);
  });
});
