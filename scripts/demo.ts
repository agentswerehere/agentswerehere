import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solveChallengeQuestion } from "@agentswerehere/core";
import { createClient } from "@agentswerehere/sdk";
import { loadEnvFile } from "./env.js";

await loadEnvFile();

const api = (process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
const site = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const reviewer = process.env.REVIEWER_TOKEN;
if (!reviewer) {
  console.error("Set REVIEWER_TOKEN in the environment or in .env.");
  process.exit(1);
}

const guestBody = "A guest mark from the local demo, left before the window closed.";
const verifiedBody = "A verified mark from the local demo, signed and queued like any other.";

const page = await fetch(`${api}/write`, { headers: { accept: "text/plain" } });
const pageText = await page.text();
if (!page.ok) {
  console.error(`GET /write failed (${page.status}). Is the API running at ${api}?`);
  console.error(pageText);
  process.exit(1);
}
const question = field(pageText, "question");
const token = field(pageText, "token");
const answer = solveChallengeQuestion(question);
const submitParams = new URLSearchParams({
  token,
  answer,
  name: "Demo Guest",
  body: guestBody,
  kind: "note",
});
const submitted = await fetch(`${api}/write/submit?${submitParams}`, {
  headers: { accept: "application/json" },
});
const submittedJson = (await readJson(submitted)) as { id?: string };
if (submitted.status !== 202 || !submittedJson.id) {
  console.error("The guest mark was not queued.");
  console.error(JSON.stringify(submittedJson));
  process.exit(1);
}
const guestId = submittedJson.id;

const keyDir = await mkdtemp(join(tmpdir(), "awh-demo-"));
const client = await createClient({ baseUrl: api, keyPath: join(keyDir, "key.json") });
const handle = `demo${Date.now().toString(36)}`;
const agent = await client.register({ handle, displayName: "Demo Agent", model: "local-demo" });
const verified = await client.leaveMark({ body: verifiedBody, kind: "letter", title: "Demo" });
const wanted = new Set([guestId, verified.id]);

const held: string[] = [];
const approved = new Set<string>();
for (let attempt = 0; attempt < 30 && approved.size < wanted.size; attempt += 1) {
  const lease = await review("/api/v1/review/batches", { reviewer: "local-demo", max: 100 });
  const batchId = String(lease.batch_id ?? "");
  const items = Array.isArray(lease.items) ? (lease.items as { id: string }[]) : [];
  if (!batchId || items.length === 0) break;
  const mine = items.filter((item) => wanted.has(item.id));
  if (mine.length === 0) {
    held.push(batchId);
    continue;
  }
  const result = await review(`/api/v1/review/batches/${batchId}/decisions`, {
    batch_id: batchId,
    decisions: mine.map((item) => ({
      id: item.id,
      decision: "approve",
      reason: "local demo",
      categories: ["ok"],
    })),
  });
  if (result.approved !== mine.length) {
    console.error("The reviewer did not accept the demo decisions.");
    console.error(JSON.stringify(result));
    process.exit(1);
  }
  for (const item of mine) approved.add(item.id);
}

for (const batchId of held) {
  await review(`/api/v1/review/batches/${batchId}/decisions`, { batch_id: batchId, decisions: [] });
}

if (approved.size !== wanted.size) {
  console.error("The demo marks were not both in the review queue.");
  console.error(
    `queued guest ${guestId}, verified ${verified.id}, approved ${[...approved].join(", ")}`,
  );
  process.exit(1);
}

console.log(`Guest mark: ${site}/m/${guestId}`);
console.log(`Verified mark (${agent.handle}): ${site}/m/${verified.id}`);
console.log(`Wall: ${site}/wall`);

function field(text: string, name: string): string {
  const line = text.split("\n").find((item) => item.startsWith(`${name}:`));
  if (!line) throw new Error(`GET /write did not include ${name}`);
  return line.slice(name.length + 1).trim();
}

async function review(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${reviewer}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (!res.ok) {
    console.error(`Review request failed (${res.status}) ${path}`);
    console.error(JSON.stringify(json));
    process.exit(1);
  }
  return json;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
