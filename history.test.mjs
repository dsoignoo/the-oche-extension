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
        createdAt: "2026-10-15T11:45:00Z",
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

function dart(name) {
  if (name === "Bull")
    return { segment: { name, number: 25, multiplier: 2, bed: "Bull" } };
  if (name === "25")
    return { segment: { name, number: 25, multiplier: 1, bed: "Bull" } };
  if (name === "None")
    return { segment: { name, number: 0, multiplier: 0, bed: "Outside" } };
  const [, ring, digits] = /^([SDT])(\d{1,2})$/.exec(name);
  const multiplier = { S: 1, D: 2, T: 3 }[ring];
  return {
    segment: {
      name,
      number: Number(digits),
      multiplier,
      bed: { S: "SingleInner", D: "Double", T: "Triple" }[ring],
    },
  };
}

function visit(turn, score, points, names, busted = false) {
  return {
    playerId: "my-player",
    turn,
    finishedAt: "2026-10-15T12:00:00Z",
    score,
    points,
    throws: names.map(dart),
    busted,
  };
}

function thrownMatch(visits, settings, stats = {}) {
  const base = match();
  base.games[0].settings = settings;
  base.games[0].turns = visits;
  Object.assign(base.legStats[0].stats[0], {
    score: settings.baseScore,
    dartsThrown: visits.reduce((sum, turn) => sum + turn.throws.length, 0),
    ...stats,
  });
  return base;
}

function chanceTotals(chances) {
  return Object.fromEntries(
    Object.entries(chances)
      .filter(([, chance]) => chance.total > 0)
      .map(([key, chance]) => [key, [chance.hits, chance.total]]),
  );
}

test("double chances count exact opportunities through bull, bust, reset, and the winning dart", () => {
  const settings = { baseScore: 501, inMode: "Straight", outMode: "Double" };
  const visits = [
    visit(1, 321, 180, ["T20", "T20", "T20"]),
    visit(2, 141, 180, ["T20", "T20", "T20"]),
    visit(3, 50, 91, ["T20", "S11", "S20"]),
    // Bull chance, then a d20 chance left by a single.
    visit(4, 20, 30, ["S1", "S9", "S20"]),
    // d10 and d5 chances; an odd remainder gives no chance.
    visit(5, 8, 12, ["D5", "S1", "S1"]),
    // d4 chance wasted on a bust; the next visit restarts at the recorded 8.
    visit(6, 8, 24, ["T8"], true),
    visit(7, 0, 8, ["D4"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    bull: [0, 1],
    d20: [0, 1],
    d10: [0, 1],
    d5: [0, 1],
    d4: [1, 2],
  });
  assert.equal(Object.keys(leg.doubleChances).length, 21);
  assert.deepEqual(leg.checkout, { score: 8, targets: "D4" });
  assert.equal(leg.doubleOut, true);
});

test("double-in legs score nothing before the opening double but still allow an opening finish", () => {
  const settings = { baseScore: 40, inMode: "Double", outMode: "Double" };
  const visits = [
    visit(1, 40, 0, ["S20", "S5"]),
    visit(2, 0, 40, ["D10", "D10"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d20: [0, 3],
    d10: [1, 1],
  });
  assert.deepEqual(leg.checkout, { score: 40, targets: "D10 D10" });
});

test("checkout records the winning visit route for non-double-out legs", () => {
  const settings = { baseScore: 501, inMode: "Straight", outMode: "Master" };
  const visits = [
    visit(1, 171, 330, ["T20", "T20", "T20", "T20", "T20", "T20"]),
    visit(2, 0, 170, ["T20", "T20", "Bull"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.equal(leg.doubleOut, false);
  assert.equal(leg.doubleChances, null);
  assert.deepEqual(leg.checkout, { score: 170, targets: "T20 T20 Bull" });
});

test("unusable throw data yields null double chances instead of invented zeros", () => {
  const emptySegments = normalizeMatch(match(), "my-user").legs[0];
  assert.equal(emptySegments.doubleChances, null);
  // A busted final visit cannot be the winning checkout.
  assert.equal(emptySegments.checkout, null);
  const noThrows = match();
  delete noThrows.games[0].turns[0].throws;
  assert.equal(normalizeMatch(noThrows, "my-user").legs[0].doubleChances, null);
  const noTurns = match();
  delete noTurns.games[0].turns;
  const leg = normalizeMatch(noTurns, "my-user").legs[0];
  assert.equal(leg.doubleChances, null);
  assert.equal(leg.checkout, null);
  const emptyTurns = match();
  emptyTurns.games[0].turns = [];
  assert.equal(normalizeMatch(emptyTurns, "my-user").legs[0].doubleChances, null);
});

test("legs carry start time, own visit buckets, and out mode", () => {
  const leg = normalizeMatch(match(), "my-user").legs[0];
  assert.equal(leg.startedAt, "2026-10-15T11:45:00Z");
  assert.deepEqual(leg.highVisits, {
    less60: 6,
    plus60: 2,
    plus100: 1,
    plus140: 0,
    plus170: 0,
    total180: 1,
  });
  assert.equal(leg.doubleOut, true);
  const missing = match();
  delete missing.games[0].createdAt;
  delete missing.legStats[0].stats[0].plus140;
  const degraded = normalizeMatch(missing, "my-user").legs[0];
  assert.equal(degraded.startedAt, null);
  assert.equal(degraded.highVisits, null);
  assert.equal(degraded.visits, null);
});

function rangeFixture(listing, details) {
  const requested = { pages: [], details: [] };
  const read = createHistoryReader(async (path) => {
    if (path.includes("/filter?")) {
      const page = new URL(`http://local${path}`).searchParams.get("page");
      requested.pages.push(page);
      return listing[Number(page)] ?? { items: [], last: true };
    }
    const id = path.split("/").at(-2);
    requested.details.push(id);
    return details[id];
  });
  return { read, requested };
}

test("range reading includes exact UTC boundaries and excludes legs outside", async () => {
  const details = {
    before: match("before", "2026-10-04T23:59:59.999Z"),
    "start-edge": match("start-edge", "2026-10-05T00:00:00.000Z"),
    inside: match("inside", "2026-10-08T12:00:00Z"),
    "end-edge": match("end-edge", "2026-10-10T23:59:59.999Z"),
    after: match("after", "2026-10-11T00:00:00.000Z"),
  };
  const listing = [
    {
      items: [
        { id: "after", variant: "X01", finishedAt: "2026-10-11T00:00:00.000Z", createdAt: "2026-10-11T00:00:00.000Z" },
        { id: "end-edge", variant: "X01", finishedAt: "2026-10-10T23:59:59.999Z" },
        { id: "inside", variant: "X01", finishedAt: "2026-10-08T12:00:00Z" },
        { id: "start-edge", variant: "X01", finishedAt: "2026-10-05T00:00:00.000Z" },
        { id: "before", variant: "X01", finishedAt: "2026-10-04T23:59:59.999Z" },
      ],
      last: true,
    },
  ];
  const { read, requested } = rangeFixture(listing, details);
  const result = await read("my-user", {}, { start: "2026-10-05", end: "2026-10-10" });
  assert.deepEqual(
    result.legs.map((leg) => leg.gameId),
    ["end-edge-leg", "inside-leg", "start-edge-leg"],
  );
  // The match created after the range end never needed its detail fetch.
  assert.ok(!requested.details.includes("after"));
  assert.equal(result.coverage.historyExhausted, true);
});

test("range reading scans long overlapping matches and skips ones created after the range", async () => {
  const overlap = match("overlap", "2026-10-12T12:00:00Z");
  const earlyLeg = match("overlap", "2026-10-08T12:00:00Z");
  earlyLeg.games[0].id = "overlap-early-leg";
  earlyLeg.legStats[0].stats.forEach((stats) => (stats.gameId = "overlap-early-leg"));
  overlap.games.push(earlyLeg.games[0]);
  overlap.legStats[0].stats.push(...earlyLeg.legStats[0].stats);
  const details = {
    overlap,
    inside: match("inside", "2026-10-07T12:00:00Z"),
    "late-created": match("late-created", "2026-10-13T12:00:00Z"),
  };
  const listing = [
    {
      items: [
        { id: "late-created", variant: "X01", finishedAt: "2026-10-13T12:00:00Z", createdAt: "2026-10-12T12:00:00Z" },
        { id: "overlap", variant: "X01", finishedAt: "2026-10-12T12:00:00Z", createdAt: "2026-09-01T12:00:00Z" },
        { id: "inside", variant: "X01", finishedAt: "2026-10-07T12:00:00Z" },
      ],
      last: true,
    },
  ];
  const { read, requested } = rangeFixture(listing, details);
  const result = await read("my-user", {}, { start: "2026-10-05", end: "2026-10-10" });
  assert.deepEqual(
    result.legs.map((leg) => leg.gameId),
    ["overlap-early-leg", "inside-leg"],
  );
  assert.ok(requested.details.includes("overlap"));
  assert.ok(!requested.details.includes("late-created"));
});

test("range reading paginates until listed completions are all older than the range", async () => {
  const details = {
    newest: match("newest", "2026-10-20T12:00:00Z"),
    middle: match("middle", "2026-10-15T12:00:00Z"),
    ancient: match("ancient", "2026-10-01T12:00:00Z"),
  };
  const listing = [
    {
      items: [
        { id: "newest", variant: "X01", finishedAt: "2026-10-20T12:00:00Z" },
        { id: "middle", variant: "X01", finishedAt: "2026-10-15T12:00:00Z" },
      ],
      last: false,
    },
    {
      items: [{ id: "ancient", variant: "X01", finishedAt: "2026-10-01T12:00:00Z" }],
      last: false,
    },
  ];
  const { read, requested } = rangeFixture(listing, details);
  const result = await read("my-user", {}, { start: "2026-10-10", end: "2026-10-25" });
  assert.deepEqual(
    result.legs.map((leg) => leg.gameId),
    ["newest-leg", "middle-leg"],
  );
  // Stopped by the older-than-range page, not by exhaustion or a page cap.
  assert.deepEqual(requested.pages, ["0", "1"]);
  assert.equal(result.coverage.historyExhausted, false);
});

test("range reading rejects invalid date ranges before any fetch", async () => {
  let calls = 0;
  const read = createHistoryReader(async () => {
    calls++;
    return { items: [], last: true };
  });
  await assert.rejects(
    read("my-user", {}, { start: "2026-10-10", end: "2026-10-05" }),
    /date range is invalid/,
  );
  await assert.rejects(
    read("my-user", {}, { start: "soon", end: "2026-10-05" }),
    /date range is invalid/,
  );
  assert.equal(calls, 0);
});
