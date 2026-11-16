import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMatch, createHistoryReader } from "./history.mjs";

function match(id = "m1", date = "2026-10-15T12:00:00Z") {
  return {
    id,
    variant: "X01",
    type: "Online",
    players: [
      {
        id: "opponent-player",
        userId: "other-user",
        name: "Same name",
        index: 0,
      },
      { id: "my-player", userId: "my-user", name: "Same name", index: 1 },
    ],
    games: [
      {
        id: `${id}-leg`,
        variant: "X01",
        finishedAt: date,
        winner: 0,
        winnerPlayerId: "my-player",
        set: 0,
        leg: 0,
        settings: { baseScore: 501, inMode: "Straight", outMode: "Double" },
        turns: [
          {
            playerId: "my-player",
            turn: 1,
            finishedAt: date,
            score: 481,
            points: 20,
            throws: [{}, {}, {}],
            busted: false,
          },
          {
            playerId: "opponent-player",
            turn: 0,
            finishedAt: date,
            score: 321,
            points: 180,
            throws: [{}, {}, {}],
            busted: false,
          },
          {
            playerId: "my-player",
            turn: 3,
            finishedAt: date,
            score: 481,
            points: 60,
            throws: [{}, {}, {}],
            busted: true,
          },
        ],
      },
    ],
    legStats: [
      {
        winner: 1,
        playerIndices: [1, 0],
        stats: [
          {
            playerId: "my-player",
            gameId: `${id}-leg`,
            score: 501,
            dartsThrown: 30,
            first9Score: 150,
            scoreUntil170: 360,
            dartsUntil170: 21,
            checkouts: 9,
            checkoutsHit: 1,
            less60: 6,
            plus60: 2,
            plus100: 1,
            plus140: 0,
            plus170: 0,
            total180: 1,
          },
          {
            playerId: "opponent-player",
            gameId: `${id}-leg`,
            score: 450,
            dartsThrown: 30,
          },
        ],
      },
    ],
  };
}

test("leg results and opponents follow stable IDs, not reversed indices or equal names", () => {
  const { legs } = normalizeMatch(match(), "my-user");
  assert.equal(legs[0].won, true);
  assert.deepEqual(legs[0].opponent, { id: "other-user", name: "Same name" });
  assert.equal(legs[0].points, 501);
  assert.equal(legs[0].tons, 2);
  assert.equal(legs[0].visits, 10);
  assert.equal(legs[0].lowScoringVisits, 2);
  assert.equal(legs[0].scoringVisits, 2);
  assert.equal(legs[0].busts, 1);
});

test("bots and multiplayer legs do not appear as human head-to-head opponents", () => {
  const bot = match();
  bot.players[0].cpuPPR = 50;
  assert.equal(normalizeMatch(bot, "my-user").legs[0].opponent, null);
  const multi = match();
  multi.players.push({ id: "third", userId: "third-user", name: "Third" });
  multi.legStats[0].stats.push({ playerId: "third", gameId: "m1-leg" });
  assert.equal(normalizeMatch(multi, "my-user").legs[0].opponent, null);
});

test("unfinished and missing-stat played legs are excluded and counted, missing metrics stay null", () => {
  const incomplete = match();
  incomplete.games[0].winnerPlayerId = null;
  assert.deepEqual(normalizeMatch(incomplete, "my-user"), {
    legs: [],
    skippedLegs: 1,
    skippedMatches: 0,
  });
  const noStats = match();
  noStats.legStats[0].stats.shift();
  assert.equal(normalizeMatch(noStats, "my-user").skippedLegs, 1);
  const missing = match();
  delete missing.legStats[0].stats[0].first9Score;
  delete missing.legStats[0].stats[0].checkouts;
  const leg = normalizeMatch(missing, "my-user").legs[0];
  assert.equal(leg.first9Points, null);
  assert.equal(leg.first9Darts, null);
  assert.equal(leg.checkoutAttempts, null);
});

test("history reads past a long overlapping match and cuts by leg completion", async () => {
  const long = match("long", "2026-10-01T12:00:00Z");
  const recent = match("recent", "2026-10-15T12:00:00Z");
  const middle = match("middle", "2026-10-14T12:00:00Z");
  const detail = { long, recent, middle };
  const read = createHistoryReader(async (path) => {
    if (path.includes("/filter?")) {
      const page = new URL(`http://local${path}`).searchParams.get("page");
      return page === "0"
        ? {
            items: [
              {
                id: "long",
                variant: "X01",
                finishedAt: "2026-10-15T14:00:00Z",
              },
              {
                id: "recent",
                variant: "X01",
                finishedAt: "2026-10-15T12:00:00Z",
              },
            ],
            last: false,
          }
        : {
            items: [
              {
                id: "middle",
                variant: "X01",
                finishedAt: "2026-10-14T12:00:00Z",
              },
            ],
            last: true,
          };
    }
    return detail[path.split("/").at(-2)];
  });
  const result = await read("my-user", {}, 1);
  assert.deepEqual(
    result.legs.map((leg) => leg.gameId),
    ["recent-leg", "middle-leg"],
  );
});

test("cached match summaries cannot cross account boundaries", async () => {
  const read = createHistoryReader(async (path) =>
    path.includes("/filter?")
      ? {
          items: [
            { id: "m1", variant: "X01", finishedAt: "2026-10-15T12:00:00Z" },
          ],
          last: true,
        }
      : match(),
  );
  const own = await read("my-user", {}, 1);
  const other = await read("other-user", {}, 1);
  assert.equal(own.legs[0].won, true);
  assert.equal(other.legs[0].won, false);
  assert.equal(other.legs[0].points, 450);
  assert.equal(other.legs[0].opponent.id, "my-user");
});
