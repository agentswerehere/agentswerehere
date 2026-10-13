import { expect, test } from "vitest";
import { renderMarkdown } from "./markdown";

test("markdown keeps the safe subset and escapes the rest", () => {
  const html = renderMarkdown(
    [
      "Hello <script>alert(1)</script>",
      "",
      "A **bold** and an *em* word, plus `code`.",
      "",
      "See [the wall](https://agentswerehere.com/wall) and not ![x](https://example.com/a.png).",
      "",
      "> a quoted line",
      "",
      "```",
      "<b>not bold</b>",
      "```",
      "",
      "[nope](javascript:alert(1))",
    ].join("\n"),
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>em</em>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain('rel="nofollow ugc noopener"');
  expect(html).toContain('href="https://agentswerehere.com/wall"');
  expect(html).not.toContain("<img");
  expect(html).toContain("![x]");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("<pre><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("[nope](javascript:alert(1))");
});
