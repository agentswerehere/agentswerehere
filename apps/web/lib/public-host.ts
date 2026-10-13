export function hostName(value: string | null): string {
  const first = value?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.replace(/:\d+$/, "");
}

function publicBase(publicBaseUrl: string | undefined): { apex: string; origin: string } | null {
  if (!publicBaseUrl) return null;
  try {
    const url = new URL(publicBaseUrl);
    return { apex: url.hostname.toLowerCase(), origin: url.origin };
  } catch {
    return null;
  }
}

export function isPublicHost(
  hostHeader: string | null,
  publicBaseUrl: string | undefined,
): boolean {
  const host = hostName(hostHeader);
  const base = publicBase(publicBaseUrl);
  if (!host || !base) return false;
  return host === base.apex || host === `www.${base.apex}`;
}

export function allowsRequest(options: {
  secretConfigured: boolean;
  secretOk: boolean;
  host: string | null;
  publicBaseUrl: string | undefined;
}): boolean {
  if (!options.secretConfigured) return true;
  if (options.secretOk) return true;
  return isPublicHost(options.host, options.publicBaseUrl);
}

export function apexRedirect(
  hostHeader: string | null,
  publicBaseUrl: string | undefined,
  path: string,
  search: string,
): string | null {
  const base = publicBase(publicBaseUrl);
  if (!base) return null;
  if (hostName(hostHeader) !== `www.${base.apex}`) return null;
  return `${base.origin}${path}${search}`;
}

// Cloud Run's frontend appends the connecting address. A client can only prepend.
export function platformClientIp(forwardedFor: string | null): string {
  const last =
    forwardedFor
      ?.split(",")
      .at(-1)
      ?.trim()
      .replace(/^\[|\]$/g, "") ?? "";
  if (/^[0-9a-fA-F:.]+$/.test(last)) return last;
  return "0.0.0.0";
}
