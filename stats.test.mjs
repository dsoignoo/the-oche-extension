import assert from "node:assert/strict";
import test from "node:test";
import { createStatsReader } from "./stats.mjs";
import { IDBFactory } from "fake-indexeddb";
import { createHistoryStore } from "./history-store.mjs";

const token = { userId: "test-user" };
const recent = { numLegs: 200, average: { average: 42 } };
const dates = ["2026-06-01T00:00:00.000Z", "2026-06-30T23:59:59.999Z", "2026-07-01T00:00:00.000Z"];
const settings = { baseScore: 101, inMode: "Straight", outMode: "Double" };
const segment = (name, number, multiplier) => ({ segment: { name, number, multiplier } });
const match = {
  id: "sample", variant: "X01", type: "Online", settings,
  players: [{ id: "self", userId: token.userId }],
  games: dates.map((finishedAt, index) => ({
    id: `game-${index}`, variant: "X01", settings, winnerPlayerId: "self",
    createdAt: new Date(Date.parse(finishedAt) - 60_000).toISOString(), finishedAt,
    turns: [
      { playerId: "self", turn: 0, finishedAt, score: 41, points: 60, busted: false,
        throws: [segment("S20", 20, 1), segment("S20", 20, 1), segment("S20", 20, 1)] },
      { playerId: "self", turn: 1, finishedAt, score: 0, points: 41, busted: false,
        throws: [segment("S1", 1, 1), segment("D20", 20, 2)] },
    ],
  })),
  legStats: dates.map((_, index) => ({ stats: [{
    playerId: "self", gameId: `game-${index}`, score: 101, dartsThrown: 5,
    first9Score: 101, checkouts: 1, checkoutsHit: 1,
    less60: 1, plus60: 1, plus100: 0, plus140: 0, plus170: 0, total180: 0,
  }] })),
};

function reader(failurePath, failure) {
  return createStatsReader(async (path) => {
    if (path === failurePath) throw failure;
    if (path === "/user/v1/profile") return { username: "test-player" };
    if (path === "/us/v0/profile/stats/x01?limit=200") return recent;
    if (path.startsWith("/as/v0/matches/filter?")) {
      if (failurePath === "history") throw failure;
      return { items: [{ id: match.id, variant: "X01", finishedAt: dates[2] }], last: true };
    }
    if (path === "/as/v0/matches/sample/stats") return match;
    throw new Error(`Unexpected API request: ${path}`);
  }, createHistoryStore(new IDBFactory()));
}

test("date-range analytics use completed match legs rather than the recent aggregate sample", async () => {
  const read = reader();
  const result = await read("analytics", { start: "2026-06-01", end: "2026-06-30", limit: "25" }, token);
  assert.equal(result.numLegsPlayed, 2);
  assert.equal(result.numLegsWon, 2);
  assert.equal(result.numDarts, 10);
  assert.equal(result.numGames, 1);
  assert.equal(result.fun.playtime, 120);
  assert.equal(result.highVisits.plus60, 2);
  assert.deepEqual(result.doublePerformance.d20, { hits: 2, total: 2, percent: 1 });
  assert.equal(result.bestCheckouts[0].score, 41);
  assert.equal(result.bestCheckouts[0].targets, "S1 D20");
  const empty = await read("analytics", { start: "2026-08-01", end: "2026-08-31" }, token);
  assert.equal(empty.numLegsPlayed, 0);
  assert.equal(empty.numDarts, 0);
  assert.deepEqual(empty.bestGames, []);
});

test("history failures remain explicit without preventing recent form from loading", async () => {
  const failure = Object.assign(new Error("History unavailable"), { code: "ACCESS_DENIED" });
  const read = reader("history", failure);
  const dashboard = await read("dashboard", {}, token);
  assert.equal(dashboard.profile.username, "test-player");
  assert.equal(dashboard.recent.average.average, 42);
  await assert.rejects(read("analytics", {}, token), (error) => error === failure);
  const again = await read("dashboard", {}, token);
  assert.equal(again.recent.numLegs, 200);
});

test("missing required profile or recent statistics never produces a partial dashboard", async () => {
  for (const path of ["/user/v1/profile", "/us/v0/profile/stats/x01?limit=200"]) {
    const error = Object.assign(new Error("Denied"), { code: "ACCESS_DENIED" });
    await assert.rejects(reader(path, error)("dashboard", {}, token), (actual) => actual === error);
  }
});
