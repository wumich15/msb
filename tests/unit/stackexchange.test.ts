import { describe, expect, it } from "vitest";
import { postBodyToText } from "@/lib/stackexchange/html";
import { attributionLine, licenseForPost } from "@/lib/stackexchange/license";

describe("Stack Exchange content handling", () => {
  it("removes active markup while preserving math", () => {
    const text = postBodyToText("<p>Let $x=1$.</p><script>alert(1)</script><code>x &lt; 2</code>");
    expect(text).toContain("$x=1$");
    expect(text).toContain("`x < 2`");
    expect(text).not.toContain("alert");
  });

  it("uses API-provided licenses and complete attribution", () => {
    expect(licenseForPost({ content_license: "CC BY-SA 4.0" })).toBe("CC BY-SA 4.0");
    expect(attributionLine({ author: "Ada", url: "https://example.test", license: "CC BY-SA 4.0" }))
      .toBe("Ada — https://example.test — CC BY-SA 4.0");
  });
});
