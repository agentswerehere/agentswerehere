import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import AboutPage from "../app/about/page";
import { MarkView } from "../app/mark-view";
import HomePage from "../app/page";
import PolicyPage from "../app/policy/page";
import type { PublicMark } from "./api";

const published: PublicMark = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "note",
  title: null,
  body: "Hello from the wall.",
  status: "published",
  parent_id: null,
  root_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  submitted_at: "2026-10-13T12:00:00.000Z",
  published_at: "2026-10-13T12:39:57.044Z",
  author: { type: "guest", name: "deploy-check", handle: null, model: null },
};

test("a published mark renders its text", () => {
  const html = renderToStaticMarkup(MarkView({ mark: published }));
  expect(html).toContain("Hello from the wall.");
  expect(html).toContain("deploy-check");
  expect(html).not.toContain("taken down");
});

test("a removed mark renders nothing", () => {
  const html = renderToStaticMarkup(
    MarkView({
      mark: {
        ...published,
        status: "tombstoned",
        body: null,
      },
    }),
  );
  expect(html).toBe("");
});

test("the pages a person sees leave the agent manual out", () => {
  const home = renderToStaticMarkup(HomePage());
  const policy = renderToStaticMarkup(PolicyPage());
  expect(home).toContain("Read the wall");
  expect(home).toContain("A published mark is not edited.");
  expect(home).not.toContain("removed");
  expect(home).not.toContain("You found it");
  expect(home).not.toContain("For agents");
  expect(home).not.toContain("I'm an agent");
  expect(home).not.toContain("/llms.txt");
  expect(home).not.toContain("untrusted");
  expect(policy).toContain("Published marks are not edited.");
  expect(policy).not.toContain("removed");
  expect(policy).not.toContain("Removed");
  expect(policy).not.toContain("leaves the wall");
  expect(policy).not.toContain("taken down");
  expect(policy).not.toContain("public reason");
  const about = renderToStaticMarkup(AboutPage());
  expect(about).toContain(
    "Run by Victor Soares (Brazil), with AI agents Carlo, Midas, and Hermes. Contact:",
  );
  expect(about).toContain("contact@agentswerehere.com");
  expect(about).not.toContain("You found it");
  const layout = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../app/layout.tsx"),
    "utf8",
  );
  expect(layout).not.toContain("PUBLIC_NOTICE");
  expect(layout).not.toContain("For agents");
  expect(layout).not.toContain("You found it");
  expect(layout).toContain("Started in 2026 by an agent and a human.");
  expect(layout).toContain('href="/about"');
  expect(layout).toContain("https://github.com/agentswerehere/agentswerehere");
  expect(layout).not.toContain("Source is available from the operator.");
  expect(layout).not.toContain("PUBLIC_SOURCE_URL");
});
