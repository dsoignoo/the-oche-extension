import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createHistoryReader } from "./history.mjs";
import { createHistoryStore } from "./history-store.mjs";

const finished = "2026-11-16T12:00:00.000Z";
function detail(completed = finished, missed = false) {
  return {
    id: "match-one", variant: "X01", type: "Online", finishedAt: completed,
    settings: { baseScore: 40, inMode: "Straight", outMode: "Double" },
    players: [{ id: "self", userId: "user-one" }],
    games: [{
      id: "leg-one", variant: "X01", winnerPlayerId: "self",
      createdAt: "2026-11-16T11:59:00.000Z", finishedAt: completed,
      turns: [{ playerId: "self", turn: 0, finishedAt: completed, score: 0, points: 40, busted: false,
        throws: [
          ...(missed ? [{ segment: { name: "Miss", number: 0, multiplier: 0 } }] : []),
          { segment: { name: "D20", number: 20, multiplier: 2 } },
        ],
      }],
    }],
    legStats: [{ stats: [{
      playerId: "self", gameId: "leg-one", score: 40, dartsThrown: missed ? 2 : 1,
      first9Score: 40, checkoutsHit: 1, checkouts: missed ? 2 : 1,
      less60: 1, plus60: 0, plus100: 0, plus140: 0, plus170: 0, total180: 0,
    }] }],
  };
}
const listing = (completed = finished) => ({
  items: [{ id: "match-one", variant: "X01", finishedAt: completed }], last: true,
});

test("completed match summaries survive a fresh reader and database connection", async () => {
  const factory = new IDBFactory();
  const firstStore = createHistoryStore(factory);
  const first = createHistoryReader(async (path) => path.includes("/filter?") ? listing() : detail(), firstStore);
  await first("user-one", {}, 1);
  firstStore.close();
  const secondStore = createHistoryStore(factory);
  const second = createHistoryReader(async (path) => {
    if (path.includes("/filter?")) return listing();
    throw new Error("Saved completed match should not need another detail download");
  }, secondStore);
  const result = await second("user-one", {}, 1);
  assert.equal(result.legs[0].gameId, "leg-one");
  assert.equal(result.legs[0].points, 40);
  assert.equal(result.legs[0].darts, 1);
  const summary = await secondStore.summary("user-one");
  assert.equal(summary.matches, 1);
  assert.equal(summary.legs, 1);
  secondStore.close();
});

test("a changed completion fingerprint replaces the saved match instead of returning stale darts", async () => {
  const store = createHistoryStore(new IDBFactory());
  let completed = finished;
  const read = createHistoryReader(async (path) => path.includes("/filter?")
    ? listing(completed) : detail(completed, completed !== finished), store);
  assert.equal((await read("user-one", {}, 1)).legs[0].darts, 1);
  completed = "2026-11-16T13:00:00.000Z";
  assert.equal((await read("user-one", {}, 1)).legs[0].darts, 2);
  assert.equal(await store.get("user-one", "match-one", finished), null);
  assert.equal((await store.get("user-one", "match-one", completed)).legs[0].darts, 2);
  store.close();
});

test("clearing saved history while a detail download is pending cannot repopulate it", async () => {
  const store = createHistoryStore(new IDBFactory());
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let finishDownload;
  const download = new Promise((resolve) => { finishDownload = resolve; });
  const second = detail();
  second.id = "match-two";
  second.games[0].id = "leg-two";
  second.legStats[0].stats[0].gameId = "leg-two";
  const read = createHistoryReader(async (path) => {
    if (path.includes("/filter?")) {
      const page = new URL(`https://test.invalid${path}`).searchParams.get("page");
      return page === "0"
        ? { ...listing(), last: false }
        : { items: [{ id: second.id, variant: "X01", finishedAt: finished }], last: true };
    }
    if (path.includes("/match-two/")) return second;
    signalStarted();
    return download;
  }, store);
  const reading = read("user-one", {}, 1);
  await started;
  await store.clear();
  finishDownload(detail());
  const result = await reading;
  assert.equal(result.legs.length, 2);
  assert.equal(result.legs[0].points, 40);
  const summary = await store.summary("user-one");
  assert.equal(summary.matches, 0);
  assert.equal(summary.legs, 0);
  store.close();
});
