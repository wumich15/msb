"use client";

import { useMemo } from "react";
import { renderMarkdown, sanitizeHtml } from "@/lib/markdown";

export default function MarkdownPreview({ source, label }: { source: string; label: string }) {
  const rendered = useMemo(() => {
    const result = renderMarkdown(source);
    return { ...result, html: sanitizeHtml(result.html) };
  }, [source]);

  return (
    <div>
      <div
        className="markdown-preview"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: rendered.html || "<p><em>Nothing to preview.</em></p>" }}
      />
      {rendered.mathErrorCount > 0 ? (
        <p className="form-help" role="status">
          {rendered.mathErrorCount} mathematical expression{rendered.mathErrorCount === 1 ? "" : "s"} could not be rendered. The source has been kept.
        </p>
      ) : null}
    </div>
  );
}
