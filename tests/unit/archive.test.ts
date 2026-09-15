import { describe, expect, it } from "vitest";
import { safeName } from "@/lib/export/archive";

describe("export filenames", () => {
  it("removes path traversal and separators", () => {
    const name = safeName("../../My \\ Problem?.md");
    expect(name).toBe("my-problemmd");
    expect(name).not.toMatch(/[\\/]/);
  });
});
