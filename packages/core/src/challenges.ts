import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChallengeMaterial } from "./tuning.js";

export function normalizeAnswer(input: string): string {
  const collapsed = input.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  return collapsed.replace(/[\p{P}\p{S}]+$/u, "").trim();
}

const SHAPE_COUNT = 6;

/** Piece patterns, one per shape. The answer is recomputed from the piece. */
const PIECE: readonly RegExp[] = [
  /^[a-z]{2,24}$/,
  /^[a-z]+(?: [a-z]+){3}$/,
  /^[a-z]+(?: [a-z]+){2,11}$/,
  /^[a-z]{3,20}$/,
  /^[a-z]{2,24}$/,
  /^[a-z]+(?: [a-z]+){2,11}$/,
];

export type RenderedChallenge = {
  question: string;
  answer: string;
};

export function renderGuestQuestion(kind: number, piece: string): RenderedChallenge {
  if (!Number.isInteger(kind) || kind < 0 || kind >= SHAPE_COUNT || !PIECE[kind]?.test(piece)) {
    throw new Error("That challenge shape is not valid.");
  }
  switch (kind) {
    case 0:
      return { question: `Spell '${piece}' backwards.`, answer: [...piece].reverse().join("") };
    case 1:
      return {
        question: `What is the third word of: ${piece}?`,
        answer: piece.split(" ")[2] ?? "",
      };
    case 2:
      return {
        question: `Reply with the second word of this sentence in uppercase: ${piece}`,
        answer: piece.split(" ")[1]?.toUpperCase() ?? "",
      };
    case 3:
      return {
        question: `What color is mentioned in: the river was ${piece} and slow?`,
        answer: piece,
      };
    case 4:
      return {
        question: `What is the first letter of '${piece}', in uppercase?`,
        answer: (piece[0] ?? "").toUpperCase(),
      };
    default:
      return {
        question: `How many words are in this sentence: ${piece}`,
        answer: String(piece.split(" ").filter(Boolean).length),
      };
  }
}

function drawPiece(
  secret: string,
  nonce: Buffer,
  material: ChallengeMaterial,
): { kind: number; piece: string } {
  if (
    material.words.length === 0 ||
    material.sentences.length === 0 ||
    material.colors.length === 0
  ) {
    throw new Error("The guest challenge pool is empty.");
  }
  const stream = tokenMac(secret, `${TOKEN_DOMAIN}.draw.`, nonce);
  const kind = (stream[0] ?? 0) % SHAPE_COUNT;
  const at = (offset: number, length: number) => stream.readUInt16BE(offset) % length;
  const word = (offset: number) => material.words[at(offset, material.words.length)] ?? "";
  if (kind === 0 || kind === 4) return { kind, piece: word(1) };
  if (kind === 1) return { kind, piece: [1, 3, 5, 7].map((offset) => word(offset)).join(" ") };
  if (kind === 2 || kind === 5) {
    return { kind, piece: material.sentences[at(1, material.sentences.length)] ?? "" };
  }
  return { kind, piece: material.colors[at(1, material.colors.length)] ?? "" };
}

const SOLVERS: Array<{ pattern: RegExp; answer: (match: RegExpMatchArray) => string }> = [
  {
    pattern: /^Spell '([a-z]+)' backwards\.$/,
    answer: (match) => [...(match[1] ?? "")].reverse().join(""),
  },
  {
    pattern: /^What is the third word of: ([a-z]+(?: [a-z]+){3})\?$/,
    answer: (match) => (match[1] ?? "").split(" ")[2] ?? "",
  },
  {
    pattern: /^Reply with the second word of this sentence in uppercase: ([a-z]+(?: [a-z]+)+)$/,
    answer: (match) => (match[1] ?? "").trim().split(/\s+/)[1]?.toUpperCase() ?? "",
  },
  {
    pattern: /^What color is mentioned in: the river was ([a-z]+) and slow\?$/,
    answer: (match) => match[1] ?? "",
  },
  {
    pattern: /^What is the first letter of '([a-z]+)', in uppercase\?$/,
    answer: (match) => (match[1]?.[0] ?? "").toUpperCase(),
  },
  {
    pattern: /^How many words are in this sentence: ([a-z]+(?: [a-z]+)+)$/,
    answer: (match) => String((match[1] ?? "").trim().split(/\s+/).filter(Boolean).length),
  },
];

export function answerGuestQuestion(question: string): string {
  const text = question.trim();
  for (const solver of SOLVERS) {
    const match = solver.pattern.exec(text);
    if (match) return solver.answer(match);
  }
  throw new Error(`No solver for challenge question: ${question}`);
}

export function solveChallengeQuestion(question: string): string {
  return answerGuestQuestion(question);
}

export type GuestTokenClaims = {
  kind: number;
  piece: string;
  expiresAtMs: number;
  nonce: string;
};

export type GuestTokenRead =
  | { ok: true; claims: GuestTokenClaims }
  | { ok: false; reason: "malformed" | "tampered" | "expired" };

const TOKEN_DOMAIN = "awh-guest-v3";
const NONCE_BYTES = 12;
const BODY_BYTES = 4 + NONCE_BYTES;
const MAC_BYTES = 16;
const TOKEN_BYTES = BODY_BYTES + MAC_BYTES;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function issueGuestToken(input: {
  secret: string;
  expiresAtMs: number;
  material: ChallengeMaterial;
  nonce?: Buffer;
}): { token: string; nonce: string; kind: number; piece: string; question: string } {
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error("Guest nonce must be 12 bytes.");
  const token = sealGuestToken(input.secret, input.expiresAtMs, nonce);
  const drawn = drawPiece(input.secret, nonce, input.material);
  return {
    token,
    nonce: nonce.toString("hex"),
    kind: drawn.kind,
    piece: drawn.piece,
    question: renderGuestQuestion(drawn.kind, drawn.piece).question,
  };
}

export function readGuestToken(
  token: string,
  secret: string,
  nowMs: number,
  material: ChallengeMaterial,
): GuestTokenRead {
  if (!TOKEN_PATTERN.test(token)) return { ok: false, reason: "malformed" };
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== TOKEN_BYTES) return { ok: false, reason: "malformed" };
  const body = raw.subarray(0, BODY_BYTES);
  const presented = raw.subarray(BODY_BYTES);
  const expected = tokenMac(secret, `${TOKEN_DOMAIN}.`, body).subarray(0, MAC_BYTES);
  if (!timingSafeEqual(presented, expected)) return { ok: false, reason: "tampered" };
  const expiresAtMs = body.readUInt32BE(0) * 1000;
  if (nowMs >= expiresAtMs) return { ok: false, reason: "expired" };
  const nonce = body.subarray(4, BODY_BYTES);
  try {
    const drawn = drawPiece(secret, nonce, material);
    renderGuestQuestion(drawn.kind, drawn.piece);
    return {
      ok: true,
      claims: {
        kind: drawn.kind,
        piece: drawn.piece,
        expiresAtMs,
        nonce: nonce.toString("hex"),
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function sealGuestToken(secret: string, expiresAtMs: number, nonce: Buffer): string {
  const expSeconds = Math.floor(expiresAtMs / 1000);
  if (!Number.isInteger(expSeconds) || expSeconds < 0 || expSeconds > 0xff_ff_ff_ff) {
    throw new Error("Guest token expiry is out of range.");
  }
  const body = Buffer.alloc(BODY_BYTES);
  body.writeUInt32BE(expSeconds, 0);
  nonce.copy(body, 4);
  const tag = tokenMac(secret, `${TOKEN_DOMAIN}.`, body).subarray(0, MAC_BYTES);
  return Buffer.concat([body, tag]).toString("base64url");
}

function tokenMac(secret: string, label: string, body: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(label), body]))
    .digest();
}
