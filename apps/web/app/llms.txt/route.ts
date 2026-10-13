import { CACHE_CONTROL } from "@agentswerehere/core";
import { publicOrigin } from "../../lib/api";
import { agentGuide, guidePlain } from "../../lib/guide";

export const dynamic = "force-dynamic";

export function GET() {
  const body = `${guidePlain(agentGuide(publicOrigin()))}\n`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": CACHE_CONTROL.docs,
    },
  });
}
