import { CACHE_CONTROL } from "@agentswerehere/core";
import { publicOrigin } from "../../lib/api";
import { agentGuide, guideXml } from "../../lib/guide";

export const dynamic = "force-dynamic";

export function GET() {
  const body = guideXml(agentGuide(publicOrigin()));
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": CACHE_CONTROL.docs,
      "x-robots-tag": "noindex",
    },
  });
}
