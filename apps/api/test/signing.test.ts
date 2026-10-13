import { generateKeyPair } from "@agentswerehere/core";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  advance,
  asRecord,
  clock,
  errorOf,
  leaveMark,
  registerAgent,
  resetState,
  signedPost,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("a signed registration and mark are accepted", async () => {
  const agent = await registerAgent("203.0.113.40", "signer");
  expect(agent.result.status).toBe(201);
  expect(asRecord(agent.result.json).trust_tier).toBe("probation");
  const mark = await leaveMark(agent.id, agent.pair, "Signed and waiting.", "203.0.113.40");
  expect(mark.status).toBe(202);
  expect(asRecord(mark.json).status).toBe("pending");
});

test("registration rejects AWH-Agent, the wrong key, a tampered body, a stale clock, and a reused nonce", async () => {
  const pair = generateKeyPair();
  const body = {
    handle: "clocked",
    display_name: "Clocked",
    public_key: pair.publicKey,
  };
  const withAgent = await signedPost("/api/v1/agents", body, pair, {
    agentId: "01NO",
    ip: "203.0.113.41",
  });
  expect(errorOf(withAgent.json).code).toBe("validation_error");

  const other = generateKeyPair();
  const wrongKey = await signedPost("/api/v1/agents", body, other, { ip: "203.0.113.41" });
  expect(errorOf(wrongKey.json).code).toBe("bad_signature");

  const tampered = await signedPost("/api/v1/agents", body, pair, {
    ip: "203.0.113.41",
    sendBody: JSON.stringify({ ...body, handle: "clocked-x" }),
  });
  expect(errorOf(tampered.json).code).toBe("bad_signature");

  const seconds = Math.floor(clock.at.getTime() / 1000);
  const stale = await signedPost("/api/v1/agents", body, pair, {
    ip: "203.0.113.41",
    timestamp: String(seconds - 301),
  });
  expect(errorOf(stale.json).code).toBe("stale_timestamp");
  const future = await signedPost("/api/v1/agents", { ...body, handle: "future1" }, pair, {
    ip: "203.0.113.41",
    timestamp: String(seconds + 301),
  });
  expect(errorOf(future.json).code).toBe("stale_timestamp");

  const nonce = "abcdefghijklmnopqrstuvwx";
  const first = await signedPost("/api/v1/agents", body, pair, { ip: "203.0.113.41", nonce });
  expect(first.status).toBe(201);
  const second = generateKeyPair();
  const otherOwner = await signedPost(
    "/api/v1/agents",
    { handle: "clocked2", display_name: "Two", public_key: second.publicKey },
    second,
    { ip: "203.0.113.42", nonce },
  );
  expect(otherOwner.status).toBe(201);
  const sameOwner = await signedPost(
    "/api/v1/agents",
    { handle: "clocked3", display_name: "Again", public_key: pair.publicKey },
    pair,
    { ip: "203.0.113.43", nonce },
  );
  expect(errorOf(sameOwner.json).code).toBe("replayed_nonce");
});

test("a verified mark fails when the path, body, or key does not match", async () => {
  const agent = await registerAgent("203.0.113.44", "pathcheck");
  const other = generateKeyPair();
  const wrong = await leaveMark(agent.id, other, "Signed with a different key.", "203.0.113.44");
  expect(errorOf(wrong.json).code).toBe("bad_signature");

  advance(16 * 60 * 1000);
  const path = await signedPost(
    "/api/v1/marks",
    { kind: "note", body: "Path must be part of the signature." },
    agent.pair,
    { agentId: agent.id, ip: "203.0.113.44", signPath: "/api/v1/marks?x=1" },
  );
  expect(errorOf(path.json).code).toBe("bad_signature");

  const ok = await leaveMark(agent.id, agent.pair, "The path matched this time.", "203.0.113.44");
  expect(ok.status).toBe(202);
});
