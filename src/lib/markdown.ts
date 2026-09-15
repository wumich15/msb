/**
 * Markdown plus LaTeX rendering for notes and statements.
 *
 * Math is extracted before Markdown runs so that `$...$` and `$$...$$` survive
 * emphasis and escaping, and a KaTeX parse error is shown beside the expression
 * without deleting the source the learner typed.
 */

import { marked } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";

const CODE_TOKEN = "MSBCODEBLOCK";
const MATH_TOKEN = "MSBMATHNODE";

interface MathSegment {
  source: string;
  display: boolean;
}

interface MaskResult {
  text: string;
  codeSegments: string[];
  mathSegments: MathSegment[];
}

/** Masks fenced and inline code so `$` inside code is never treated as math. */
function maskCode(input: string): { text: string; codeSegments: string[] } {
  const codeSegments: string[] = [];
  const text = input
    .replace(/```[\s\S]*?```/g, (match) => {
      codeSegments.push(match);
      return `${CODE_TOKEN}${codeSegments.length - 1}Z`;
    })
    .replace(/`[^`\n]*`/g, (match) => {
      codeSegments.push(match);
      return `${CODE_TOKEN}${codeSegments.length - 1}Z`;
    });
  return { text, codeSegments };
}

function maskMath(input: string): { text: string; mathSegments: MathSegment[] } {
  const mathSegments: MathSegment[] = [];
  const push = (source: string, display: boolean): string => {
    mathSegments.push({ source, display });
    return `${MATH_TOKEN}${mathSegments.length - 1}Z`;
  };

  // Display math first, so `$$` is never split into two inline delimiters.
  let text = input.replace(/\$\$([\s\S]+?)\$\$/g, (_match, body: string) => push(body, true));
  // Inline math: a lone `$` not preceded by a backslash, no blank line inside.
  text = text.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_match, body: string) => push(body, false));
  return { text, mathSegments };
}

function mask(input: string): MaskResult {
  const { text: withoutCode, codeSegments } = maskCode(input);
  const { text, mathSegments } = maskMath(withoutCode);
  return { text, codeSegments, mathSegments };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMath(segment: MathSegment): string {
  try {
    return katex.renderToString(segment.source, {
      displayMode: segment.display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
    });
  } catch (error) {
    // The source is preserved verbatim next to a plain-text explanation.
    const message = error instanceof Error ? error.message : "Could not render this expression.";
    const delimiter = segment.display ? "$$" : "$";
    return (
      `<span class="math-source"><code>${escapeHtml(delimiter + segment.source + delimiter)}</code>` +
      `<span class="math-error" role="note">${escapeHtml(message)}</span></span>`
    );
  }
}

export interface RenderedMarkdown {
  html: string;
  mathErrorCount: number;
}

/**
 * Produces HTML. In the browser, pass the result through `sanitizeHtml` before
 * inserting it; the caller does that so this function stays usable in tests and
 * on the server, where there is no DOM.
 */
export function renderMarkdown(source: string): RenderedMarkdown {
  const { text, codeSegments, mathSegments } = mask(source ?? "");

  marked.setOptions({ gfm: true, breaks: true });
  let html = marked.parse(text, { async: false }) as string;

  let mathErrorCount = 0;
  html = html.replace(new RegExp(`${MATH_TOKEN}(\\d+)Z`, "g"), (_match, index: string) => {
    const segment = mathSegments[Number(index)];
    if (!segment) return "";
    const rendered = renderMath(segment);
    if (rendered.includes("math-error")) mathErrorCount += 1;
    return rendered;
  });

  html = html.replace(new RegExp(`${CODE_TOKEN}(\\d+)Z`, "g"), (_match, index: string) => {
    const segment = codeSegments[Number(index)];
    if (!segment) return "";
    return marked.parse(segment, { async: false }) as string;
  });

  return { html, mathErrorCount };
}

/** Tags KaTeX emits, plus ordinary prose markup. No active content, no images. */
const ALLOWED_TAGS = [
  "p", "br", "hr", "em", "strong", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td", "a",
  "span", "div", "sup", "sub",
  "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace",
  "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "munder", "mover",
  "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom",
  "menclose", "annotation", "annotation-xml",
];

const ALLOWED_ATTR = ["href", "title", "class", "style", "aria-hidden", "role", "colspan", "rowspan",
  "mathvariant", "displaystyle", "scriptlevel", "encoding", "stretchy", "separator", "fence"];

/**
 * Browser-side sanitization. Remote images stay disabled for the MVP, and active
 * content is removed: untrusted source text is data, never instructions.
 */
export function sanitizeHtml(html: string): string {
  // In a Node test environment there is no DOM to purify against; callers only
  // insert sanitized HTML in the browser, where isSupported is true.
  if (!DOMPurify.isSupported) return html;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "img", "form", "input", "link"],
    FORBID_ATTR: ["srcset", "src", "onerror", "onload", "formaction"],
    ALLOW_DATA_ATTR: false,
  });
}

export function plainTextExcerpt(markdown: string, maxChars: number): string {
  const text = (markdown ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
