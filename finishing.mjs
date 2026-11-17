// Checkout-route modeling from the normalized per-leg `finishing` replay
// summaries (see history.mjs). All probabilities are pooled historical
// behavior at a remaining score: the replay cannot see intent, so a
// transition only records which score a dart from that remainder reached,
// never what the player aimed at. No optimal-action invention: estimates
// replay the recorded outcome mix, including setup darts, odd leaves and
// busts. Input legs are deduplicated by gameId so a match listed twice
// cannot inflate the model.

const DOUBLE_TARGETS = [
  ...Array.from({ length: 20 }, (_, index) => `d${index + 1}`),
  "bull",
];

const TARGET_SCORE = Object.fromEntries(
  DOUBLE_TARGETS.map((target) => [
    target,
    target === "bull" ? 50 : 2 * Number(target.slice(1)),
  ]),
);

const TARGET_FIELDS = [
  "insideSingles",
  "oddInsideSingles",
  "setupDarts",
  "visits",
  "visitCheckouts",
  "bustVisits",
  "oddLeaves",
];

// Small per-state samples are marked explicitly in the finish matrix.
export const MIN_ROUTE_SAMPLES = 20;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegative = (value) => isFiniteNumber(value) && value >= 0;

const isPositive = (value) => isFiniteNumber(value) && value > 0;

const textKey = (value) =>
  value === null || value === undefined ? "" : String(value);

const compareText = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const dateTimestamp = (value) => {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

// Same duplicate-resolution ordering as analytics.mjs: newest completion
// first, stable IDs as tiebreak, so the model never depends on input order.
function compareStable(left, right) {
  const leftTime = dateTimestamp(left.finishedAt);
  const rightTime = dateTimestamp(right.finishedAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const gameComparison = compareText(textKey(left.gameId), textKey(right.gameId));
  if (gameComparison !== 0) return gameComparison;
  return compareText(textKey(left.matchId), textKey(right.matchId));
}

function dedupeByGame(legs) {
  const records = (Array.isArray(legs) ? legs : [])
    .filter((leg) => leg && typeof leg === "object")
    .slice()
    .sort(compareStable);
  const seen = new Set();
  return records.filter((leg) => {
    if (leg.gameId === null || leg.gameId === undefined) return true;
    const key = textKey(leg.gameId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Wilson score interval at 95%, used only as a descriptive spread for visit
// checkout rates (never as a significance test for recommendations).
function wilsonInterval(successes, total) {
  if (!isPositive(total)) return null;
  const z = 1.96;
  const z2 = z * z;
  const p = successes / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}


/**
 * Pools the normalized `finishing` summaries of completed legs into one
 * deterministic model: per-score transition histograms (`states`) and
 * per-double target profiles (`targets`). Legs whose replay was unusable
 * (`finishing: null`) contribute nothing, including their raw
 * `doubleChances`, so every number here comes from the same leg set.
 */
export function analyzeFinishing(legs) {
  const records = dedupeByGame(legs).filter(
    (leg) => leg.finishing && typeof leg.finishing === "object",
  );

  const stateMap = new Map();
  for (const leg of records) {
    const transitions = Array.isArray(leg.finishing.transitions)
      ? leg.finishing.transitions
      : [];
    for (const entry of transitions) {
      if (!entry || typeof entry !== "object") continue;
      const { from, count } = entry;
      if (!isNonNegative(from) || !isPositive(count)) continue;
      const bust = entry.bust === true || entry.to === null;
      const to = bust ? null : entry.to;
      if (!bust && !isNonNegative(to)) continue;
      if (!stateMap.has(from)) stateMap.set(from, new Map());
      const outcomes = stateMap.get(from);
      const key = bust ? "bust" : `to:${to}`;
      if (!outcomes.has(key)) outcomes.set(key, { to, bust, count: 0 });
      outcomes.get(key).count += count;
    }
  }

  const states = [...stateMap.entries()]
    .sort(([leftScore], [rightScore]) => leftScore - rightScore)
    .map(([score, outcomes]) => {
      const list = [...outcomes.values()].sort((left, right) => {
        if (left.bust !== right.bust) return left.bust ? 1 : -1;
        return (left.to ?? 0) - (right.to ?? 0);
      });
      const observations = list.reduce((sum, outcome) => sum + outcome.count, 0);
      return {
        score,
        observations,
        outcomes: list.map((outcome) => ({
          to: outcome.to,
          bust: outcome.bust,
          count: outcome.count,
          probability: outcome.count / observations,
        })),
      };
    });

  const pooled = new Map(
    DOUBLE_TARGETS.map((target) => [
      target,
      {
        chances: 0,
        hits: 0,
        ...Object.fromEntries(TARGET_FIELDS.map((field) => [field, 0])),
      },
    ]),
  );
  for (const leg of records) {
    const profiles =
      leg.finishing.targets && typeof leg.finishing.targets === "object"
        ? leg.finishing.targets
        : {};
    for (const target of DOUBLE_TARGETS) {
      const slot = pooled.get(target);
      const profile = profiles[target];
      if (profile && typeof profile === "object") {
        for (const field of TARGET_FIELDS)
          if (isNonNegative(profile[field])) slot[field] += profile[field];
      }
      // Raw exact-double chances from the same finishing legs only.
      const chance = leg.doubleChances?.[target];
      if (chance && typeof chance === "object") {
        if (isNonNegative(chance.total)) slot.chances += chance.total;
        if (isNonNegative(chance.hits)) slot.hits += chance.hits;
      }
    }
  }

  const targets = DOUBLE_TARGETS.map((target) => {
    const slot = pooled.get(target);
    return {
      target,
      score: TARGET_SCORE[target],
      chances: slot.chances,
      hits: slot.hits,
      hitRate: slot.chances > 0 ? slot.hits / slot.chances : null,
      insideSingles: slot.insideSingles,
      oddInsideSingles: slot.oddInsideSingles,
      setupDarts: slot.setupDarts,
      visits: slot.visits,
      visitCheckouts: slot.visitCheckouts,
      visitRate: slot.visits > 0 ? slot.visitCheckouts / slot.visits : null,
      visitInterval: wilsonInterval(slot.visitCheckouts, slot.visits),
      bustVisits: slot.bustVisits,
      oddLeaves: slot.oddLeaves,
    };
  });

  return { states, targets, coverage: { legs: records.length } };
}

// Scores a fresh visit can legally finish on: the doubles D1–D20 and bull.
// A dart thrown from any other remaining score is a setup dart.
const FINISHABLE_SCORES = new Set([
  ...Array.from({ length: 20 }, (_, index) => 2 * (index + 1)),
  50,
]);

// Outcome probabilities are count/observations ratios, so their pooled sum
// can deviate from 1 by a few float ulps; anything larger is malformed.
const PROBABILITY_TOLERANCE = 1e-9;

/**
 * Whole-chain finishing efficiency for every pooled double target: the
 * expected ACTUAL darts needed to reach 0 starting a fresh three-dart
 * visit at the target score, replaying the pooled transition mix across
 * as many visits as needed. Lower is better; no route is ever labeled
 * optimal. Scores only decrease within a visit. A bust ends the visit
 * immediately, forfeits its unused darts and restarts at the CURRENT
 * visit start; spending all three darts carries the remainder into the
 * next visit. Every quantity solves the exact linear renewal
 *   E(S) = (own visit cost + Σ P(end at R<S) · E(R))
 *          / (P(finish) + Σ P(end at R<S))
 * where the denominator sums explicit escape probabilities so a tiny
 * positive escape never cancels to zero. Only status "ok" reports finite
 * totals and per-state dart occupancy (`states`, which sums to
 * `expectedDarts`). A positive-probability reachable score with no
 * trustworthy recorded outcomes makes the target "missing"; a reachable
 * closed class with no checkout escape makes it "non-finishing" (its
 * trap scores are listed in `closedScores`). Neither is ever replaced by
 * a fabricated finite number. `minSamples` keeps the smallest reachable
 * state sample so sparse data stays visible without erasing the result.
 */
export function estimateRouteEfficiencies(model) {
  const stateMap = new Map();
  const stateList = Array.isArray(model?.states) ? model.states : [];
  for (const state of stateList) {
    if (!state || typeof state !== "object") continue;
    const score = state.score;
    if (!Number.isInteger(score) || score < 2 || score > 60) continue;
    if (!stateMap.has(score)) stateMap.set(score, state);
  }

  const emptyWalk = () => ({
    darts: 0,
    setup: 0,
    forfeited: 0,
    finish: 0,
    bust: 0,
    ends: new Map(),
    occ: new Map(),
    missing: new Set(),
    minObs: null,
  });

  // Aggregates the rest of the current visit from `remaining` with
  // `dartsLeft` throws to go: expected darts thrown, setup darts,
  // forfeited bust slots, checkout/bust probabilities, end-of-visit
  // remainder distribution, per-score dart occupancy, unreachable-data
  // markers and the smallest pooled sample. Depth is bounded by
  // dartsLeft (self-loops spend a dart), so the walk always terminates.
  const walkMemo = new Map();
  function walk(remaining, dartsLeft) {
    const key = remaining * 4 + dartsLeft;
    const cached = walkMemo.get(key);
    if (cached) return cached;
    const result = computeWalk(remaining, dartsLeft);
    walkMemo.set(key, result);
    return result;
  }

  function computeWalk(remaining, dartsLeft) {
    if (dartsLeft === 0) {
      const ended = emptyWalk();
      ended.ends.set(remaining, 1);
      return ended;
    }
    const state = stateMap.get(remaining);
    let valid =
      state &&
      isPositive(state.observations) &&
      Array.isArray(state.outcomes) &&
      state.outcomes.length > 0;
    const branches = [];
    let totalProbability = 0;
    if (valid) {
      for (const outcome of state.outcomes) {
        const probability = outcome?.probability;
        if (!isFiniteNumber(probability) || probability < 0) {
          valid = false;
          break;
        }
        if (probability === 0) continue;
        totalProbability += probability;
        if (outcome.bust === true) {
          branches.push({ bust: true, probability });
          continue;
        }
        const to = outcome.to;
        // A legal outcome checks out or leaves 2..from; anything else
        // (increases, 1, non-integers) is untrustworthy recorded data.
        if (
          !Number.isInteger(to) ||
          (to !== 0 && (to < 2 || to > remaining))
        ) {
          valid = false;
          break;
        }
        branches.push({ to, probability });
      }
      if (valid && Math.abs(totalProbability - 1) > PROBABILITY_TOLERANCE)
        valid = false;
    }
    if (!valid) {
      // Unrecorded or malformed state: the branch is reported missing
      // instead of manufacturing a finite result from nothing.
      const unknown = emptyWalk();
      unknown.missing.add(remaining);
      return unknown;
    }

    const result = emptyWalk();
    result.minObs = state.observations;
    const setupDart = FINISHABLE_SCORES.has(remaining) ? 0 : 1;
    for (const branch of branches) {
      const probability = branch.probability;
      // The throw itself is spent at this remaining score either way.
      result.darts += probability;
      result.setup += probability * setupDart;
      result.occ.set(
        remaining,
        (result.occ.get(remaining) ?? 0) + probability,
      );
      if (branch.bust) {
        result.bust += probability;
        result.forfeited += probability * (dartsLeft - 1);
        continue;
      }
      if (branch.to === 0) {
        result.finish += probability;
        continue;
      }
      const child = walk(branch.to, dartsLeft - 1);
      result.darts += probability * child.darts;
      result.setup += probability * child.setup;
      result.forfeited += probability * child.forfeited;
      result.finish += probability * child.finish;
      result.bust += probability * child.bust;
      for (const [score, chance] of child.ends)
        result.ends.set(
          score,
          (result.ends.get(score) ?? 0) + probability * chance,
        );
      for (const [score, darts] of child.occ)
        result.occ.set(score, (result.occ.get(score) ?? 0) + probability * darts);
      for (const score of child.missing) result.missing.add(score);
      if (
        child.minObs !== null &&
        (result.minObs === null || child.minObs < result.minObs)
      )
        result.minObs = child.minObs;
    }
    return result;
  }

  // Renewal solve for one starting score. End-of-visit remainders are
  // strictly below the start, so recursing into them always terminates.
  const scoreMemo = new Map();
  function solveScore(score) {
    const cached = scoreMemo.get(score);
    if (cached) return cached;

    const visit = walk(score, 3);
    const lowerEnds = [...visit.ends.keys()]
      .filter((remainder) => remainder !== score)
      .sort((left, right) => left - right);
    const branches = lowerEnds.map((remainder) => ({
      remainder,
      probability: visit.ends.get(remainder),
      sub: solveScore(remainder),
    }));

    const missing = new Set(visit.missing);
    let minSamples = visit.minObs;
    const considerSamples = (value) => {
      if (value !== null && (minSamples === null || value < minSamples))
        minSamples = value;
    };
    for (const { sub } of branches) {
      for (const missingScore of sub.missingScores) missing.add(missingScore);
      considerSamples(sub.minSamples);
    }

    const emptyTotals = {
      expectedDarts: null,
      expectedVisits: null,
      expectedSetupDarts: null,
      expectedForfeitedDarts: null,
      states: [],
    };

    let result;
    if (missing.size > 0) {
      result = {
        score,
        status: "missing",
        ...emptyTotals,
        missingScores: [...missing].sort((left, right) => left - right),
        closedScores: [],
        minSamples,
      };
    } else {
      // Escape probability per visit, summed from explicit successful or
      // strictly-lower terminations so a tiny escape never cancels out.
      const escape = branches.reduce(
        (sum, { probability }) => sum + probability,
        visit.finish,
      );
      const traps = branches.filter(({ sub }) => sub.status === "non-finishing");
      if (escape === 0 || traps.length > 0) {
        const closed = new Set();
        // No finish and no lower remainder: the visit can only return to
        // its start, so this score itself traps the chain forever.
        if (escape === 0) closed.add(score);
        for (const { sub } of traps)
          for (const trap of sub.closedScores) closed.add(trap);
        result = {
          score,
          status: "non-finishing",
          ...emptyTotals,
          missingScores: [],
          closedScores: [...closed].sort((left, right) => left - right),
          minSamples,
        };
      } else {
        let carryDarts = 0;
        let carryVisits = 0;
        let carrySetup = 0;
        let carryForfeited = 0;
        const occupancy = new Map();
        for (const { probability, sub } of branches) {
          carryDarts += probability * sub.expectedDarts;
          carryVisits += probability * sub.expectedVisits;
          carrySetup += probability * sub.expectedSetupDarts;
          carryForfeited += probability * sub.expectedForfeitedDarts;
          for (const state of sub.states)
            occupancy.set(
              state.score,
              (occupancy.get(state.score) ?? 0) +
                probability * state.expectedDarts,
            );
        }
        for (const [stateScore, darts] of visit.occ)
          occupancy.set(stateScore, (occupancy.get(stateScore) ?? 0) + darts);
        result = {
          score,
          status: "ok",
          expectedDarts: (visit.darts + carryDarts) / escape,
          expectedVisits: (1 + carryVisits) / escape,
          expectedSetupDarts: (visit.setup + carrySetup) / escape,
          expectedForfeitedDarts:
            (visit.forfeited + carryForfeited) / escape,
          states: [...occupancy.keys()]
            .sort((left, right) => left - right)
            .map((stateScore) => ({
              score: stateScore,
              expectedDarts: occupancy.get(stateScore) / escape,
              observations: stateMap.get(stateScore)?.observations ?? null,
            })),
          missingScores: [],
          closedScores: [],
          minSamples,
        };
      }
    }
    scoreMemo.set(score, result);
    return result;
  }

  const targets = Array.isArray(model?.targets) ? model.targets : [];
  return targets.map((target) => {
    const score = target?.score;
    if (!Number.isInteger(score) || score < 2 || score > 60)
      return {
        score: score ?? null,
        status: "missing",
        expectedDarts: null,
        expectedVisits: null,
        expectedSetupDarts: null,
        expectedForfeitedDarts: null,
        states: [],
        missingScores: [],
        closedScores: [],
        minSamples: null,
      };
    return solveScore(score);
  });
}

