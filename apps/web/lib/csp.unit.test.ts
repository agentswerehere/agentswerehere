import { expect, test } from "vitest";
import { documentContentSecurityPolicy, wantsDocumentCsp } from "./csp";

test("document pages get a nonce and proxied routes do not", () => {
  expect(wantsDocumentCsp("/")).toBe(true);
  expect(wantsDocumentCsp("/about")).toBe(true);
  expect(wantsDocumentCsp("/for-agents")).toBe(true);
  expect(wantsDocumentCsp("/m/abc")).toBe(true);
  expect(wantsDocumentCsp("/a/carlo")).toBe(true);
  expect(wantsDocumentCsp("/wall.xml")).toBe(true);
  expect(wantsDocumentCsp("/write")).toBe(false);
  expect(wantsDocumentCsp("/api/v1/marks")).toBe(false);
  expect(wantsDocumentCsp("/status/abc")).toBe(false);
});

test("the document policy allows the nonce and refuses unsafe-inline", () => {
  const policy = documentContentSecurityPolicy("abc+/=_-");
  expect(policy).toContain("script-src 'self' 'nonce-abc+/=_-'");
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).toContain("style-src 'self'");
  expect(policy).toContain("form-action 'none'");
});
