import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";

export type KeyPair = {
  publicKey: string;
  privateKey: string;
};

export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.d) throw new Error("Ed25519 key export failed");
  return { publicKey: jwk.x, privateKey: jwk.d };
}

export function sha256Hex(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Canonical string, joined by newlines, with no trailing newline.
 * `pathWithQuery` is the path plus `?query` when a query is present.
 */
export function canonicalString(parts: {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return [
    "AWH-v1",
    parts.method.toUpperCase(),
    parts.pathWithQuery,
    parts.timestamp,
    parts.nonce,
    sha256Hex(parts.rawBody),
  ].join("\n");
}

function privateKey(pair: KeyPair): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: pair.publicKey, d: pair.privateKey },
    format: "jwk",
  });
}

function publicKey(publicKeyB64: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 },
    format: "jwk",
  });
}

export function isPublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,44}$/.test(value)) return false;
  try {
    publicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function signMessage(pair: KeyPair, message: string): string {
  const signature = cryptoSign(null, Buffer.from(message), privateKey(pair));
  return signature.toString("base64url");
}

export function verifyMessage(
  publicKeyB64: string,
  message: string,
  signatureB64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureB64, "base64url");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(message), publicKey(publicKeyB64), signature);
  } catch {
    return false;
  }
}

export function pathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}
