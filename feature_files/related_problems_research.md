# Related Problems Research

## Summary
Related-problem research prepares or accepts a checked solution, labels its reusable solution mechanism, narrows MathNet by the statement-level topic category, and reranks catalog problems by their solution ideas. MathOverflow is searched before Math Stack Exchange, with an AI-constructed checked reference as the existing fallback.

## Key Points
- A user-supplied solution and a retrieved community solution pass through the same extraction and independent checking gate before their key ideas are trusted.
- MathNet `topics_flat` paths define the catalog category boundary; broad categories never count as matching solution ideas.
- MathNet solution profiles are cached by statement and solution hashes plus classifier version in `data/mathnet_ideas.json`, allowing index rebuilds to skip unchanged classification work.
- Current MathNet rows may contain `problem_markdown`, multiple `solutions_markdown` values, and hierarchical `topics_flat`; import normalization handles those native fields.
- Recommendation cards expose statements and spoiler-safe relationship text, never source solutions or hidden idea evidence.

## Relevant Files
- `src/lib/ai/preparation.ts` and `src/lib/stackexchange/client.ts`: Solution discovery, attribution, and checking.
- `src/lib/mathnet/classify.ts`, `src/lib/mathnet/categories.ts`, and `src/lib/mathnet/retrieval.ts`: Category/idea separation and matching.
- `scripts/mathnet-common.ts`, `scripts/mathnet-import.ts`, and `scripts/mathnet-build-index.ts`: Dataset normalization, indexing, and JSON cache maintenance.
- `data/mathnet_ideas.json`: Versioned public cache of MathNet solution idea profiles.
- `src/jobs/functions/prepare-reference.ts`, `src/jobs/functions/classify-problem.ts`, and `src/jobs/functions/recommend-problems.ts`: Durable research orchestration.

## Dev Mode
TESTING

## State Log
- 2026-09-16: Implemented checked-solution-first research, MathOverflow-first lookup, MathNet topic gating, native schema normalization, and the reusable `mathnet_ideas.json` idea cache.
