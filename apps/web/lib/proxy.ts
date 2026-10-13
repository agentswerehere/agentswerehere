import { apiOrigin, applyEdgeSecret } from "./api";
import { digestsMatch } from "./edge-secret";
import { hostName, isPublicHost, platformClientIp } from "./public-host";
import { readEnv } from "./read-env";

export async function proxy(request: Request, path: string): Promise<Response> {
  const incoming = new URL(request.url);
  const headers = new Headers(request.headers);
  const host = headers.get("host");
  headers.delete("host");
  const expected = readEnv("CLOUDFLARE_ORIGIN_SECRET") ?? "";
  const presented = headers.get("x-awh-edge-secret") ?? "";
  const fromEdge = expected !== "" && (await digestsMatch(presented, expected));
  headers.delete("x-awh-edge-secret");
  if (!fromEdge) {
    headers.set("cf-connecting-ip", platformClientIp(headers.get("x-forwarded-for")));
    const publicBaseUrl = readEnv("PUBLIC_BASE_URL");
    if (isPublicHost(host, publicBaseUrl)) {
      headers.set("x-forwarded-host", hostName(host));
      headers.set("x-forwarded-proto", "https");
    }
  }
  applyEdgeSecret(headers);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetch(`${apiOrigin()}${path}${incoming.search}`, init);
  const outgoing = new Headers(response.headers);
  outgoing.delete("content-encoding");
  outgoing.delete("content-length");
  outgoing.delete("transfer-encoding");
  return new Response(response.body, { status: response.status, headers: outgoing });
}
