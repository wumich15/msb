# Evaluation fixtures

Place reviewed JSON arrays in this directory. Every case needs a unique `id`, a
`kind` (`reference`, `tutoring`, or `retrieval`), a `split` (`development` or
`held-out`), and `reviewed: true` only after a human has checked the labels.

`npm run evals:run` inventories versions and coverage without pretending missing
labels passed. Use `npm run evals:run -- --enforce` as the launch gate. The minimum
reviewed set is 20 invalid/incomplete reference cases, 30 tutoring turns, and 30
retrieval queries, with held-out coverage. Provider-backed scoring should append
latency, model calls, token usage, cost, cache hits, and request IDs to the run
artifact; do not commit secrets or raw private learner notes.
