/**
 * Lexical retrieval primitives.
 *
 * Firestore has no full-text search, so each catalog record stores a bounded,
 * deduplicated list of stemmed terms and queries use `array-contains-any` over
 * the query's most distinctive terms. Scoring then happens in memory over the
 * bounded candidate set. This is deliberately simple: lexical retrieval is the
 * lowest-weighted leg of the fusion, behind idea and statement embeddings.
 */

const STOP_WORDS = new Set(
  (
    "a an the and or of to in on for with is are be was were that this these those it its as at by from into " +
    "if then than so such not no nor all any each which who whom what when where how let find prove show " +
    "determine given suppose assume every there exists exist we can does do have has had also only both " +
    "either between over under other some more most many much such very just number numbers problem solution " +
    "positive integer integers real reals value values point points line lines set sets function functions " +
    "least greatest possible i ii iii iv one two three four five six seven eight nine ten"
  ).split(/\s+/),
);

/** Trims common suffixes; enough to fold plurals and simple verb forms together. */
export function stem(word: string): string {
  let term = word;
  for (const suffix of ["ations", "ation", "ities", "ness", "ments", "ment", "ings", "ing", "ies", "ers", "er", "ed", "es", "s"]) {
    if (term.length > suffix.length + 3 && term.endsWith(suffix)) {
      term = term.slice(0, -suffix.length);
      if (suffix === "ies") term += "y";
      break;
    }
  }
  return term;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\\[a-z]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word.length <= 32 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .map(stem)
    .filter((term) => term.length >= 3);
}

/** Terms stored on a catalog record: most frequent first, capped for index size. */
export function documentTerms(text: string, maxTerms = 400): string[] {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/** Query terms: rarest-looking (longest, least repeated) first, bounded for `array-contains-any`. */
export function queryTerms(text: string, maxTerms = 30): string[] {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/** Overlap score with a small idea-tag bonus, mirroring the earlier SQL ranking. */
export function lexicalScore(documentTerms: string[], query: string[], sharedIdeaTags: number): number {
  const set = new Set(documentTerms);
  let matched = 0;
  for (const term of query) if (set.has(term)) matched += 1;
  return (query.length ? matched / query.length : 0) + (sharedIdeaTags > 0 ? 0.5 : 0);
}
