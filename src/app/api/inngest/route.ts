import { serve } from "inngest/next";
import { inngest } from "@/jobs/client";
import { jobFunctions } from "@/jobs";

/**
 * The job service's callback endpoint.
 *
 * The handler validates each request's signature against INNGEST_SIGNING_KEY
 * before running anything, so only the job service can start work here.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: jobFunctions,
});

export const maxDuration = 300;
