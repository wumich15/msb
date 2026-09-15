import { Inngest } from "inngest";
import type { JobType } from "@/lib/db/types";

/**
 * Events carry ids and versions only — never notes, statements, or reference
 * solutions. The worker loads authorized data itself and verifies ownership again.
 */
export interface JobEventData {
  jobId: string;
  userId: string;
  problemId?: string;
}

export const inngest = new Inngest({
  id: "math-study-buddy",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export const EVENT_NAME: Record<JobType, string> = {
  "prepare-reference": "msb/prepare-reference",
  "respond-to-question": "msb/respond-to-question",
  "classify-problem": "msb/classify-problem",
  "recommend-problems": "msb/recommend-problems",
  "export-workspace": "msb/export-workspace",
};
