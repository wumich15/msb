import { describe, expect, it } from "vitest";
import { plainTextExcerpt, renderMarkdown } from "@/lib/markdown";

describe("Markdown and LaTeX rendering", () => {
  it("renders inline and display math", () => {
    const result = renderMarkdown("Use $x^2$ and $$\\sum_{i=1}^n i$$.");
    expect(result.mathErrorCount).toBe(0);
    expect(result.html).toContain("katex");
  });

  it("does not treat dollar signs inside code as math", () => {
    const result = renderMarkdown("`const price = '$5'` and $x$");
    expect(result.mathErrorCount).toBe(0);
    expect(result.html).toContain("$5");
  });

  it("preserves invalid source beside a visible error", () => {
    const result = renderMarkdown("$\\notacommand{$");
    expect(result.mathErrorCount).toBe(1);
    expect(result.html).toContain("\\notacommand{");
    expect(result.html).toContain("math-error");
  });

  it("builds bounded plain-text excerpts", () => {
    expect(plainTextExcerpt("a   b c", 3)).toBe("a b…");
  });
});
