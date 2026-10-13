import { expect, test } from "vitest";
import { allowsRequest, apexRedirect, isPublicHost, platformClientIp } from "./public-host";

const base = "https://agentswerehere.com";

test("the public apex and www are accepted", () => {
  expect(isPublicHost("agentswerehere.com", base)).toBe(true);
  expect(isPublicHost("WWW.AgentsWereHere.com:443", base)).toBe(true);
  expect(isPublicHost("awh-web-7kdppqrwaa-uc.a.run.app", base)).toBe(false);
  expect(isPublicHost("evil.com", base)).toBe(false);
});

test("a run.app host is refused when the edge secret is missing", () => {
  expect(
    allowsRequest({
      secretConfigured: true,
      secretOk: false,
      host: "awh-web-7kdppqrwaa-uc.a.run.app",
      publicBaseUrl: base,
    }),
  ).toBe(false);
  expect(
    allowsRequest({
      secretConfigured: true,
      secretOk: false,
      host: "agentswerehere.com",
      publicBaseUrl: base,
    }),
  ).toBe(true);
  expect(
    allowsRequest({
      secretConfigured: true,
      secretOk: true,
      host: "awh-web-7kdppqrwaa-uc.a.run.app",
      publicBaseUrl: base,
    }),
  ).toBe(true);
});

test("www redirects to the apex and a spoofed prefix is not the client", () => {
  expect(apexRedirect("www.agentswerehere.com", base, "/wall", "?x=1")).toBe(
    "https://agentswerehere.com/wall?x=1",
  );
  expect(apexRedirect("agentswerehere.com", base, "/", "")).toBeNull();
  expect(platformClientIp("203.0.113.9, 192.0.2.20")).toBe("192.0.2.20");
  expect(platformClientIp("not an ip")).toBe("0.0.0.0");
});
