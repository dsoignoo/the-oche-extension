// Date-range analytics computed from the full normalized personal X01 leg
// history, replacing the remote aggregated stats endpoint.
// Input is already date-filtered by the history reader; gameId duplicates
// are still removed defensively before anything is counted.
import { analyzeFinishing } from "./finishing.mjs";

const VISIT_FIELDS = [
  "less60",
  "plus60",
  "plus100",
  "plus140",
  "plus170",
  "total180",
];

const DOUBLE_TARGETS = [
  ...Array.from({ length: 20 }, (_, index) => `d${index + 1}`),
  "bull",
];

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

const hasScore = (leg) => isNonNegative(leg?.points) && isPositive(leg?.darts);

const legAverage = (leg) =>
  hasScore(leg) ? (3 * leg.points) / leg.darts : null;

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// Newest first by completion time, then stable IDs, so truncated top-10
// lists and duplicate resolution never depend on input ordering.
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

const hasHighVisits = (leg) =>
  leg?.highVisits &&
  typeof leg.highVisits === "object" &&
  VISIT_FIELDS.every((field) => isNonNegative(leg.highVisits[field]));

const hasDoubleChances = (leg) =>
  leg?.doubleChances && typeof leg.doubleChances === "object";

const hasCheckout = (leg) =>
  isNonNegative(leg?.checkout?.score) && leg.checkout.score > 0;

function validInterval(leg) {
  const start = dateTimestamp(leg?.startedAt);
  const end = dateTimestamp(leg?.finishedAt);
  if (start === Number.NEGATIVE_INFINITY || end === Number.NEGATIVE_INFINITY)
    return null;
  return start <= end ? [start, end] : null;
}

// Union of [startedAt, finishedAt] intervals in seconds. Overlapping legs
// (e.g. parallel sets) count wall-clock time only once.
function unionPlaytime(legs) {
  const intervals = [];
  let timedLegs = 0;
  for (const leg of legs) {
    const interval = validInterval(leg);
    if (!interval) continue;
    timedLegs += 1;
    intervals.push(interval);
  }
  if (intervals.length === 0) return { playtime: null, timedLegs };
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let [currentStart, currentEnd] = intervals[0];
  for (let index = 1; index < intervals.length; index += 1) {
    const [start, end] = intervals[index];
    if (start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  total += currentEnd - currentStart;
  return { playtime: total / 1000, timedLegs };
}

function sumHighVisits(legs) {
  const totals = Object.fromEntries(VISIT_FIELDS.map((field) => [field, 0]));
  let visitLegs = 0;
  for (const leg of legs) {
    if (!hasHighVisits(leg)) continue;
    visitLegs += 1;
    for (const field of VISIT_FIELDS) totals[field] += leg.highVisits[field];
  }
  return { totals, visitLegs };
}

function poolDoublePerformance(legs) {
  const performance = Object.fromEntries(
    DOUBLE_TARGETS.map((target) => [target, { hits: 0, total: 0 }]),
  );
  let doubleLegs = 0;
  for (const leg of legs) {
    if (!hasDoubleChances(leg)) continue;
    doubleLegs += 1;
    for (const [target, chance] of Object.entries(leg.doubleChances)) {
      if (!chance || typeof chance !== "object") continue;
      const hits = isNonNegative(chance.hits) ? chance.hits : 0;
      const total = isNonNegative(chance.total) ? chance.total : 0;
      if (!performance[target]) performance[target] = { hits: 0, total: 0 };
      performance[target].hits += hits;
      performance[target].total += total;
    }
  }
  for (const entry of Object.values(performance)) {
    entry.percent = entry.total > 0 ? entry.hits / entry.total : null;
  }
  return { performance, doubleLegs };
}

function poolCheckoutPerformance(legs) {
  let hits = 0;
  let attempts = 0;
  let recordedLegs = 0;
  let eligibleLegs = 0;
  for (const leg of legs) {
    if (leg.doubleOut !== true) continue;
    eligibleLegs += 1;
    if (
      !isNonNegative(leg.checkoutHits) ||
      !isNonNegative(leg.checkoutAttempts) ||
      leg.checkoutHits > leg.checkoutAttempts
    ) continue;
    hits += leg.checkoutHits;
    attempts += leg.checkoutAttempts;
    recordedLegs += 1;
  }
  const known = recordedLegs > 0 || eligibleLegs === 0;
  return {
    hits: known ? hits : null,
    attempts: known ? attempts : null,
    percent: attempts > 0 ? hits / attempts : null,
    recordedLegs,
    eligibleLegs,
  };
}

function countGamesByType(legs) {
  const matchesByType = new Map();
  for (const leg of legs) {
    const type = textKey(leg.matchType) || "unknown";
    if (!matchesByType.has(type)) matchesByType.set(type, new Set());
    if (leg.matchId !== null && leg.matchId !== undefined)
      matchesByType.get(type).add(textKey(leg.matchId));
  }
  return Object.fromEntries(
    [...matchesByType.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([type, matches]) => [type, matches.size]),
  );
}

function bestGames(legs) {
  return legs
    .filter((leg) => leg.won === true && hasScore(leg))
    .sort((left, right) => {
      if (left.darts !== right.darts) return left.darts - right.darts;
      const averageDiff = legAverage(right) - legAverage(left);
      if (averageDiff !== 0) return averageDiff;
      return compareStable(left, right);
    })
    .slice(0, 10)
    .map((leg) => ({
      matchId: leg.matchId ?? null,
      matchDate: leg.finishedAt ?? null,
      gameId: leg.gameId ?? null,
      set: leg.set ?? null,
      leg: leg.leg ?? null,
      numDarts: leg.darts,
      average: round(legAverage(leg), 2),
    }));
}

function bestCheckouts(legs) {
  return legs
    .filter((leg) => leg.won === true && hasCheckout(leg))
    .sort((left, right) => {
      if (left.checkout.score !== right.checkout.score)
        return right.checkout.score - left.checkout.score;
      return compareStable(left, right);
    })
    .slice(0, 10)
    .map((leg) => ({
      matchId: leg.matchId ?? null,
      matchDate: leg.finishedAt ?? null,
      score: leg.checkout.score,
      targets: leg.checkout.targets ?? null,
    }));
}

/**
 * Computes UI analytics from normalized completed X01 legs for one account.
 * Legs are expected to be pre-filtered to the requested date range; ordering
 * and duplicate game records are normalized here before aggregation.
 */
export function analyzeHistory(legs, coverage = {}) {
  const records = dedupeByGame(legs);

  const numDarts = records.reduce(
    (sum, leg) => (isNonNegative(leg.darts) ? sum + leg.darts : sum),
    0,
  );
  const matchIds = new Set(
    records
      .map((leg) => leg.matchId)
      .filter((id) => id !== null && id !== undefined)
      .map(textKey),
  );
  const numLegsWon = records.filter((leg) => leg.won === true).length;

  const { playtime, timedLegs } = unionPlaytime(records);
  const { totals: highVisits, visitLegs } = sumHighVisits(records);
  const { performance: doublePerformance, doubleLegs } =
    poolDoublePerformance(records);
  const checkoutPerformance = poolCheckoutPerformance(records);
  const doubleEligibleLegs = checkoutPerformance.eligibleLegs;

  let averageBest = null;
  let numDartsBest = null;
  let bestCheckout = null;
  for (const leg of records) {
    const average = legAverage(leg);
    if (average !== null && (averageBest === null || average > averageBest))
      averageBest = average;
    if (leg.won === true && isPositive(leg.darts) && (numDartsBest === null || leg.darts < numDartsBest))
      numDartsBest = leg.darts;
    if (leg.won === true && hasCheckout(leg) && (bestCheckout === null || leg.checkout.score > bestCheckout))
      bestCheckout = leg.checkout.score;
  }

  return {
    numDarts,
    numGames: matchIds.size,
    numLegsPlayed: records.length,
    numLegsWon,
    fun: {
      playtime,
      walkingDistance: null,
    },
    highVisits,
    doublePerformance,
    checkoutPerformance,
    finishing: analyzeFinishing(records),
    performanceBest: {
      averageBest,
      numDartsBest,
      bestCheckout,
    },
    gameCounts: countGamesByType(records),
    bestGames: bestGames(records),
    bestCheckouts: bestCheckouts(records),
    coverage: {
      ...coverage,
      timedLegs,
      visitLegs,
      doubleLegs,
      doubleEligibleLegs,
    },
  };
}
