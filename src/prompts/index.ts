/**
 * Versioned prompts.
 *
 * Every prompt version is recorded with the artifact it produced, so an
 * evaluation run can be attributed to the exact wording that generated it. Change
 * the version string whenever the text changes.
 */

export { solverPrompt, extractorPrompt } from "./solver";
export { checkerPrompt } from "./checker";
export { tutorPrompt } from "./tutor";
export { classifierPrompt } from "./classifier";
export { rerankerPrompt } from "./reranker";
export { searchQueryPrompt, mseMatchPrompt } from "./stackexchange";
export { reviewerPrompt } from "./reviewer";
