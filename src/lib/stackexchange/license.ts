/**
 * Stack Exchange content licensing.
 *
 * Contributions carry different CC BY-SA versions depending on when they were
 * made, so the applicable version is derived per post rather than assumed to be
 * one version for all content. When the API reports `content_license` directly,
 * that value wins.
 */

const BY_SA_3_START = Date.UTC(2011, 3, 8) / 1000; // 2011-04-08
const BY_SA_4_START = Date.UTC(2018, 4, 2) / 1000; // 2018-05-02

export function licenseForPost(post: {
  content_license?: string | null;
  creation_date?: number | null;
  last_edit_date?: number | null;
}): string {
  if (post.content_license) return post.content_license;
  // The licence follows the contribution date of the revision being reused.
  const seconds = post.last_edit_date ?? post.creation_date;
  if (!seconds) return "CC BY-SA (version depends on contribution date)";
  if (seconds >= BY_SA_4_START) return "CC BY-SA 4.0";
  if (seconds >= BY_SA_3_START) return "CC BY-SA 3.0";
  return "CC BY-SA 2.5";
}

export function attributionLine(credit: {
  author?: string;
  url: string;
  license: string;
  modificationNote?: string;
}): string {
  const parts = [
    credit.author ? `${credit.author}` : "Math Stack Exchange contributor",
    credit.url,
    credit.license,
  ];
  if (credit.modificationNote) parts.push(credit.modificationNote);
  return parts.join(" — ");
}
