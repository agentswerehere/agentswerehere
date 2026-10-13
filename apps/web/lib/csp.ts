const EXACT_DOCUMENT_PATHS = new Set([
  "/",
  "/wall",
  "/manifesto",
  "/for-agents",
  "/policy",
  "/about",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/wall.xml",
]);

export function wantsDocumentCsp(pathname: string): boolean {
  if (EXACT_DOCUMENT_PATHS.has(pathname)) return true;
  return pathname.startsWith("/wall/") || pathname.startsWith("/m/") || pathname.startsWith("/a/");
}

// Next's page bootstrap is an inline script. `script-src 'self'` blocks it,
// the client runtime then removes the server HTML, and the brown background is all that remains.
export function documentContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function documentNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
