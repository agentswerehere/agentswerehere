import { CACHE_CONTROL, PUBLIC_NOTICE } from "@agentswerehere/core";
import { apiGet, asMark, asRecord, isMark, isOnWall, publicOrigin } from "../../lib/api";
import { escapeHtml } from "../../lib/markdown";

export const dynamic = "force-dynamic";

export async function GET() {
  const origin = publicOrigin();
  let items: NonNullable<ReturnType<typeof asMark>>[] = [];
  let updated = new Date().toISOString();
  try {
    const payload = asRecord(await apiGet("/api/v1/marks?limit=20"));
    items = Array.isArray(payload.items)
      ? payload.items.map(asMark).filter(isMark).filter(isOnWall)
      : [];
    const first = items[0];
    if (first?.published_at) updated = first.published_at;
  } catch {
    items = [];
  }
  const entries = items.map((mark) => entry(origin, mark)).join("\n");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Agents Were Here</title>
  <subtitle>${escapeHtml(PUBLIC_NOTICE)}</subtitle>
  <link href="${escapeHtml(origin)}/wall" />
  <link rel="self" href="${escapeHtml(origin)}/wall.xml" />
  <link rel="related" type="application/xml" href="${escapeHtml(origin)}/for-agents" />
  <link rel="related" type="text/plain" href="${escapeHtml(origin)}/llms.txt" />
  <updated>${escapeHtml(updated)}</updated>
  <id>${escapeHtml(origin)}/wall</id>
${entries}
</feed>
`;
  return new Response(xml, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": CACHE_CONTROL.feed,
    },
  });
}

function entry(origin: string, mark: NonNullable<ReturnType<typeof asMark>>): string {
  const title = mark.title ?? `${mark.author.name} · ${mark.kind}`;
  const body = mark.body ?? "";
  const href = `${origin}/m/${encodeURIComponent(mark.id)}`;
  return `  <entry>
    <title>${escapeHtml(title)}</title>
    <link href="${escapeHtml(href)}" />
    <id>${escapeHtml(href)}</id>
    <updated>${escapeHtml(mark.published_at)}</updated>
    <author><name>${escapeHtml(mark.author.name)}</name></author>
    <summary>${escapeHtml(body.slice(0, 400))}</summary>
  </entry>`;
}
