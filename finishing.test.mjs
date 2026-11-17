import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFinishing,
  estimateRouteEfficiencies,
  MIN_ROUTE_SAMPLES,
} from "./finishing.mjs";

const TARGET_FIELDS = [
  "insideSingles",
  "oddInsideSingles",
  "setupDarts",
  "visits",
  "visitCheckouts",
  "bustVisits",
  "oddLeaves",
];

const closeTo = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${actual} ≈ ${expected}`,
  );

function profile(overrides = {}) {
  return Object.fromEntries(
    TARGET_FIELDS.map((field) => [field, overrides[field] ?? 0]),
  );
}

function transition(from, to, count, bust = false) {
  return { from, to: bust ? null : to, bust, count };
}

function leg(gameId, finishing, extra = {}) {
  return {
    gameId,
    matchId: `match-${gameId}`,
    finishedAt: "2026-01-10T12:00:00.000Z",
    won: true,
    doubleChances: null,
    finishing,
    ...extra,
  };
}

function finishing(transitions = [], targets = {}) {
  return { transitions, targets };
}

function modelOf(...transitions) {
  return analyzeFinishing([leg("g1", finishing(transitions))]);
}

function byScore(results, score) {
  const result = results.find((entry) => entry.score === score);
  assert.ok(result, `expected a route result for score ${score}`);
  return result;
}

function occupancySum(result) {
  return result.states.reduce((sum, state) => sum + state.expectedDarts, 0);
}

test("transitions pool per score and duplicate gameIds never inflate", () => {
  const replay = finishing([
    transition(40, 0, 4),
    transition(40, 20, 6),
    transition(2, 0, 1),
    transition(2, null, 1, true),
  ]);
  const model = analyzeFinishing([
    leg("g1", replay),
    leg("g1", replay),
    leg("g2", replay),
    leg("g3", null),
  ]);

  assert.equal(model.coverage.legs, 2);
  assert.deepEqual(
    model.states.map((state) => state.score),
    [2, 40],
  );
  const state40 = model.states.find((state) => state.score === 40);
  assert.equal(state40.observations, 20);
  assert.deepEqual(state40.outcomes, [
    { to: 0, bust: false, count: 8, probability: 0.4 },
    { to: 20, bust: false, count: 12, probability: 0.6 },
  ]);
  // Busts sort after scoring outcomes and keep to: null.
  const state2 = model.states.find((state) => state.score === 2);
  assert.deepEqual(state2.outcomes, [
    { to: 0, bust: false, count: 2, probability: 0.5 },
    { to: null, bust: true, count: 2, probability: 0.5 },
  ]);
});

test("aggregation is deterministic regardless of input order", () => {
  const targets = {
    d20: profile({ visits: 3, visitCheckouts: 1, setupDarts: 2 }),
    bull: profile({ visits: 1, oddLeaves: 1 }),
  };
  const legs = [
    leg("g1", finishing([transition(40, 20, 6)], targets), {
      doubleChances: { d20: { hits: 1, total: 2 } },
    }),
    leg("g2", finishing([transition(40, 0, 4), transition(20, 0, 3)], targets)),
    leg("g3", null),
    // Same game fetched twice: identical record must collapse to one leg.
    leg("g1", finishing([transition(40, 20, 6)], targets), {
      doubleChances: { d20: { hits: 1, total: 2 } },
    }),
  ];
  const forward = analyzeFinishing(legs);
  const reversed = analyzeFinishing([...legs].reverse());
  assert.deepEqual(reversed, forward);
});

test("targets pool visits and raw chances only from finishing legs", () => {
  const model = analyzeFinishing([
    leg(
      "g1",
      finishing([], {
        d16: profile({
          insideSingles: 3,
          oddInsideSingles: 1,
          setupDarts: 2,
          visits: 4,
          visitCheckouts: 1,
          bustVisits: 1,
          oddLeaves: 1,
        }),
      }),
      { doubleChances: { d16: { hits: 1, total: 2 }, bull: { hits: 0, total: 1 } } },
    ),
    // No finishing replay: its raw double chances must not leak in.
    leg("g2", null, { doubleChances: { d16: { hits: 9, total: 9 } } }),
  ]);

  assert.equal(model.coverage.legs, 1);
  assert.equal(model.targets.length, 21);
  assert.deepEqual(
    model.targets.map((entry) => entry.score),
    [...Array.from({ length: 20 }, (_, index) => 2 * (index + 1)), 50],
  );

  const d16 = model.targets.find((entry) => entry.target === "d16");
  assert.equal(d16.score, 32);
  assert.equal(d16.chances, 2);
  assert.equal(d16.hits, 1);
  assert.equal(d16.hitRate, 0.5);
  assert.equal(d16.insideSingles, 3);
  assert.equal(d16.oddInsideSingles, 1);
  assert.equal(d16.setupDarts, 2);
  assert.equal(d16.visits, 4);
  assert.equal(d16.visitCheckouts, 1);
  assert.equal(d16.visitRate, 0.25);
  assert.ok(d16.visitInterval.low < 0.25 && d16.visitInterval.high > 0.25);
  assert.equal(d16.bustVisits, 1);
  assert.equal(d16.oddLeaves, 1);

  const bull = model.targets.find((entry) => entry.target === "bull");
  assert.equal(bull.score, 50);
  assert.equal(bull.chances, 1);
  assert.equal(bull.hits, 0);
  assert.equal(bull.hitRate, 0);

  const d1 = model.targets.find((entry) => entry.target === "d1");
  assert.equal(d1.chances, 0);
  assert.equal(d1.hitRate, null);
  assert.equal(d1.visitRate, null);
  assert.equal(d1.visitInterval, null);
});

test("geometric misses cost exactly 1/hit-rate actual darts", () => {
  const result = byScore(
    estimateRouteEfficiencies(
      modelOf(transition(2, 0, 25), transition(2, null, 75, true)),
    ),
    2,
  );
  assert.equal(result.status, "ok");
  closeTo(result.expectedDarts, 4);
  closeTo(result.expectedVisits, 4);
  closeTo(result.expectedSetupDarts, 0);
  // Every bust happens on the first dart and forfeits two slots.
  closeTo(result.expectedForfeitedDarts, 6);
  assert.deepEqual(result.states, [
    { score: 2, expectedDarts: 4, observations: 100 },
  ]);
  assert.deepEqual(result.missingScores, []);
  assert.deepEqual(result.closedScores, []);
  assert.equal(result.minSamples, 100);
});

test("frequency-weighted route beats a higher direct double rate", () => {
  // 40 has the better direct checkout rate (0.45 vs 0.35), but its miss
  // falls to a weak 20 → 10 chain while the 36 route mostly reaches the
  // strong 18 → 10 chain. Weighting each branch by its observed frequency
  // (never averaging target rates) makes 36 cheaper in actual darts.
  const results = estimateRouteEfficiencies(
    modelOf(
      transition(36, 0, 35),
      transition(36, 18, 60),
      transition(36, 9, 5),
      transition(18, 0, 50),
      transition(18, 10, 50),
      transition(10, 0, 80),
      transition(10, null, 20, true),
      transition(9, 8, 100),
      transition(8, 0, 90),
      transition(8, null, 10, true),
      transition(40, 0, 45),
      transition(40, 20, 55),
      transition(20, 0, 10),
      transition(20, 10, 90),
    ),
  );
  const route36 = byScore(results, 36);
  const route40 = byScore(results, 40);
  assert.equal(route36.status, "ok");
  assert.equal(route40.status, "ok");
  closeTo(route36.expectedDarts, 2 / 0.935);
  closeTo(route36.expectedVisits, 1 / 0.935);
  closeTo(route40.expectedDarts, 2.045 / 0.901);
  assert.ok(
    route36.expectedDarts < route40.expectedDarts,
    "the weighted 36 route must beat the higher direct rate of 40",
  );
  assert.equal(route36.minSamples, 100);
  assert.equal(route40.minSamples, 100);
});

test("a weak fallback barely penalizes rare inside singles", () => {
  // Same strong route, only the inside-single frequency into the weak
  // 9 → 8 chain differs: rare (10%) versus frequent (40%).
  const legs = [
    transition(20, 0, 100),
    transition(9, 8, 100),
    transition(8, 0, 50),
    transition(8, null, 50, true),
  ];
  const rare = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(40, 0, 50),
        transition(40, 20, 40),
        transition(40, 9, 10),
        ...legs,
      ),
    ),
    40,
  );
  const frequent = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(40, 0, 50),
        transition(40, 20, 10),
        transition(40, 9, 40),
        ...legs,
      ),
    ),
    40,
  );
  closeTo(rare.expectedDarts, 1.6 / 0.95);
  closeTo(frequent.expectedDarts, 2.375);
  assert.ok(rare.expectedDarts < frequent.expectedDarts);
});

test("an odd leave setup dart is counted across visits", () => {
  // 18 always leaves the odd 9; the dart out of 9 is a setup dart, and
  // the 8 route finishes only half its visits, so the whole pattern
  // (one setup dart per visit) repeats across two expected visits.
  const result = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(18, 9, 100),
        transition(9, 8, 100),
        transition(8, 0, 50),
        transition(8, null, 50, true),
      ),
    ),
    18,
  );
  assert.equal(result.status, "ok");
  closeTo(result.expectedDarts, 6);
  closeTo(result.expectedVisits, 2);
  closeTo(result.expectedSetupDarts, 2);
  closeTo(result.expectedForfeitedDarts, 0);
  closeTo(occupancySum(result), result.expectedDarts);
});

test("a bust after scoring resets to the visit start, not the dart score", () => {
  // 40 checks out half the time and otherwise reaches 20, which always
  // busts on the second dart. The bust replays the WHOLE visit from 40,
  // so the bust-only 20 stays an in-visit state: 20 as a fresh start is
  // non-finishing, yet 40 stays finite.
  const results = estimateRouteEfficiencies(
    modelOf(
      transition(40, 0, 50),
      transition(40, 20, 50),
      transition(20, null, 100, true),
    ),
  );
  const route40 = byScore(results, 40);
  assert.equal(route40.status, "ok");
  closeTo(route40.expectedDarts, 3);
  closeTo(route40.expectedVisits, 2);
  closeTo(route40.expectedForfeitedDarts, 1);
  assert.deepEqual(route40.states, [
    { score: 20, expectedDarts: 1, observations: 100 },
    { score: 40, expectedDarts: 2, observations: 100 },
  ]);
  assert.deepEqual(route40.missingScores, []);
  assert.deepEqual(route40.closedScores, []);

  const route20 = byScore(results, 20);
  assert.equal(route20.status, "non-finishing");
  assert.equal(route20.expectedDarts, null);
  assert.deepEqual(route20.closedScores, [20]);
});

test("equal expected darts can hide different bust forfeits and visits", () => {
  const pureBust = byScore(
    estimateRouteEfficiencies(
      modelOf(transition(2, 0, 50), transition(2, null, 50, true)),
    ),
    2,
  );
  // 4 finishes half its first darts outright and otherwise reaches the
  // same 50/50 checkout-or-bust 2 inside the visit: identical expected
  // actual darts (2), but fewer visits and far fewer forfeited slots.
  const mixed = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(4, 0, 50),
        transition(4, 2, 50),
        transition(2, 0, 50),
        transition(2, null, 50, true),
      ),
    ),
    4,
  );
  closeTo(pureBust.expectedDarts, 2);
  closeTo(mixed.expectedDarts, 2);
  closeTo(pureBust.expectedVisits, 2);
  closeTo(mixed.expectedVisits, 4 / 3);
  closeTo(pureBust.expectedForfeitedDarts, 2);
  closeTo(mixed.expectedForfeitedDarts, 1 / 3);
});

test("a carried remainder continues as a fresh three-dart visit", () => {
  // Three full darts from 40 reach 6 without busting half the time; the
  // next visit starts at 6 with a fresh set of three darts.
  const result = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(40, 30, 100),
        transition(30, 14, 100),
        transition(14, 0, 50),
        transition(14, 6, 50),
        transition(6, 0, 100),
      ),
    ),
    40,
  );
  assert.equal(result.status, "ok");
  closeTo(result.expectedDarts, 3.5);
  closeTo(result.expectedVisits, 1.5);
  assert.deepEqual(result.states, [
    { score: 6, expectedDarts: 0.5, observations: 100 },
    { score: 14, expectedDarts: 1, observations: 100 },
    { score: 30, expectedDarts: 1, observations: 100 },
    { score: 40, expectedDarts: 1, observations: 100 },
  ]);
  assert.equal(result.minSamples, 100);
});

test("occupancy sums to expected darts along a mixed chain", () => {
  const results = estimateRouteEfficiencies(
    modelOf(
      transition(40, 0, 10),
      transition(40, 20, 90),
      transition(20, 0, 30),
      transition(20, 10, 70),
      transition(10, 0, 40),
      transition(10, 4, 60),
      transition(4, 0, 50),
      transition(4, null, 50, true),
    ),
  );
  const route40 = byScore(results, 40);
  assert.equal(route40.status, "ok");
  closeTo(route40.expectedDarts, 3.286);
  closeTo(byScore(results, 20).expectedDarts, 2.12 / 0.79);
  closeTo(byScore(results, 10).expectedDarts, 1.6 / 0.7);
  closeTo(byScore(results, 4).expectedDarts, 2);
  for (const result of results) {
    if (result.status !== "ok") continue;
    closeTo(occupancySum(result), result.expectedDarts);
    const scores = result.states.map((state) => state.score);
    assert.deepEqual(scores, [...scores].sort((left, right) => left - right));
  }
});

test("a missing branch stays unavailable even at tiny probability", () => {
  const result = byScore(
    estimateRouteEfficiencies(
      modelOf(transition(40, 0, 999), transition(40, 20, 1)),
    ),
    40,
  );
  assert.equal(result.status, "missing");
  assert.equal(result.expectedDarts, null);
  assert.equal(result.expectedVisits, null);
  assert.equal(result.expectedSetupDarts, null);
  assert.equal(result.expectedForfeitedDarts, null);
  assert.deepEqual(result.states, []);
  assert.deepEqual(result.missingScores, [20]);
  assert.deepEqual(result.closedScores, []);
  assert.equal(result.minSamples, 1000);
});

test("a closed reachable chain is non-finishing, never a finite cap", () => {
  // 2 can only bust: as a fresh start it never finishes. 40 carries 2
  // into a next visit on the third dart half the time, so its chain is
  // trapped too; 18 and 20 only see 2 inside the visit and stay finite.
  const results = estimateRouteEfficiencies(
    modelOf(
      transition(40, 20, 100),
      transition(20, 18, 100),
      transition(18, 0, 50),
      transition(18, 2, 50),
      transition(2, null, 100, true),
    ),
  );
  const route2 = byScore(results, 2);
  assert.equal(route2.status, "non-finishing");
  assert.equal(route2.expectedDarts, null);
  assert.deepEqual(route2.states, []);
  assert.deepEqual(route2.closedScores, [2]);

  const route40 = byScore(results, 40);
  assert.equal(route40.status, "non-finishing");
  assert.equal(route40.expectedDarts, null);
  assert.deepEqual(route40.closedScores, [2]);

  closeTo(byScore(results, 18).expectedDarts, 3);
  closeTo(byScore(results, 20).expectedDarts, 5);
});

test("sparse samples warn without erasing the empirical result", () => {
  const result = byScore(
    estimateRouteEfficiencies(
      modelOf(
        transition(40, 0, 13),
        transition(40, 20, 12),
        transition(20, 0, 10),
        transition(20, null, 9, true),
      ),
    ),
    40,
  );
  assert.equal(result.status, "ok");
  assert.ok(Number.isFinite(result.expectedDarts));
  closeTo(result.expectedDarts, 1.48 / (0.52 + (0.48 * 10) / 19));
  assert.equal(result.minSamples, 19);
  assert.ok(result.minSamples < MIN_ROUTE_SAMPLES);
});

test("empty history marks every target missing without fake zeros", () => {
  const results = estimateRouteEfficiencies(analyzeFinishing([]));
  assert.equal(results.length, 21);
  for (const result of results) {
    assert.equal(result.status, "missing");
    assert.equal(result.expectedDarts, null);
    assert.deepEqual(result.states, []);
    assert.deepEqual(result.missingScores, [result.score]);
    assert.deepEqual(result.closedScores, []);
    assert.equal(result.minSamples, null);
  }
});

test("route efficiencies are deterministic and dedupe-safe", () => {
  const replay = finishing([
    transition(40, 0, 10),
    transition(40, 20, 90),
    transition(20, 0, 30),
    transition(20, 10, 70),
    transition(10, 0, 40),
    transition(10, 4, 60),
    transition(4, 0, 50),
    transition(4, null, 50, true),
  ]);
  const legs = [
    leg("g1", replay),
    leg("g1", replay),
    leg("g2", replay),
  ];
  const forward = estimateRouteEfficiencies(analyzeFinishing(legs));
  const reversed = estimateRouteEfficiencies(
    analyzeFinishing([...legs].reverse()),
  );
  assert.deepEqual(reversed, forward);
  assert.deepEqual(estimateRouteEfficiencies(analyzeFinishing(legs)), forward);
  // Duplicated gameIds collapse, so the pooled route matches one leg each.
  const single = estimateRouteEfficiencies(
    analyzeFinishing([leg("g1", replay), leg("g2", replay)]),
  );
  assert.deepEqual(single, forward);
});

