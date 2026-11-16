import assert from "node:assert/strict";
import test from "node:test";
import { API, PLAY, usableAccess, accessFromRequest } from "./auth.mjs";
import { parseFilters } from "./stats.mjs";

const now = Date.UTC(2026, 10, 16);
const bearer = (claims) => `Bearer e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const claims = { iss: `${API}/auth`, sub: "account-a", exp: now / 1000 + 900 };

test("rejects malformed, foreign-issuer, missing-subject, and expired access credentials", () => {
  const token = usableAccess(bearer(claims), now);
  assert.equal(token.userId, "account-a");
  assert.equal(token.expiresAt, now + 900_000);
  for (const changes of [
    { iss: "https://another-service.invalid/auth" },
    { sub: "" }, { sub: null }, { exp: null }, { exp: "9999999999" },
    { exp: now / 1000 + 60 }, { exp: now / 1000 - 1 },
  ]) assert.equal(usableAccess(bearer({ ...claims, ...changes }), now), null);
  for (const header of [null, "", "Basic abc", "Bearer x.y.z", "Bearer e30.e30", "Bearer e30.e30."])
    assert.equal(usableAccess(header, now), null);
});

test("only observes access from Autodarts website tabs going to the real API", () => {
  const details = {
    initiator: PLAY, tabId: 4, url: `${API}/user/v1/profile`,
    requestHeaders: [{ name: "Authorization", value: bearer({ ...claims, exp: Date.now() / 1000 + 900 }) }],
  };
  assert.equal(accessFromRequest(details).userId, "account-a");
  for (const changes of [
    { initiator: "https://unrelated.invalid" },
    { initiator: "chrome-extension://other" },
    { initiator: `${PLAY}.unrelated.invalid` },
    { tabId: -1 }, { tabId: undefined },
    { url: `${API}.unrelated.invalid/user/v1/profile` },
    { requestHeaders: [] },
  ]) assert.equal(accessFromRequest({ ...details, ...changes }), null);
});

test("extension filters reject impossible and reversed dates and unsupported windows", () => {
  assert.deepEqual(parseFilters({ limit: "25", start: "2026-01-01", end: "2026-11-16" }), {
    limit: 25, start: "2026-01-01", end: "2026-11-16", interval: "daily",
  });
  for (const params of [
    { limit: "10" }, { interval: "yearly" }, { start: "2026-02-30" },
    { start: "2026-11-17", end: "2026-11-16" }, { start: {} },
  ]) assert.throws(() => parseFilters(params), /valid leg window/);
});
