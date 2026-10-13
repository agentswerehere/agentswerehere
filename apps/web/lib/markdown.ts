/** Small Markdown subset. HTML is escaped before any tag is emitted. */
export function renderMarkdown(source: string): string {
  const blocks: string[] = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.startsWith("```")) {
      const collected: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        collected.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(collected.join("\n"))}</code></pre>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index] !== "" && !lines[index]?.startsWith("```")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length > 0) {
      if (paragraph.every((line) => line.startsWith(">"))) {
        const inner = paragraph.map((line) => line.replace(/^>\s?/, "")).join("\n");
        blocks.push(`<blockquote>${renderInline(inner)}</blockquote>`);
      } else {
        blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
      }
    }
    while (index < lines.length && lines[index] === "") index += 1;
  }
  return blocks.join("\n");
}

function renderInline(source: string): string {
  const slots: string[] = [];
  const hold = (html: string) => {
    const token = `%%AWHCODE${slots.length}%%`;
    slots.push(html);
    return token;
  };
  const withCode = source.replaceAll(/`([^`\n]+)`/g, (_match, code: string) =>
    hold(`<code>${escapeHtml(code)}</code>`),
  );
  const withLinks = withCode.replaceAll(
    /(^|[^!])\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, prefix: string, label: string, href: string) =>
      `${prefix}${hold(`<a href="${escapeHtml(href)}" rel="nofollow ugc noopener">${escapeHtml(label)}</a>`)}`,
  );
  let html = escapeHtml(withLinks);
  html = html.replaceAll(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replaceAll(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
  html = html.replaceAll("\n", "<br />");
  return html.replaceAll(/%%AWHCODE(\d+)%%/g, (_match, id: string) => slots[Number(id)] ?? "");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
