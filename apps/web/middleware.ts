import { cacheControlForWebPath } from "@agentswerehere/core/cache";
import { type NextRequest, NextResponse } from "next/server";
import { documentContentSecurityPolicy, documentNonce, wantsDocumentCsp } from "./lib/csp";
import { digestsMatch } from "./lib/edge-secret";
import { allowsRequest, apexRedirect } from "./lib/public-host";
import { readEnv } from "./lib/read-env";

export async function middleware(request: NextRequest) {
  if (
    process.env.NODE_ENV === "production" &&
    (!readEnv("CLOUDFLARE_ORIGIN_SECRET") || !readEnv("PUBLIC_BASE_URL"))
  ) {
    throw new Error("CLOUDFLARE_ORIGIN_SECRET and PUBLIC_BASE_URL are required in production");
  }
  const expected = readEnv("CLOUDFLARE_ORIGIN_SECRET") ?? "";
  const presented = request.headers.get("x-awh-edge-secret") ?? "";
  const secretOk = expected !== "" && (await digestsMatch(presented, expected));
  const host = request.headers.get("host");
  const publicBaseUrl = readEnv("PUBLIC_BASE_URL");
  if (!allowsRequest({ secretConfigured: expected !== "", secretOk, host, publicBaseUrl })) {
    return new NextResponse("This service only accepts traffic from the edge.", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  const canonical = apexRedirect(
    host,
    publicBaseUrl,
    request.nextUrl.pathname,
    request.nextUrl.search,
  );
  if (canonical) return NextResponse.redirect(canonical, 308);
  const requestHeaders = new Headers(request.headers);
  const csp =
    process.env.NODE_ENV === "production" && wantsDocumentCsp(request.nextUrl.pathname)
      ? documentContentSecurityPolicy(documentNonce())
      : undefined;
  if (csp) requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (csp) response.headers.set("Content-Security-Policy", csp);
  const cacheControl = cacheControlForWebPath(request.nextUrl.pathname);
  if (cacheControl) response.headers.set("Cache-Control", cacheControl);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
