const DEFAULT_LIMIT = 200;
const MIN_COMPARISON_LEGS = 10;
const MIN_PERCENTILE_SIGNAL_LEGS = 20;
const MIN_CHECKOUT_ATTEMPTS = 30;
const SCORE_CHANGE_THRESHOLD = 1;
const CHECKOUT_CHANGE_THRESHOLD = 0.01;
const ROLLING_WINDOW = 25;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isLegScore(record) {
  return (
    isFiniteNumber(record?.points) &&
    isFiniteNumber(record?.darts) &&
    record.darts > 0
  );
}

function legAverage(record) {
  if (!isLegScore(record)) return null;
  const average = (3 * record.points) / record.darts;
  return isFiniteNumber(average) ? average : null;
}

function dateTimestamp(value) {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function dateValue(record) {
  return dateTimestamp(record?.finishedAt) === Number.NEGATIVE_INFINITY
    ? null
    : record.finishedAt;
}

function textKey(value) {
  return value === null || value === undefined ? "" : String(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordTieBreaker(record) {
  const opponent = record.opponent ?? {};
  return [
    record.gameId,
    record.matchId,
    record.set,
    record.leg,
    record.finishedAt,
    record.format,
    record.matchType,
    record.won,
    opponent.id,
    opponent.name,
    record.darts,
    record.points,
    record.first9Points,
    record.first9Darts,
    record.scoringPoints,
    record.scoringDarts,
    record.checkoutHits,
    record.checkoutAttempts,
    record.visits,
    record.tons,
    record.busts,
    record.scoringVisits,
    record.lowScoringVisits,
  ]
    .map(textKey)
    .join("\u0001");
}

function sortAndDeduplicate(legs) {
  const records = Array.isArray(legs)
    ? legs.filter((leg) => leg && typeof leg === "object").slice()
    : [];
  records.sort((left, right) => {
    const leftDate = dateTimestamp(left.finishedAt);
    const rightDate = dateTimestamp(right.finishedAt);
    if (leftDate !== rightDate) return rightDate - leftDate;

    const gameComparison = compareText(
      textKey(left.gameId),
      textKey(right.gameId),
    );
    if (gameComparison !== 0) return gameComparison;

    return compareText(recordTieBreaker(left), recordTieBreaker(right));
  });

  const gameIds = new Set();
  return records.filter((record) => {
    if (record.gameId === null || record.gameId === undefined) return true;
    const key = textKey(record.gameId);
    if (gameIds.has(key)) return false;
    gameIds.add(key);
    return true;
  });
}

function sumKnown(records, field) {
  let total = 0;
  let count = 0;
  for (const record of records) {
    const value = record[field];
    if (isNonNegativeNumber(value)) {
      total += value;
      count += 1;
    }
  }
  return count === 0 || !isFiniteNumber(total) ? null : total;
}

function pooledRate(records, numeratorField, denominatorField) {
  let numerator = 0;
  let denominator = 0;
  let count = 0;
  for (const record of records) {
    const numeratorValue = record[numeratorField];
    const denominatorValue = record[denominatorField];
    if (
      isNonNegativeNumber(numeratorValue) &&
      isNonNegativeNumber(denominatorValue) &&
      numeratorValue <= denominatorValue
    ) {
      numerator += numeratorValue;
      denominator += denominatorValue;
      count += 1;
    }
  }

  if (
    count === 0 ||
    !isFiniteNumber(numerator) ||
    !isFiniteNumber(denominator)
  ) {
    return { numerator: null, denominator: null, rate: null };
  }
  const rate = denominator === 0 ? null : numerator / denominator;
  return {
    numerator,
    denominator,
    rate: isFiniteNumber(rate) && rate >= 0 && rate <= 1 ? rate : null,
  };
}

function weightedAverage(records, pointsField, dartsField) {
  let points = 0;
  let darts = 0;
  for (const record of records) {
    const recordPoints = record[pointsField];
    const recordDarts = record[dartsField];
    if (
      isFiniteNumber(recordPoints) &&
      isFiniteNumber(recordDarts) &&
      recordDarts > 0
    ) {
      points += recordPoints;
      darts += recordDarts;
    }
  }
  if (darts === 0 || !isFiniteNumber(points) || !isFiniteNumber(darts))
    return null;
  const average = (3 * points) / darts;
  return isFiniteNumber(average) ? average : null;
}

function percentileR7(values, percentile) {
  if (values.length === 0) return null;
  const position = (values.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  const lower = values[lowerIndex];
  const upper = values[Math.min(lowerIndex + 1, values.length - 1)];
  const value = lower + (upper - lower) * fraction;
  return isFiniteNumber(value) ? value : null;
}

function distinctMatchCount(records) {
  const matches = new Set();
  for (const record of records) {
    if (record.matchId !== null && record.matchId !== undefined)
      matches.add(textKey(record.matchId));
  }
  return matches.size;
}

function summarize(records) {
  const legAverages = [];
  let wins = 0;
  let knownResults = 0;

  for (const record of records) {
    const average = legAverage(record);
    if (average !== null) legAverages.push(average);
    if (record.won === true) {
      wins += 1;
      knownResults += 1;
    } else if (record.won === false) {
      knownResults += 1;
    }
  }

  legAverages.sort((left, right) => left - right);
  const p10 = percentileR7(legAverages, 0.1);
  const p50 = percentileR7(legAverages, 0.5);
  const p90 = percentileR7(legAverages, 0.9);
  const checkout = pooledRate(records, "checkoutHits", "checkoutAttempts");
  const tonRate = pooledRate(records, "tons", "visits");
  const bustRate = pooledRate(records, "busts", "visits");
  const lowVisitRate = pooledRate(records, "lowScoringVisits", "scoringVisits");
  const above50Count =
    legAverages.length === 0
      ? null
      : legAverages.filter((average) => average >= 50).length;

  return {
    n: records.length,
    matches: distinctMatchCount(records),
    average: weightedAverage(records, "points", "darts"),
    first9Average: weightedAverage(records, "first9Points", "first9Darts"),
    scoringAverage: weightedAverage(records, "scoringPoints", "scoringDarts"),
    checkoutRate: checkout.rate,
    checkoutHits: checkout.numerator,
    checkoutAttempts: checkout.denominator,
    wins: knownResults === 0 ? null : wins,
    winRate: knownResults === 0 ? null : wins / knownResults,
    p10,
    p50,
    p90,
    spread: p10 === null || p90 === null ? null : p90 - p10,
    above50Count,
    above50Rate:
      above50Count === null ? null : above50Count / legAverages.length,
    tons: sumKnown(records, "tons"),
    visits: sumKnown(records, "visits"),
    tonRate: tonRate.rate,
    busts: sumKnown(records, "busts"),
    bustRate: bustRate.rate,
    scoringVisits: sumKnown(records, "scoringVisits"),
    lowScoringVisits: sumKnown(records, "lowScoringVisits"),
    lowVisitRate: lowVisitRate.rate,
  };
}

function formatNumber(value, digits = 1) {
  return value.toFixed(digits);
}

function hasLegComparison(left, right) {
  return (
    left.n >= MIN_COMPARISON_LEGS &&
    right.n >= MIN_COMPARISON_LEGS &&
    left.average !== null &&
    right.average !== null
  );
}

function hasCheckoutComparison(left, right) {
  return (
    left.n >= MIN_COMPARISON_LEGS &&
    right.n >= MIN_COMPARISON_LEGS &&
    left.checkoutRate !== null &&
    right.checkoutRate !== null &&
    left.checkoutAttempts >= MIN_CHECKOUT_ATTEMPTS &&
    right.checkoutAttempts >= MIN_CHECKOUT_ATTEMPTS
  );
}

function comparisonDetail(label, current, previous, delta, unit) {
  const direction = delta >= 0 ? "+" : "";
  return `${label}: ${formatNumber(current)} versus ${formatNumber(previous)} (${direction}${formatNumber(delta)}${unit}); both samples have at least ${MIN_COMPARISON_LEGS} legs. This is descriptive, not causal.`;
}

function checkoutDetail(
  label,
  current,
  previous,
  currentAttempts,
  previousAttempts,
  delta,
) {
  const direction = delta >= 0 ? "+" : "";
  return `${label}: ${(current * 100).toFixed(1)}% versus ${(previous * 100).toFixed(1)}% (${direction}${(delta * 100).toFixed(1)} percentage points; ${currentAttempts} and ${previousAttempts} attempts). This is descriptive, not causal.`;
}

function buildSignals(current, previous) {
  const signals = [];
  const add = (kind, title, detail) => {
    if (signals.length < 4) signals.push({ kind, title, detail });
  };
  if (hasLegComparison(current, previous)) {
    const change = current.average - previous.average;
    if (Math.abs(change) >= SCORE_CHANGE_THRESHOLD) {
      add(
        change > 0 ? "improving" : "focus",
        change > 0
          ? "Your overall average is moving up"
          : "Recent scoring is lower",
        comparisonDetail(
          `Last ${current.n} legs vs the preceding ${previous.n}`,
          current.average,
          previous.average,
          change,
          " points",
        ),
      );
    }
  }
  if (hasCheckoutComparison(current, previous)) {
    const change = current.checkoutRate - previous.checkoutRate;
    if (Math.abs(change) >= CHECKOUT_CHANGE_THRESHOLD) {
      add(
        change > 0 ? "improving" : "focus",
        change > 0
          ? "You are converting more checkout darts"
          : "Finishing needs some attention",
        checkoutDetail(
          "Current window vs the preceding window",
          current.checkoutRate,
          previous.checkoutRate,
          current.checkoutAttempts,
          previous.checkoutAttempts,
          change,
        ),
      );
    }
  }
  if (
    current.n >= MIN_PERCENTILE_SIGNAL_LEGS &&
    previous.n >= MIN_PERCENTILE_SIGNAL_LEGS
  ) {
    const floorChange = current.p10 - previous.p10;
    const ceilingChange = current.p90 - previous.p90;
    if (floorChange >= SCORE_CHANGE_THRESHOLD && current.p50 >= previous.p50) {
      add(
        "strength",
        "Your weaker legs are getting better",
        `Your P10 floor rose from ${formatNumber(previous.p10)} to ${formatNumber(current.p10)}, while the median moved from ${formatNumber(previous.p50)} to ${formatNumber(current.p50)}. This is not just one standout leg pulling up the average.`,
      );
    } else if (ceilingChange >= SCORE_CHANGE_THRESHOLD) {
      add(
        "strength",
        "Your top-end scoring has another gear",
        `P90 increased from ${formatNumber(previous.p90)} to ${formatNumber(current.p90)}. The lower-end P10 is ${formatNumber(current.p10)} vs ${formatNumber(previous.p10)} before: a higher ceiling does not automatically mean a steadier game.`,
      );
    } else if (floorChange <= -SCORE_CHANGE_THRESHOLD) {
      add(
        "focus",
        "The low-end legs are costing more",
        `P10 fell from ${formatNumber(previous.p10)} to ${formatNumber(current.p10)}. A smaller P10–P90 spread would not be a gain if the floor and typical leg also fall.`,
      );
    }
  }
  if (
    hasLegComparison(current, previous) &&
    current.first9Average !== null &&
    previous.first9Average !== null &&
    current.first9Average < previous.first9Average - SCORE_CHANGE_THRESHOLD
  ) {
    add(
      "focus",
      "Give the opening three visits some attention",
      `First-nine average is ${formatNumber(current.first9Average)}, down from ${formatNumber(previous.first9Average)} in the prior window. Next practice: repeat three-visit starts and track their total score separately from finishing.`,
    );
  } else if (
    current.scoringVisits >= 50 &&
    current.lowVisitRate !== null &&
    current.lowVisitRate >= 0.2
  ) {
    add(
      "focus",
      "Turn the quiet visits into solid scores",
      `${current.lowScoringVisits} of ${current.scoringVisits} full visits starting above 170 scored under 30 (${formatNumber(current.lowVisitRate * 100)}%). Try ten three-dart rounds at your normal scoring target and count sub-30 visits; aim to reduce that count, not just hit one big score.`,
    );
  } else if (
    current.n >= MIN_PERCENTILE_SIGNAL_LEGS &&
    current.above50Count > 0
  ) {
    add(
      "strength",
      "Your 50-plus legs are worth building on",
      `${current.above50Count} of ${current.n} legs reached a 50+ average (${formatNumber(current.above50Rate * 100)}%). ${previous.n ? `The preceding window was ${formatNumber(previous.above50Rate * 100)}%.` : "Keep this as a personal benchmark rather than judging yourself by your single best leg."}`,
    );
  }
  if (previous.n === 0 && current.n > 0) {
    add(
      "context",
      "No prior window yet",
      `There are ${current.n} current legs and no earlier legs available. Current-window observations are not evidence of improvement over time.`,
    );
  } else if (
    current.n > 0 &&
    (current.n < MIN_COMPARISON_LEGS || previous.n < MIN_COMPARISON_LEGS)
  ) {
    add(
      "context",
      "The comparison sample is small",
      `There are ${current.n} current and ${previous.n} preceding legs. Most change signals require at least ${MIN_COMPARISON_LEGS} in each group; percentile signals require ${MIN_PERCENTILE_SIGNAL_LEGS}.`,
    );
  }
  if (!signals.length && current.n >= MIN_COMPARISON_LEGS) {
    add(
      "context",
      "No clear shift in this window",
      `Current average is ${formatNumber(current.average)} across ${current.n} legs. Small observed changes are not presented as a breakthrough; keep watching the floor, median, and checkout sample.`,
    );
  }
  return signals;
}

function rollingRows(records) {
  const chronological = records.slice().reverse();
  const rows = [];
  let rollingPoints = 0;
  let rollingDarts = 0;
  let invalidScores = 0;

  for (let index = 0; index < chronological.length; index += 1) {
    const record = chronological[index];
    if (isLegScore(record)) {
      rollingPoints += record.points;
      rollingDarts += record.darts;
    } else {
      invalidScores += 1;
    }

    if (index >= ROLLING_WINDOW) {
      const removed = chronological[index - ROLLING_WINDOW];
      if (isLegScore(removed)) {
        rollingPoints -= removed.points;
        rollingDarts -= removed.darts;
      } else {
        invalidScores -= 1;
      }
    }

    rows.push({
      index: index + 1,
      date: dateValue(record),
      average: legAverage(record),
      rollingAverage:
        index + 1 < ROLLING_WINDOW || invalidScores > 0 || rollingDarts === 0
          ? null
          : (3 * rollingPoints) / rollingDarts,
      won: record.won === true ? true : record.won === false ? false : null,
      matchId: record.matchId ?? null,
    });
  }

  return rows;
}

function opponentKey(opponent) {
  return textKey(opponent.id);
}

function opponentCaution(opponent, baseline) {
  const cautions = [];
  if (
    opponent.legs < MIN_COMPARISON_LEGS ||
    baseline.legs < MIN_COMPARISON_LEGS
  ) {
    cautions.push(
      `fewer than ${MIN_COMPARISON_LEGS} legs in one side of the comparison`,
    );
  }
  if (
    opponent.checkoutAttempts === null ||
    baseline.checkoutAttempts === null
  ) {
    cautions.push("checkout attempts are unavailable for one side");
  } else if (
    opponent.checkoutAttempts < MIN_CHECKOUT_ATTEMPTS ||
    baseline.checkoutAttempts < MIN_CHECKOUT_ATTEMPTS
  ) {
    cautions.push(
      `fewer than ${MIN_CHECKOUT_ATTEMPTS} checkout attempts in one side of the comparison`,
    );
  }
  return cautions.length === 0 ? null : `Use caution: ${cautions.join("; ")}.`;
}

function opponentVerdict(averageDelta, checkoutDelta) {
  const scoringHigher =
    averageDelta !== null && averageDelta >= SCORE_CHANGE_THRESHOLD;
  const scoringLower =
    averageDelta !== null && averageDelta <= -SCORE_CHANGE_THRESHOLD;
  const checkoutHigher =
    checkoutDelta !== null && checkoutDelta >= CHECKOUT_CHANGE_THRESHOLD;
  const checkoutLower =
    checkoutDelta !== null && checkoutDelta <= -CHECKOUT_CHANGE_THRESHOLD;

  if (scoringHigher && checkoutLower)
    return "Scoring is higher and checkout rate is lower than the other-opponent baseline.";
  if (scoringLower && checkoutHigher)
    return "Scoring is lower and checkout rate is higher than the other-opponent baseline.";
  if (scoringHigher)
    return "Scoring is higher than the other-opponent baseline.";
  if (scoringLower) return "Scoring is lower than the other-opponent baseline.";
  if (checkoutHigher)
    return "Checkout rate is higher than the other-opponent baseline.";
  if (checkoutLower)
    return "Checkout rate is lower than the other-opponent baseline.";
  if (averageDelta === null && checkoutDelta === null)
    return "Comparable scoring and checkout data are unavailable.";
  return "Scoring and checkout are similar to the other-opponent baseline.";
}

function buildOpponents(records) {
  const eligible = records.filter(
    (record) =>
      record.opponent &&
      record.opponent.id !== null &&
      record.opponent.id !== undefined,
  );
  const groups = new Map();

  for (const record of eligible) {
    const key = opponentKey(record.opponent);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: record.opponent.id,
        name: record.opponent.name ?? null,
        records: [],
      };
      groups.set(key, group);
    }
    group.records.push(record);
  }

  const ranked = [...groups.values()]
    .map((group) => ({
      ...group,
      matches: distinctMatchCount(group.records),
    }))
    .sort((left, right) => {
      if (right.matches !== left.matches) return right.matches - left.matches;
      if (right.records.length !== left.records.length)
        return right.records.length - left.records.length;
      return compareText(textKey(left.id), textKey(right.id));
    })
    .slice(0, 5);

  return ranked.map((group) => {
    const opponent = summarize(group.records);
    const baselineRecords = eligible.filter(
      (record) =>
        opponentKey(record.opponent) !== opponentKey({ id: group.id }),
    );
    const baselineSummary = summarize(baselineRecords);
    const baseline = {
      legs: baselineRecords.length,
      average: baselineSummary.average,
      checkoutRate: baselineSummary.checkoutRate,
      checkoutHits: baselineSummary.checkoutHits,
      checkoutAttempts: baselineSummary.checkoutAttempts,
    };
    const averageDelta =
      opponent.average === null || baseline.average === null
        ? null
        : opponent.average - baseline.average;
    const checkoutDelta =
      opponent.checkoutRate === null || baseline.checkoutRate === null
        ? null
        : opponent.checkoutRate - baseline.checkoutRate;

    return {
      id: group.id,
      name: group.name,
      legs: group.records.length,
      matches: group.matches,
      wins: opponent.wins,
      losses:
        opponent.wins === null
          ? null
          : group.records.filter((record) => record.won === false).length,
      average: opponent.average,
      checkoutRate: opponent.checkoutRate,
      checkoutHits: opponent.checkoutHits,
      checkoutAttempts: opponent.checkoutAttempts,
      baseline,
      averageDelta,
      checkoutDelta,
      verdict: opponentVerdict(averageDelta, checkoutDelta),
      caution: opponentCaution(
        {
          legs: group.records.length,
          checkoutAttempts: opponent.checkoutAttempts,
        },
        baseline,
      ),
    };
  });
}

function buildFormats(records) {
  const counts = new Map();
  for (const record of records) {
    if (typeof record.format !== "string" || record.format.length === 0)
      continue;
    counts.set(record.format, (counts.get(record.format) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || compareText(left.name, right.name),
    );
}

function dateRange(records) {
  if (records.length === 0) return { start: null, end: null };
  let start = null;
  let end = null;
  for (const record of records) {
    const date = dateValue(record);
    if (date === null) continue;
    if (end === null) end = date;
    start = date;
  }
  return { start, end };
}

function frequency180(records) {
  let count = 0;
  let visits = 0;
  let visitLegs = 0;
  for (const record of records) {
    const hits = record.highVisits?.total180;
    if (
      !isNonNegativeNumber(hits) ||
      !isNonNegativeNumber(record.visits) ||
      hits > record.visits
    ) continue;
    count += hits;
    visits += record.visits;
    visitLegs += 1;
  }
  return {
    count180: visitLegs ? count : null,
    recordedVisits: visitLegs ? visits : null,
    frequency180: visits > 0 ? (100 * count) / visits : null,
    visitLegs,
  };
}

function buildLegGroups(records) {
  const groups = [];
  for (let offset = 0; offset < records.length; offset += 10) {
    const legs = records.slice(offset, offset + 10);
    groups.push({
      from: offset + 1,
      to: offset + legs.length,
      n: legs.length,
      ...dateRange(legs),
      ...frequency180(legs),
      average: weightedAverage(legs, "points", "darts"),
      first9Average: weightedAverage(legs, "first9Points", "first9Darts"),
      checkoutRate: pooledRate(legs, "checkoutHits", "checkoutAttempts").rate,
      darts: sumKnown(legs, "darts"),
    });
  }
  return groups;
}

function requestedLimit(limit) {
  const numeric = Number(limit);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : DEFAULT_LIMIT;
}

/**
 * Produces deterministic recent-leg insights from normalized completed X01 legs.
 * Input ordering and duplicate game records are normalized before windowing.
 */
export function analyzeLegs(legs, limit = DEFAULT_LIMIT) {
  const requested = requestedLimit(limit);
  const records = sortAndDeduplicate(legs);
  const currentRecords = records.slice(0, requested);
  const previousRecords = records.slice(requested, requested * 2);
  const chronologicalCurrent = currentRecords.slice().reverse();
  const olderCount = Math.floor(chronologicalCurrent.length / 2);
  const olderRecords = chronologicalCurrent.slice(0, olderCount);
  const newerRecords = chronologicalCurrent.slice(olderCount);
  const currentRange = dateRange(currentRecords);
  const previousRange = dateRange(previousRecords);
  const current = summarize(currentRecords);
  const previous = summarize(previousRecords);
  const older = summarize(olderRecords);
  const newer = summarize(newerRecords);

  return {
    window: {
      requested,
      currentCount: currentRecords.length,
      previousCount: previousRecords.length,
      start: currentRange.start,
      end: currentRange.end,
      previousStart: previousRange.start,
      previousEnd: previousRange.end,
      matchCount: distinctMatchCount(currentRecords),
    },
    current,
    previous,
    halves: { older, newer },
    signals: buildSignals(current, previous),
    groups: buildLegGroups(currentRecords),
    rolling: rollingRows(currentRecords),
    opponents: buildOpponents(currentRecords),
    formats: buildFormats(currentRecords),
  };
}
