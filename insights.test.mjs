import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLegs } from "./insights.mjs";

function leg(gameId, day, overrides = {}) {
  return {
    gameId,
    matchId: `match-${gameId}`,
    finishedAt: `2026-01-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    set: 1,
    leg: 1,
    format: "501 · Straight in / Double out",
    matchType: "x01",
    won: true,
    opponent: null,
    darts: 3,
    points: 60,
    first9Points: null,
    first9Darts: null,
    scoringPoints: null,
    scoringDarts: null,
    checkoutHits: 0,
    checkoutAttempts: 0,
    visits: 1,
    tons: 0,
    busts: 0,
    scoringVisits: 1,
    lowScoringVisits: 0,
    ...overrides,
  };
}

function closeTo(actual, expected, epsilon = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("weights scoring averages by darts rather than averaging leg averages", () => {
  const result = analyzeLegs(
    [
      leg("long-leg", 2, { points: 100, darts: 10 }),
      leg("short-leg", 1, { points: 60, darts: 3 }),
    ],
    2,
  );

  closeTo(result.current.average, (3 * 160) / 13);
  assert.notEqual(result.current.average, 45);
});

test("pools checkout hits and attempts across legs", () => {
  const result = analyzeLegs(
    [
      leg("one-of-one", 2, { checkoutHits: 1, checkoutAttempts: 1 }),
      leg("one-of-ten", 1, { checkoutHits: 1, checkoutAttempts: 10 }),
    ],
    2,
  );

  assert.equal(result.current.checkoutHits, 2);
  assert.equal(result.current.checkoutAttempts, 11);
  closeTo(result.current.checkoutRate, 2 / 11);
  assert.notEqual(result.current.checkoutRate, 0.55);
});

test("keeps checkout rate null when the observed sample has no attempts", () => {
  const result = analyzeLegs(
    [leg("no-checkout", 1, { checkoutHits: 0, checkoutAttempts: 0 })],
    1,
  );

  assert.equal(result.current.checkoutHits, 0);
  assert.equal(result.current.checkoutAttempts, 0);
  assert.equal(result.current.checkoutRate, null);
});

test("sorts chronology, uses R7 percentiles, and splits odd windows with the newer half larger", () => {
  const result = analyzeLegs(
    [
      leg("third", 3, { points: 30 }),
      leg("first", 1, { points: 10 }),
      leg("fifth", 5, { points: 50 }),
      leg("second", 2, { points: 20 }),
      leg("fourth", 4, { points: 40 }),
    ],
    5,
  );

  assert.equal(result.current.p10, 14);
  assert.equal(result.current.p50, 30);
  assert.equal(result.current.p90, 46);
  assert.equal(result.halves.older.n, 2);
  assert.equal(result.halves.newer.n, 3);
  assert.equal(result.halves.older.average, 15);
  assert.equal(result.halves.newer.average, 40);
  assert.deepEqual(
    result.rolling.map(({ date }) => date),
    [
      "2026-01-01T12:00:00.000Z",
      "2026-01-02T12:00:00.000Z",
      "2026-01-03T12:00:00.000Z",
      "2026-01-04T12:00:00.000Z",
      "2026-01-05T12:00:00.000Z",
    ],
  );
});

test("starts the darts-weighted rolling average only at the full trailing 25-leg window", () => {
  const legs = Array.from({ length: 26 }, (_, index) =>
    leg(`rolling-${index + 1}`, index + 1, {
      points: index === 0 ? 30 : 60,
    }),
  ).reverse();
  const result = analyzeLegs(legs, 26);

  assert.equal(result.rolling[23].rollingAverage, null);
  closeTo(result.rolling[24].rollingAverage, (3 * (24 * 60 + 30)) / (25 * 3));
  assert.equal(result.rolling[25].rollingAverage, 60);
});

test("deduplicates game IDs before assigning current and previous windows", () => {
  const result = analyzeLegs(
    [
      leg("duplicate", 4, { points: 90 }),
      leg("next", 3, { points: 60 }),
      leg("duplicate", 1, { points: 30 }),
      leg("prior", 2, { points: 45 }),
    ],
    2,
  );

  assert.equal(result.window.currentCount, 2);
  assert.equal(result.window.previousCount, 1);
  assert.equal(result.current.average, 75);
  assert.equal(result.previous.average, 45);
});

test("keeps same-named opponents distinct and uses an exclusive other-opponents baseline", () => {
  const result = analyzeLegs(
    [
      leg("a-1", 4, {
        matchId: "a-match-1",
        points: 60,
        opponent: { id: "alex-a", name: "Alex" },
      }),
      leg("a-2", 3, {
        matchId: "a-match-2",
        points: 60,
        opponent: { id: "alex-a", name: "Alex" },
      }),
      leg("b-1", 2, {
        matchId: "b-match",
        points: 30,
        opponent: { id: "alex-b", name: "Alex" },
      }),
      leg("c-1", 1, {
        matchId: "c-match",
        points: 60,
        opponent: { id: "blair", name: "Blair" },
      }),
    ],
    4,
  );

  assert.equal(result.opponents.length, 3);
  const alexA = result.opponents.find((opponent) => opponent.id === "alex-a");
  const alexB = result.opponents.find((opponent) => opponent.id === "alex-b");
  assert.ok(alexA);
  assert.ok(alexB);
  assert.equal(alexA.legs, 2);
  assert.equal(alexA.matches, 2);
  assert.equal(alexA.baseline.legs, 2);
  assert.equal(alexA.baseline.average, 45);
  assert.equal(alexA.averageDelta, 15);
});

test("does not describe lower, narrower current scoring as improvement", () => {
  const previous = Array.from({ length: 10 }, (_, index) =>
    leg(`previous-${index}`, index + 1, {
      points: index % 2 === 0 ? 35 : 65,
    }),
  );
  const current = Array.from({ length: 10 }, (_, index) =>
    leg(`current-${index}`, index + 11, {
      points: 40,
    }),
  );
  const result = analyzeLegs([...current, ...previous].reverse(), 10);

  assert.ok(result.current.spread < result.previous.spread);
  assert.ok(result.current.p50 < result.previous.p50);
  assert.ok(result.signals.some((signal) => signal.kind === "focus"));
  assert.ok(!result.signals.some((signal) => signal.kind === "improving"));
});

test("reports missing prior history without manufacturing a comparison", () => {
  const result = analyzeLegs(
    [leg("newest", 3), leg("middle", 2), leg("oldest", 1)],
    3,
  );

  assert.equal(result.previous.n, 0);
  assert.equal(result.previous.average, null);
  assert.ok(result.signals.some((signal) => signal.kind === "context"));
  assert.ok(!result.signals.some((signal) => signal.kind === "improving"));
});

test("many checkout darts in very few legs do not imply a reliable improvement signal", () => {
  const records = Array.from({ length: 10 }, (_, index) =>
    leg(`sparse-${index}`, index + 1, {
      points: 400,
      darts: 30,
      checkoutHits: 1,
      checkoutAttempts: index >= 5 ? 6 : 30,
    }),
  );
  const result = analyzeLegs(records, 5);
  assert.equal(result.current.checkoutAttempts, 30);
  assert.equal(result.previous.checkoutAttempts, 150);
  assert.ok(result.current.checkoutRate > result.previous.checkoutRate);
  assert.ok(result.signals.every((signal) => signal.kind !== "improving"));
  assert.ok(result.signals.some((signal) => signal.kind === "context"));
});

test("groups newest legs into disjoint tens with weighted rates and an explicit partial tail", () => {
  const records = Array.from({ length: 26 }, (_, index) =>
    leg(`group-${index}`, index + 1, {
      points: index >= 16 ? 90 : index >= 6 ? 60 : 30,
      darts: index === 25 ? 6 : 3,
      first9Points: 90,
      first9Darts: 9,
      checkoutHits: index >= 16 ? 1 : 0,
      checkoutAttempts: index === 25 ? 10 : index >= 16 ? 1 : 0,
    }),
  );
  const result = analyzeLegs([...records, records[25]].reverse(), 25);
  assert.deepEqual(
    result.groups.map(({ from, to, n }) => ({ from, to, n })),
    [
      { from: 1, to: 10, n: 10 },
      { from: 11, to: 20, n: 10 },
      { from: 21, to: 25, n: 5 },
    ],
  );
  closeTo(result.groups[0].average, (3 * 900) / 33);
  closeTo(result.groups[0].checkoutRate, 10 / 19);
  assert.equal(result.groups[0].first9Average, 30);
  assert.equal(result.groups[0].darts, 33);
  assert.equal(result.groups[0].end, records[25].finishedAt);
  assert.equal(result.groups[0].start, records[16].finishedAt);
  assert.equal(result.groups[1].average, 60);
  assert.equal(result.groups[1].checkoutRate, null);
  assert.equal(result.groups[2].average, 30);
  assert.equal(result.groups[2].start, records[1].finishedAt);
  assert.deepEqual(analyzeLegs([], 25).groups, []);
});
