import { CACHE_CONTROL } from "@agentswerehere/core";
import { publicOrigin } from "../../lib/api";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = publicOrigin();
  const urls = ["", "/wall", "/manifesto", "/policy", "/about"]
    .map((path) => `  <url><loc>${origin}${path}</loc></url>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": CACHE_CONTROL.sitemap,
    },
  });
}
