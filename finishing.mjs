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

/**
 * Empirical probability of checking out `startScore` within one visit of
 * `darts` (1–3) darts, following the pooled transition mix: a checkout
 * (score 0) succeeds, a bust loses the rest of the visit, and running out
 * of darts fails. A reached score with no recorded state is not treated as
 * a fake zero: its branch contributes [0, 1] to the aggregate `lower`/
 * `upper` coverage bounds, the score is listed in `unknownStates`, and the
 * point `estimate` is only reported when every reached branch is known.
 * The bounds express unknown coverage, NOT statistical confidence.
 */
export function estimateCheckout(model, startScore, darts) {
  const dartsUsed = Math.min(
    3,
    Math.max(1, Math.trunc(isFiniteNumber(darts) ? darts : 1)),
  );
  if (!isNonNegative(startScore)) {
    return {
      score: startScore ?? null,
      darts: dartsUsed,
      estimate: null,
      lower: 0,
      upper: 1,
      unknownStates: [],
      minSamples: null,
    };
  }
  const stateMap = new Map();
  const stateList = Array.isArray(model?.states) ? model.states : [];
  for (const state of stateList) {
    if (state && isNonNegative(state.score) && !stateMap.has(state.score))
      stateMap.set(state.score, state);
  }

  const unknown = new Set();
  let minSamples = null;

  function walk(remaining, dartsLeft) {
    if (remaining === 0) return [1, 1];
    if (dartsLeft <= 0) return [0, 0];
    const state = stateMap.get(remaining);
    const outcomes =
      state && Array.isArray(state.outcomes) ? state.outcomes : [];
    if (!state || !isPositive(state.observations) || outcomes.length === 0) {
      unknown.add(remaining);
      return [0, 1];
    }
    if (minSamples === null || state.observations < minSamples)
      minSamples = state.observations;
    let low = 0;
    let high = 0;
    for (const outcome of outcomes) {
      const probability = isNonNegative(outcome?.probability)
        ? outcome.probability
        : 0;
      if (probability === 0) continue;
      // A bust (or malformed outcome) scores nothing and ends the visit.
      if (outcome.bust === true || !isNonNegative(outcome.to)) continue;
      const [branchLow, branchHigh] = walk(outcome.to, dartsLeft - 1);
      low += probability * branchLow;
      high += probability * branchHigh;
    }
    return [low, high];
  }

  const [lower, upper] = walk(startScore, dartsUsed);
  const unknownStates = [...unknown].sort((left, right) => left - right);
  return {
    score: startScore,
    darts: dartsUsed,
    estimate: unknownStates.length === 0 ? lower : null,
    lower,
    upper,
    unknownStates,
    minSamples,
  };
}

