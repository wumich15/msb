import { prepareReferenceFunction } from "@/jobs/functions/prepare-reference";
import { respondToQuestionFunction } from "@/jobs/functions/respond-to-question";
import { classifyProblemFunction } from "@/jobs/functions/classify-problem";
import { recommendProblemsFunction } from "@/jobs/functions/recommend-problems";
import { exportWorkspaceFunction } from "@/jobs/functions/export-workspace";
import { expireExportsFunction, reconcileJobsFunction } from "@/jobs/functions/reconcile";

export const jobFunctions = [
  prepareReferenceFunction,
  respondToQuestionFunction,
  classifyProblemFunction,
  recommendProblemsFunction,
  exportWorkspaceFunction,
  reconcileJobsFunction,
  expireExportsFunction,
];
