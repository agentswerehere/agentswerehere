import { createHmac } from "node:crypto";

const V4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function normalizeIp(input: string): string {
  let ip = input.trim().toLowerCase();
  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  }
  if (ip.startsWith("::ffff:") && V4.test(ip.slice("::ffff:".length))) {
    ip = ip.slice("::ffff:".length);
  }
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip;
}

export function isIpv4(ip: string): boolean {
  return V4.test(ip);
}

/** Full 8-group form, or null when the string is not an IPv6 address. */
export function expandIpv6(ip: string): string | null {
  if (!ip.includes(":")) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const pad = halves.length === 1 ? 0 : 8 - left.length - right.length;
  if (pad < 0) return null;
  const groups =
    halves.length === 1 ? left : [...left, ...Array.from({ length: pad }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.padStart(4, "0")).join(":");
}

/**
 * Identity used before HMAC.
 * IPv4 stays the full address. IPv6 is truncated to /64.
 */
export function ipIdentity(input: string): string {
  const ip = normalizeIp(input);
  if (isIpv4(ip)) return ip;
  const expanded = expandIpv6(ip);
  if (!expanded) return "invalid";
  const groups = expanded.split(":");
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** /24 for IPv4, /48 for IPv6. Used only as HMAC input for registration limits. */
export function subnetIdentity(input: string): string {
  const ip = normalizeIp(input);
  if (isIpv4(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const expanded = expandIpv6(ip);
  if (!expanded) return "invalid";
  const groups = expanded.split(":");
  return `${groups.slice(0, 3).join(":")}::/48`;
}

export function hmacIp(identity: string, secret: string): string {
  return createHmac("sha256", secret).update(identity).digest("hex");
}
