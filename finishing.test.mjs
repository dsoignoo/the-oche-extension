import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFinishing,
  estimateCheckout,
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

// 40 → 20 → 10 → 0 is a stronger three-dart route than 36 → 18 → 9.
// Every state carries 100 observed darts.
function routeModel() {
  return analyzeFinishing([
    leg(
      "g1",
      finishing(
        [
          transition(40, 0, 10),
          transition(40, 20, 90),
          transition(20, 0, 30),
          transition(20, 10, 70),
          transition(10, 0, 40),
          transition(10, 4, 60),
          transition(36, 0, 20),
          transition(36, 18, 80),
          transition(18, 0, 25),
          transition(18, 9, 75),
          transition(9, 8, 100),
        ],
      ),
    ),
  ]);
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

test("one-dart estimate is the pooled direct checkout rate", () => {
  const model = analyzeFinishing([
    leg("g1", finishing([transition(36, 0, 3), transition(36, 18, 7)])),
  ]);
  const result = estimateCheckout(model, 36, 1);
  assert.equal(result.estimate, 0.3);
  assert.equal(result.lower, 0.3);
  assert.equal(result.upper, 0.3);
  assert.deepEqual(result.unknownStates, []);
  assert.equal(result.minSamples, 10);
});

test("a full route can win despite a lower direct double rate", () => {
  // 32 has the better direct rate (0.5 vs 0.4) but its miss leaves 16,
  // which rarely finishes; the 40 route finishes far more often overall.
  const model = analyzeFinishing([
    leg(
      "g1",
      finishing([
        transition(40, 0, 40),
        transition(40, 20, 60),
        transition(20, 0, 90),
        transition(20, 10, 10),
        transition(32, 0, 50),
        transition(32, 16, 50),
        transition(16, 0, 10),
        transition(16, 8, 90),
      ]),
    ),
  ]);

  closeTo(estimateCheckout(model, 40, 1).estimate, 0.4);
  closeTo(estimateCheckout(model, 32, 1).estimate, 0.5);
  closeTo(estimateCheckout(model, 40, 2).estimate, 0.4 + 0.6 * 0.9);
  closeTo(estimateCheckout(model, 32, 2).estimate, 0.5 + 0.5 * 0.1);

});

test("an odd leave consumes an extra setup dart", () => {
  const model = analyzeFinishing([
    leg(
      "g1",
      finishing([
        transition(18, 0, 20),
        transition(18, 9, 80),
        transition(9, 8, 100),
        transition(8, 0, 50),
        transition(8, 4, 50),
      ]),
    ),
  ]);

  // Two darts: missing d9 to 9 cannot finish, the setup dart only reaches 8.
  closeTo(estimateCheckout(model, 18, 2).estimate, 0.2);
  // Three darts: 9 → 8 → d4 recovers half of the misses.
  closeTo(estimateCheckout(model, 18, 3).estimate, 0.2 + 0.8 * 0.5);
});

test("36 versus 40 path follows the recorded route mix", () => {
  const model = routeModel();
  // 40 → (20 → (10 → 0)): 0.1 + 0.9 * (0.3 + 0.7 * 0.4)
  closeTo(estimateCheckout(model, 40, 3).estimate, 0.622);
  // 36 → (18 → 9 odd): 0.2 + 0.8 * 0.25, the odd 9 strand dead-ends.
  closeTo(estimateCheckout(model, 36, 3).estimate, 0.4);
  assert.equal(estimateCheckout(model, 40, 3).minSamples, 100);

});

test("a bust loses the rest of the visit while a miss can recover", () => {
  const model = analyzeFinishing([
    leg(
      "g1",
      finishing([
        transition(16, 0, 30),
        transition(16, null, 20, true),
        transition(16, 8, 50),
        transition(8, 0, 60),
        transition(8, 4, 40),
        transition(2, null, 50, true),
      ]),
    ),
  ]);

  closeTo(estimateCheckout(model, 16, 1).estimate, 0.3);
  // Busted 20% contributes nothing; the 50% miss to 8 still finishes at 0.6.
  closeTo(estimateCheckout(model, 16, 2).estimate, 0.3 + 0.5 * 0.6);
  // A state whose only outcome is a bust never finishes.
  assert.equal(estimateCheckout(model, 2, 3).estimate, 0);
});

test("missing states produce honest bounds instead of fake zeros", () => {
  const model = analyzeFinishing([
    leg("g1", finishing([transition(40, 0, 10), transition(40, 20, 90)])),
  ]);

  const sparse = estimateCheckout(model, 40, 2);
  assert.equal(sparse.estimate, null);
  closeTo(sparse.lower, 0.1);
  closeTo(sparse.upper, 1);
  assert.deepEqual(sparse.unknownStates, [20]);
  assert.equal(sparse.minSamples, 100);

  const empty = estimateCheckout(analyzeFinishing([]), 40, 1);
  assert.equal(empty.estimate, null);
  assert.equal(empty.lower, 0);
  assert.equal(empty.upper, 1);
  assert.deepEqual(empty.unknownStates, [40]);
  assert.equal(empty.minSamples, null);

  // Score 0 is already checked out without consulting any state.
  const done = estimateCheckout(model, 0, 3);
  assert.equal(done.estimate, 1);
  assert.equal(done.minSamples, null);

});

test("route estimates retain the smallest state sample for sparse-data labels", () => {
  const model = analyzeFinishing([
    leg(
      "g1",
      finishing([
        transition(40, 0, 9),
        transition(40, 20, 10),
        transition(20, 0, 10),
        transition(20, null, 9, true),
      ]),
    ),
  ]);
  const result = estimateCheckout(model, 40, 2);
  assert.equal(result.minSamples, 19);
  closeTo(result.estimate, 271 / 361);
  assert.deepEqual(result.unknownStates, []);
});

