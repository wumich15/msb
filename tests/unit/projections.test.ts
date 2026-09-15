import { describe, expect, it } from "vitest";
import { projectIdeaTags, projectJob } from "@/lib/db/projections";
import type { IdeaProfilePrivateRow, JobRow } from "@/lib/db/types";

const profile = {
  safe_tags: ["algebra"], idea_ids: ["invariant"], mechanism: "A hidden trick", confidence: 0.9,
  evidence_kind: "checked_reference", is_provisional: false,
} as IdeaProfilePrivateRow;

describe("safe browser projections", () => {
  it("hides solution-derived details before completion", () => {
    expect(projectIdeaTags(profile, { problemComplete: false, explicitlyRevealed: false })).toMatchObject({
      safeTags: ["algebra"], ideaIds: [], mechanism: null,
    });
  });

  it("shows the complete profile after completion", () => {
    expect(projectIdeaTags(profile, { problemComplete: true, explicitlyRevealed: false })?.ideaIds).toEqual(["invariant"]);
  });

  it("never includes raw worker results in a job projection", () => {
    const projected = projectJob({ id: "j", job_type: "prepare-reference", run_state: "SUCCEEDED", stage: null, attempts: 1,
      error_code: null, created_at: "now", updated_at: "now", result: { reference: "secret" } } as unknown as JobRow);
    expect(projected).not.toHaveProperty("result");
  });
});
