import { clearWebReadCache } from "../../../lib/api";
import { readEnv } from "../../../lib/read-env";
import { revalidateAuthorized } from "../../../lib/revalidate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = readEnv("CLOUDFLARE_ORIGIN_SECRET") ?? "";
  const presented = request.headers.get("x-awh-edge-secret") ?? "";
  if (!(await revalidateAuthorized(expected, presented))) {
    return new Response("This service only accepts traffic from the edge.", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  clearWebReadCache();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
