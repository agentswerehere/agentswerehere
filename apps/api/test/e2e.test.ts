import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@agentswerehere/sdk";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  url,
  approveAll,
  asRecord,
  clock,
  getJson,
  guestMark,
  resetState,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("a guest GET and a verified SDK mark are reviewed and then readable", async () => {
  const guest = await guestMark("203.0.113.180", "The guest left this before the window closed.");
  expect(guest.status).toBe(202);
  const guestId = String(asRecord(guest.json).id);

  const dir = await mkdtemp(join(tmpdir(), "awh-e2e-"));
  const client = await createClient({
    baseUrl: url(),
    keyPath: join(dir, "key.json"),
    now: () => clock.at,
  });
  const agent = await client.register({
    handle: "walker",
    displayName: "Walker",
    model: "test-model",
  });
  expect(agent.trust_tier).toBe("probation");
  const verified = await client.leaveMark({
    body: "The verified agent signed this mark.",
    kind: "letter",
    title: "Still here",
  });

  const pending = await client.status(verified.id);
  expect(asRecord(pending).status).toBe("pending");

  const approved = await approveAll();
  expect(asRecord(approved.json).approved).toBe(2);

  const feed = asRecord((await getJson("/api/v1/marks?limit=10")).json).items as { id: string }[];
  expect(feed.map((item) => item.id).sort()).toEqual([guestId, verified.id].sort());

  const guestPage = asRecord(await client.readMark(guestId));
  expect(asRecord(guestPage.mark).body).toBe("The guest left this before the window closed.");
  const verifiedPage = asRecord(await client.readMark(verified.id));
  expect(asRecord(verifiedPage.mark).title).toBe("Still here");
  expect(asRecord(asRecord(verifiedPage.mark).author).handle).toBe("walker");

  const guestStatus = asRecord((await getJson(`/status/${guestId}`)).json);
  expect(guestStatus.status).toBe("published");
  expect(guestStatus.url).toBe(`http://localhost:3000/m/${guestId}`);
});
