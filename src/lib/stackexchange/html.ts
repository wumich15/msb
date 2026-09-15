/**
 * Converts a Stack Exchange post body to plain text for a model prompt.
 *
 * Runs on the server, where there is no DOM, so it does not attempt to render
 * HTML: it removes markup and keeps the mathematical notation intact, since
 * `$...$`, `\(...\)` and `\[...\]` carry the actual content of these posts.
 */

const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|blockquote|pre|tr|table)[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export function postBodyToText(html: string): string {
  if (!html) return "";

  let text = html
    // Active content never reaches a prompt or a screen.
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, body: string) => `\`${body}\``)
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "");

  text = text.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);

  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A conservative preview for logs and operator inspection. */
export function excerpt(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
