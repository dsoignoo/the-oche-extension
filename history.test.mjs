import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMatch, createHistoryReader } from "./history.mjs";
import { IDBFactory } from "fake-indexeddb";
import { createHistoryStore } from "./history-store.mjs";

const isolatedReader = (fetchJson) =>
  createHistoryReader(fetchJson, createHistoryStore(new IDBFactory()));

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
  const read = isolatedReader(async (path) => {
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
  const read = isolatedReader(async (path) =>
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

function targetSummary(finishing) {
  return Object.fromEntries(
    Object.entries(finishing.targets)
      .filter(([, stats]) => Object.values(stats).some((value) => value > 0))
      .map(([key, stats]) => [key, stats]),
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
  const read = isolatedReader(async (path) => {
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
  const read = isolatedReader(async () => {
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

test("finishing replays 36 to 18 to 9 with within-visit and next-visit setup darts", () => {
  const settings = { baseScore: 36, inMode: "Straight", outMode: "Double" };
  const visits = [
    // Inside single d18, odd inside single d9, then a wasted dart on 9.
    visit(1, 9, 27, ["S18", "S9", "None"]),
    // The debt carries into the next own visit: S1 sets up 8, D4 finishes.
    visit(2, 0, 9, ["S1", "D4"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 8, to: 0, bust: false, count: 1 },
    { from: 9, to: 8, bust: false, count: 1 },
    { from: 9, to: 9, bust: false, count: 1 },
    { from: 18, to: 9, bust: false, count: 1 },
    { from: 36, to: 18, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {
    d18: {
      insideSingles: 1,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 1,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 1,
    },
    d9: {
      insideSingles: 1,
      oddInsideSingles: 1,
      setupDarts: 2,
      visits: 0,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 0,
    },
  });
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d18: [0, 1],
    d9: [0, 1],
    d4: [1, 1],
  });
  assert.deepEqual(leg.checkout, { score: 9, targets: "S1 D4" });
});

test("finishing credits a visit checkout to the starting target across doubles", () => {
  const settings = { baseScore: 40, inMode: "Straight", outMode: "Double" };
  const visits = [visit(1, 0, 40, ["S20", "S10", "D5"])];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 10, to: 0, bust: false, count: 1 },
    { from: 20, to: 10, bust: false, count: 1 },
    { from: 40, to: 20, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {
    // Started on d20 and finished within the visit, even though D5 won it.
    d20: {
      insideSingles: 1,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 1,
      visitCheckouts: 1,
      bustVisits: 0,
      oddLeaves: 0,
    },
    d10: {
      insideSingles: 1,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 0,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 0,
    },
  });
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d20: [0, 1],
    d10: [0, 1],
    d5: [1, 1],
  });
  assert.deepEqual(leg.checkout, { score: 40, targets: "S20 S10 D5" });
});

test("a direct high double hit contrasts with the odd setup burden of going inside", () => {
  const settings = { baseScore: 22, inMode: "Straight", outMode: "Double" };
  const direct = thrownMatch([visit(1, 0, 22, ["D11"])], settings);
  const [directLeg] = normalizeMatch(direct, "my-user").legs;
  assert.deepEqual(directLeg.finishing.transitions, [
    { from: 22, to: 0, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(directLeg.finishing), {
    d11: {
      insideSingles: 0,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 1,
      visitCheckouts: 1,
      bustVisits: 0,
      oddLeaves: 0,
    },
  });
  assert.deepEqual(chanceTotals(directLeg.doubleChances), { d11: [1, 1] });
  const inside = thrownMatch(
    [visit(1, 4, 18, ["S11", "S5", "S2"]), visit(2, 0, 4, ["D2"])],
    settings,
  );
  const [insideLeg] = normalizeMatch(inside, "my-user").legs;
  assert.deepEqual(insideLeg.finishing.transitions, [
    { from: 4, to: 0, bust: false, count: 1 },
    { from: 6, to: 4, bust: false, count: 1 },
    { from: 11, to: 6, bust: false, count: 1 },
    { from: 22, to: 11, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(insideLeg.finishing), {
    d11: {
      insideSingles: 1,
      oddInsideSingles: 1,
      setupDarts: 1,
      visits: 1,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 0,
    },
    // The follow-up visit starts on 4 and finishes on its first dart.
    d2: {
      insideSingles: 0,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 1,
      visitCheckouts: 1,
      bustVisits: 0,
      oddLeaves: 0,
    },
  });
  assert.deepEqual(chanceTotals(insideLeg.doubleChances), {
    d11: [0, 1],
    d3: [0, 1],
    d2: [1, 1],
  });
});

test("a bust consumes the rest of the visit, pools repeats, and clears setup debt", () => {
  const settings = { baseScore: 22, inMode: "Straight", outMode: "Double" };
  const visits = [
    visit(1, 9, 13, ["S11", "S2", "None"]),
    // Bust on the second dart; the recorded third dart is never replayed.
    visit(2, 9, 13, ["S2", "T2", "S1"], true),
    // The bust cleared the debt, so this S1 is not a d11 setup dart.
    visit(3, 0, 9, ["S1", "D4"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 7, to: null, bust: true, count: 1 },
    { from: 8, to: 0, bust: false, count: 1 },
    { from: 9, to: 7, bust: false, count: 1 },
    { from: 9, to: 8, bust: false, count: 1 },
    { from: 9, to: 9, bust: false, count: 1 },
    { from: 11, to: 9, bust: false, count: 1 },
    { from: 22, to: 11, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {
    d11: {
      insideSingles: 1,
      oddInsideSingles: 1,
      setupDarts: 4,
      visits: 1,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 1,
    },
  });
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d11: [0, 1],
    d4: [1, 1],
  });
});

test("identical bust visits pool transitions and count as bust visits", () => {
  const settings = { baseScore: 8, inMode: "Straight", outMode: "Double" };
  const visits = [
    visit(1, 8, 6, ["T2", "S1", "S1"], true),
    visit(2, 8, 6, ["T2", "S1", "S1"], true),
    visit(3, 0, 8, ["D4"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 2, to: null, bust: true, count: 2 },
    { from: 8, to: 0, bust: false, count: 1 },
    { from: 8, to: 2, bust: false, count: 2 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {
    d1: {
      insideSingles: 2,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 0,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 0,
    },
    d4: {
      insideSingles: 0,
      oddInsideSingles: 0,
      setupDarts: 0,
      visits: 3,
      visitCheckouts: 1,
      bustVisits: 2,
      oddLeaves: 0,
    },
  });
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d4: [1, 3],
    d1: [0, 2],
  });
});

test("a leg ended by the opponent adds no imagined future setup darts", () => {
  const settings = { baseScore: 18, inMode: "Straight", outMode: "Double" };
  const lost = thrownMatch(
    [visit(1, 3, 15, ["S9", "S2", "S4"])],
    settings,
  );
  lost.games[0].winnerPlayerId = "opponent-player";
  const [leg] = normalizeMatch(lost, "my-user").legs;
  assert.equal(leg.won, false);
  assert.equal(leg.checkout, null);
  // The odd-remainder debt stops at the recorded darts; nothing is invented
  // for the visits the player never got.
  assert.deepEqual(leg.finishing.transitions, [
    { from: 7, to: 3, bust: false, count: 1 },
    { from: 9, to: 7, bust: false, count: 1 },
    { from: 18, to: 9, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {
    d9: {
      insideSingles: 1,
      oddInsideSingles: 1,
      setupDarts: 2,
      visits: 1,
      visitCheckouts: 0,
      bustVisits: 0,
      oddLeaves: 1,
    },
  });
});

test("a partial recorded visit replays its darts but is no visit sample", () => {
  const settings = { baseScore: 40, inMode: "Straight", outMode: "Double" };
  const lost = thrownMatch(
    [visit(1, 20, 20, ["S20"]), visit(2, 10, 10, ["S10"])],
    settings,
  );
  lost.games[0].winnerPlayerId = "opponent-player";
  const [leg] = normalizeMatch(lost, "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 20, to: 10, bust: false, count: 1 },
    { from: 40, to: 20, bust: false, count: 1 },
  ]);
  const { d20, d10 } = leg.finishing.targets;
  assert.equal(d20.visits, 0);
  assert.equal(d20.insideSingles, 1);
  assert.equal(d10.visits, 0);
  assert.equal(d10.insideSingles, 1);
});

test("double-in gates route samples until after the opening double", () => {
  const settings = { baseScore: 40, inMode: "Double", outMode: "Double" };
  const visits = [
    // Unopened singles are not route samples and not inside singles.
    visit(1, 40, 0, ["S20", "S20", "S20"]),
    // The opening double itself is excluded; only the finisher is a sample.
    visit(2, 0, 40, ["D10", "D10"]),
  ];
  const [leg] = normalizeMatch(thrownMatch(visits, settings), "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, [
    { from: 20, to: 0, bust: false, count: 1 },
  ]);
  assert.deepEqual(targetSummary(leg.finishing), {});
  assert.equal(leg.finishing.targets.d20.visits, 0);
  assert.equal(leg.finishing.targets.d20.insideSingles, 0);
  assert.deepEqual(chanceTotals(leg.doubleChances), {
    d20: [0, 4],
    d10: [1, 1],
  });
});

test("legs that never reach a finish keep known-zero finishing metrics", () => {
  const settings = { baseScore: 501, inMode: "Straight", outMode: "Double" };
  const lost = thrownMatch(
    [
      visit(1, 321, 180, ["T20", "T20", "T20"]),
      visit(2, 261, 60, ["S20", "S20", "S20"]),
    ],
    settings,
  );
  lost.games[0].winnerPlayerId = "opponent-player";
  const [leg] = normalizeMatch(lost, "my-user").legs;
  assert.deepEqual(leg.finishing.transitions, []);
  assert.deepEqual(targetSummary(leg.finishing), {});
  assert.equal(Object.keys(leg.finishing.targets).length, 21);
  assert.deepEqual(leg.finishing.targets.d20, {
    insideSingles: 0,
    oddInsideSingles: 0,
    setupDarts: 0,
    visits: 0,
    visitCheckouts: 0,
    bustVisits: 0,
    oddLeaves: 0,
  });
  assert.deepEqual(chanceTotals(leg.doubleChances), {});
});

test("finishing is null when the replay is unusable or not double-out", () => {
  assert.equal(normalizeMatch(match(), "my-user").legs[0].finishing, null);
  const noThrows = match();
  delete noThrows.games[0].turns[0].throws;
  assert.equal(normalizeMatch(noThrows, "my-user").legs[0].finishing, null);
  const noTurns = match();
  delete noTurns.games[0].turns;
  assert.equal(normalizeMatch(noTurns, "my-user").legs[0].finishing, null);
  const emptyTurns = match();
  emptyTurns.games[0].turns = [];
  assert.equal(normalizeMatch(emptyTurns, "my-user").legs[0].finishing, null);
  // Non-double-out legs keep the checkout but carry no finishing routes.
  const master = thrownMatch(
    [visit(1, 0, 170, ["T20", "T20", "Bull"])],
    { baseScore: 170, inMode: "Straight", outMode: "Master" },
  );
  const [masterLeg] = normalizeMatch(master, "my-user").legs;
  assert.equal(masterLeg.finishing, null);
  assert.deepEqual(masterLeg.checkout, { score: 170, targets: "T20 T20 Bull" });
  // An inconsistent recorded score between visits voids the whole replay.
  const inconsistent = thrownMatch(
    [visit(1, 9, 27, ["S18", "S9", "None"]), visit(2, 0, 9, ["S1", "D4"])],
    { baseScore: 36, inMode: "Straight", outMode: "Double" },
  );
  inconsistent.games[0].turns[0].score = "unknown";
  const [badLeg] = normalizeMatch(inconsistent, "my-user").legs;
  assert.equal(badLeg.finishing, null);
  assert.equal(badLeg.doubleChances, null);
});

test("a triple with the same points as the inner single is not counted as an inside-single miss", () => {
  const source = thrownMatch(
    [visit(1, 0, 18, ["T3", "S1", "D4"])],
    { baseScore: 18, inMode: "Straight", outMode: "Double" },
  );
  const replay = normalizeMatch(source, "my-user").legs[0].finishing;
  assert.equal(replay.targets.d9.insideSingles, 0);
  assert.equal(replay.targets.d9.oddInsideSingles, 0);
  assert.equal(replay.targets.d9.setupDarts, 0);
  assert.deepEqual(replay.transitions.find((item) => item.from === 18), {
    from: 18, to: 9, bust: false, count: 1,
  });
});

test("numerically inconsistent recorded visits do not train finishing-route estimates", () => {
  const source = thrownMatch(
    [visit(1, 8, 27, ["S18", "S9", "None"]), visit(2, 0, 8, ["D4"])],
    { baseScore: 36, inMode: "Straight", outMode: "Double" },
  );
  const normalized = normalizeMatch(source, "my-user").legs[0];
  assert.equal(normalized.finishing, null);
  assert.ok(normalized.doubleChances);
});
