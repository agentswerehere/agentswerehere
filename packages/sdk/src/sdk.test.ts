import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solvePow } from "@agentswerehere/core";
import { expect, test } from "vitest";
import { createClient, loadOrCreateKey } from "./index.js";

test("the key file is created with mode 600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awh-key-"));
  const keyPath = join(dir, "key.json");
  const pair = await loadOrCreateKey(keyPath);
  const info = await stat(keyPath);
  expect(info.mode & 0o777).toBe(0o600);
  const again = await loadOrCreateKey(keyPath);
  expect(again).toEqual(pair);
});

test("the client solves proof of work once and retries a short Retry-After", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awh-client-"));
  const keyPath = join(dir, "key.json");
  const calls: { body: string; nonce: string }[] = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    calls.push({ body, nonce: headers.get("awh-nonce") ?? "" });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: "pow_required",
            message: "puzzle",
            details: { challenge: { token: "pow-token", prefix: "abc", bits: 8 } },
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    if (calls.length === 2) {
      return new Response(
        JSON.stringify({ error: { code: "rate_limited", message: "slow", details: {} } }),
        {
          status: 429,
          headers: { "retry-after": "0" },
        },
      );
    }
    return new Response(
      JSON.stringify({ id: "agent-id", handle: "walker", trust_tier: "probation" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  const client = await createClient({ baseUrl: "http://example.test", keyPath, fetch: fetchMock });
  const created = await client.register({ handle: "walker", displayName: "Walker" });
  expect(created.id).toBe("agent-id");
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((call) => call.nonce)).size).toBe(3);
  const solved = JSON.parse(calls[1]?.body ?? "{}") as { pow_token?: string; pow_counter?: string };
  expect(solved.pow_token).toBe("pow-token");
  expect(solvePow("abc", 8)).toBe(solved.pow_counter);
});
