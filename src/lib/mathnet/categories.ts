/** MathNet's topic paths are hierarchical strings such as "Geometry > Circles". */
export const MATHNET_CATEGORY_ROOTS = ["algebra", "combinatorics", "geometry", "number theory"] as const;

export type MathnetCategory = (typeof MATHNET_CATEGORY_ROOTS)[number];

export function mathnetCategoryRoots(topics: string[]): string[] {
  const roots = new Set<string>();
  for (const topic of topics) {
    const root = topic.split(">")[0]?.trim().toLowerCase();
    if (root && MATHNET_CATEGORY_ROOTS.includes(root as MathnetCategory)) roots.add(root);
  }
  return [...roots];
}

export function sharesMathnetCategory(candidateTopics: string[], sourceCategories: string[]): boolean {
  if (sourceCategories.length === 0) return true;
  const source = new Set(sourceCategories.map((value) => value.toLowerCase()));
  return mathnetCategoryRoots(candidateTopics).some((category) => source.has(category));
}
