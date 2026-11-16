import assert from "node:assert/strict";
import test from "node:test";

import { analyzeHistory } from "./analytics.mjs";

function leg(gameId, overrides = {}) {
  return {
    gameId,
    matchId: `match-${gameId}`,
    finishedAt: "2026-01-10T12:00:00.000Z",
    startedAt: null,
    set: 1,
    leg: 1,
    matchType: "x01",
    won: false,
    darts: 21,
    points: 420,
    highVisits: null,
    doubleOut: false,
    doubleChances: null,
    checkout: null,
    ...overrides,
  };
}

function chances(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([target, [hits, total]]) => [
      target,
      { hits, total },
    ]),
  );
}

test("duplicate gameIds are counted once before aggregating", () => {
  const result = analyzeHistory([
    leg("g1", { won: true, darts: 15, matchType: "league" }),
    leg("g1", { won: true, darts: 15, matchType: "league" }),
    leg("g2", { darts: 30, matchId: "match-g1", matchType: "league" }),
  ]);
  assert.equal(result.numLegsPlayed, 2);
  assert.equal(result.numLegsWon, 1);
  assert.equal(result.numDarts, 45);
  assert.equal(result.numGames, 1);
  assert.deepEqual(result.gameCounts, { league: 1 });
});

test("double performance pools hits and totals across known legs", () => {
  const result = analyzeHistory([
    leg("g1", {
      won: true,
      doubleOut: true,
      doubleChances: chances({ d16: [1, 2], bull: [0, 1] }),
    }),
    leg("g2", {
      doubleOut: true,
      doubleChances: chances({ d16: [1, 1], d8: [0, 3] }),
    }),
    leg("g3", { doubleOut: true, doubleChances: null }),
  ]);
  assert.deepEqual(result.doublePerformance.d16, {
    hits: 2,
    total: 3,
    percent: 2 / 3,
  });
  assert.deepEqual(result.doublePerformance.d8, {
    hits: 0,
    total: 3,
    percent: 0,
  });
  assert.deepEqual(result.doublePerformance.d20, {
    hits: 0,
    total: 0,
    percent: null,
  });
  assert.equal(result.coverage.doubleLegs, 2);
  assert.equal(result.coverage.doubleEligibleLegs, 3);
});

test("numDartsBest and bestGames consider own won legs only", () => {
  const result = analyzeHistory([
    leg("lost-short", { won: false, darts: 9, points: 450 }),
    leg("won-long", {
      won: true,
      darts: 27,
      points: 501,
      finishedAt: "2026-01-09T12:00:00.000Z",
    }),
    leg("won-short", { won: true, darts: 15, points: 501 }),
    leg("won-mid", { won: true, darts: 15, points: 400, set: 2 }),
  ]);
  assert.equal(result.performanceBest.numDartsBest, 15);
  // Fewest darts first; tied darts broken by higher average.
  assert.deepEqual(
    result.bestGames.map((row) => row.gameId),
    ["won-short", "won-mid", "won-long"],
  );
  assert.equal(result.bestGames[0].average, 100.2);
  assert.equal(result.bestGames[0].numDarts, 15);
});

test("bestCheckouts order by score then stable date and keep hit targets", () => {
  const result = analyzeHistory([
    leg("low", {
      won: true,
      checkout: { score: 40, targets: "D20" },
      finishedAt: "2026-01-08T12:00:00.000Z",
    }),
    leg("high", {
      won: true,
      checkout: { score: 121, targets: "T20 T11 D14" },
      finishedAt: "2026-01-07T12:00:00.000Z",
    }),
    leg("tied-newer", {
      won: true,
      checkout: { score: 121, targets: "T20 S11 Bull" },
      finishedAt: "2026-01-09T12:00:00.000Z",
    }),
    leg("lost-checkout", {
      won: false,
      checkout: { score: 170, targets: "T20 T20 Bull" },
    }),
    leg("no-checkout", { won: true, checkout: null }),
  ]);
  assert.deepEqual(
    result.bestCheckouts.map((row) => row.matchId),
    ["match-tied-newer", "match-high", "match-low"],
  );
  assert.equal(result.bestCheckouts[0].score, 121);
  assert.equal(result.bestCheckouts[0].targets, "T20 S11 Bull");
  assert.equal(result.performanceBest.bestCheckout, 121);
});

test("highVisits sums only legs with complete known buckets", () => {
  const buckets = {
    less60: 2,
    plus60: 3,
    plus100: 1,
    plus140: 0,
    plus170: 0,
    total180: 0,
  };
  const result = analyzeHistory([
    leg("g1", { highVisits: buckets }),
    leg("g2", {
      highVisits: { ...buckets, less60: 1, total180: 2 },
    }),
    leg("g3", { highVisits: null }),
  ]);
  assert.deepEqual(result.highVisits, {
    less60: 3,
    plus60: 6,
    plus100: 2,
    plus140: 0,
    plus170: 0,
    total180: 2,
  });
  assert.equal(result.coverage.visitLegs, 2);
});

test("playtime unions overlapping leg intervals without double-counting", () => {
  const result = analyzeHistory([
    leg("g1", {
      startedAt: "2026-01-10T10:00:00.000Z",
      finishedAt: "2026-01-10T10:10:00.000Z",
    }),
    leg("g2", {
      startedAt: "2026-01-10T10:05:00.000Z",
      finishedAt: "2026-01-10T10:20:00.000Z",
    }),
    leg("g3", {
      startedAt: "2026-01-10T11:00:00.000Z",
      finishedAt: "2026-01-10T11:05:00.000Z",
    }),
    leg("g4", { startedAt: null }),
  ]);
  // 10:00-10:20 (overlap merged) plus 11:00-11:05.
  assert.equal(result.fun.playtime, 1500);
  assert.equal(result.fun.walkingDistance, null);
  assert.equal(result.coverage.timedLegs, 3);
});

test("playtime is null when no leg has a usable start time", () => {
  const result = analyzeHistory([
    leg("g1"),
    leg("g2", { startedAt: "not-a-date" }),
  ]);
  assert.equal(result.fun.playtime, null);
  assert.equal(result.coverage.timedLegs, 0);
});

test("empty history reports zero sums and null rates without inventing data", () => {
  const result = analyzeHistory([]);
  assert.equal(result.numDarts, 0);
  assert.equal(result.numGames, 0);
  assert.equal(result.numLegsPlayed, 0);
  assert.equal(result.numLegsWon, 0);
  assert.equal(result.fun.playtime, null);
  assert.deepEqual(result.highVisits, {
    less60: 0,
    plus60: 0,
    plus100: 0,
    plus140: 0,
    plus170: 0,
    total180: 0,
  });
  assert.equal(result.doublePerformance.bull.percent, null);
  assert.equal(result.doublePerformance.bull.total, 0);
  assert.deepEqual(result.performanceBest, {
    averageBest: null,
    numDartsBest: null,
    bestCheckout: null,
  });
  assert.deepEqual(result.gameCounts, {});
  assert.deepEqual(result.bestGames, []);
  assert.deepEqual(result.bestCheckouts, []);
  assert.deepEqual(result.coverage, {
    timedLegs: 0,
    visitLegs: 0,
    doubleLegs: 0,
    doubleEligibleLegs: 0,
  });
});

test("partial metadata keeps metrics truthful and coverage explicit", () => {
  const result = analyzeHistory(
    [
      leg("g1", {
        won: true,
        darts: 18,
        points: 501,
        doubleOut: true,
        doubleChances: chances({ d20: [1, 1] }),
        checkout: { score: 32, targets: "D16" },
      }),
      leg("g2", { matchType: "league" }),
    ],
    { rangeDays: 30 },
  );
  assert.equal(result.performanceBest.averageBest, 83.5);
  assert.equal(result.performanceBest.numDartsBest, 18);
  assert.equal(result.performanceBest.bestCheckout, 32);
  assert.equal(result.numLegsWon, 1);
  assert.deepEqual(result.gameCounts, { league: 1, x01: 1 });
  assert.deepEqual(result.coverage, {
    rangeDays: 30,
    timedLegs: 0,
    visitLegs: 0,
    doubleLegs: 1,
    doubleEligibleLegs: 1,
  });
  assert.equal(result.doublePerformance.d20.percent, 1);
});

test("bestGames and bestCheckouts are capped at ten rows", () => {
  const legs = [];
  for (let index = 0; index < 12; index += 1) {
    legs.push(
      leg(`g${index}`, {
        won: true,
        darts: 12 + index,
        points: 501,
        checkout: { score: 50 + index, targets: "Bull" },
      }),
    );
  }
  const result = analyzeHistory(legs);
  assert.equal(result.bestGames.length, 10);
  assert.equal(result.bestGames[0].numDarts, 12);
  assert.equal(result.bestCheckouts.length, 10);
  assert.equal(result.bestCheckouts[0].score, 61);
});

test("double-out checkout percentage pools leg totals even without individual throw records", () => {
  const first = leg("recorded-1", { doubleOut: true, checkoutHits: 1, checkoutAttempts: 1 });
  const result = analyzeHistory([
    first,
    first,
    leg("recorded-2", { doubleOut: true, checkoutHits: 1, checkoutAttempts: 9 }),
    leg("missing", { doubleOut: true, checkoutHits: null, checkoutAttempts: 3 }),
    leg("single-out", { doubleOut: false, checkoutHits: 1, checkoutAttempts: 1 }),
  ]);
  assert.deepEqual(result.checkoutPerformance, {
    hits: 2, attempts: 10, percent: 0.2, recordedLegs: 2, eligibleLegs: 3,
  });
  assert.equal(result.coverage.doubleLegs, 0);
  assert.equal(result.doublePerformance.d20.percent, null);
});

test("checkout fallback distinguishes known zero hits, no attempts, and missing leg totals", () => {
  const zero = analyzeHistory([
    leg("zero", { doubleOut: true, checkoutHits: 0, checkoutAttempts: 10 }),
  ]).checkoutPerformance;
  assert.equal(zero.percent, 0);
  const noAttempts = analyzeHistory([
    leg("no-attempts", { doubleOut: true, checkoutHits: 0, checkoutAttempts: 0 }),
  ]).checkoutPerformance;
  assert.deepEqual(noAttempts, {
    hits: 0, attempts: 0, percent: null, recordedLegs: 1, eligibleLegs: 1,
  });
  const missing = analyzeHistory([leg("unknown", { doubleOut: true })]).checkoutPerformance;
  assert.deepEqual(missing, {
    hits: null, attempts: null, percent: null, recordedLegs: 0, eligibleLegs: 1,
  });
});

test("inconsistent checkout totals cannot inflate the derived rate", () => {
  const result = analyzeHistory([
    leg("good", { doubleOut: true, checkoutHits: 1, checkoutAttempts: 4 }),
    leg("over-count", { doubleOut: true, checkoutHits: 3, checkoutAttempts: 2 }),
    leg("negative", { doubleOut: true, checkoutHits: 0, checkoutAttempts: -1 }),
  ]).checkoutPerformance;
  assert.deepEqual(result, {
    hits: 1, attempts: 4, percent: 0.25, recordedLegs: 1, eligibleLegs: 3,
  });
});
