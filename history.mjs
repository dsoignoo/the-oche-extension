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
const PAGE_SIZE = 50;
const DETAIL_CONCURRENCY = 4;
const MAX_CACHED_MATCHES = 500;
const finite = (value) => Number.isFinite(value) && value >= 0;
const optional = (value) => (finite(value) ? value : null);
const newestFirst = (a, b) =>
  b.finishedAt.localeCompare(a.finishedAt) || b.gameId.localeCompare(a.gameId);

// Throw segment shapes differ between API revisions. Derive the scored value
// and the double/bull nature from whichever fields are present, and treat a
// dart as unusable rather than guessing its value.
function dartInfo(thrw) {
  const segment = thrw?.segment;
  if (!segment || typeof segment !== "object") return null;
  const name = typeof segment.name === "string" ? segment.name : null;
  const number = Number.isFinite(segment.number) ? segment.number : null;
  const multiplier = Number.isFinite(segment.multiplier)
    ? segment.multiplier
    : null;
  let value = null;
  if (number !== null && multiplier !== null) value = number * multiplier;
  else if (name === "None" || name === "Miss") value = 0;
  else if (name === "Bull") value = 50;
  else if (name === "25") value = 25;
  else if (name !== null) {
    const parsed = /^([SDT])(\d{1,2})$/.exec(name);
    if (parsed) value = Number(parsed[2]) * { S: 1, D: 2, T: 3 }[parsed[1]];
  }
  if (value === null) return null;
  const isBull =
    value === 50 && (name === "Bull" || (number === 25 && multiplier === 2));
  const isDouble =
    isBull ||
    multiplier === 2 ||
    segment.bed === "Double" ||
    (name !== null && name.startsWith("D"));
  const isSingle = multiplier === 1 || name === "25" || (name !== null && /^S\d{1,2}$/.test(name));
  return { value, isDouble, isBull, isSingle, name };
}

// Replays the player's own visits dart by dart. A double chance is an exact
// finish opportunity: any dart starting on an even remainder of 2..40 or on
// 50, regardless of what the player aimed at. Only the legal winning double
// or bull counts as a hit. Double-in legs score nothing before the opening
// double. Simulation stops at a bust or the winning dart; each later visit
// restarts from the recorded turn score, so one inconsistent visit does not
// corrupt the rest. Unsupported or unknown throw data yields null instead of
// invented zeros.
//
// Finishing route data reuses the same replay. transitions pool identical
// (from, to, bust) outcomes of own darts starting on a remainder of 2..60
// after opening (to 0 for a legal checkout, to null with bust for a bust).
// Per-target counters record inside singles (the single of the available
// double, or the 25 inside bull), those leaving an odd remainder, the setup
// darts an odd inside single forces until the remainder is finishable again
// or a bust clears the debt, and full-visit samples (visits, visitCheckouts,
// bustVisits, oddLeaves) for completed own visits starting already open on a
// finishable double or bull. A visit sample needs three recorded darts, a
// legal checkout, or a bust; partial recorded visits still contribute darts
// to transitions but never to the visit counters.
function simulateThrows(turns, settings, won) {
  let checkout = null;
  if (won && turns.length) {
    const finalTurn = turns[turns.length - 1];
    if (
      finalTurn.busted !== true &&
      finalTurn.score === 0 &&
      finite(finalTurn.points) &&
      finalTurn.points > 0
    ) {
      const throws = Array.isArray(finalTurn.throws) ? finalTurn.throws : [];
      const names = throws.map((thrw) => thrw?.segment?.name);
      checkout = {
        score: finalTurn.points,
        targets:
          throws.length > 0 &&
          names.every((name) => typeof name === "string" && name.length > 0)
            ? names.join(" ")
            : null,
      };
    }
  }
  if (
    settings.outMode !== "Double" ||
    !["Straight", "Double"].includes(settings.inMode) ||
    !finite(settings.baseScore) ||
    settings.baseScore <= 1 ||
    turns.length === 0
  ) return { doubleChances: null, checkout, finishing: null };
  const targetAt = (start) =>
    start === 50
      ? "bull"
      : start % 2 === 0 && start >= 2 && start <= 40
        ? `d${start / 2}`
        : null;
  const chances = Object.fromEntries(
    DOUBLE_TARGETS.map((target) => [target, { hits: 0, total: 0 }]),
  );
  const transitions = new Map();
  const targets = Object.fromEntries(
    DOUBLE_TARGETS.map((target) => [
      target,
      {
        insideSingles: 0,
        oddInsideSingles: 0,
        setupDarts: 0,
        visits: 0,
        visitCheckouts: 0,
        bustVisits: 0,
        oddLeaves: 0,
      },
    ]),
  );
  let remaining = settings.baseScore;
  let opened = settings.inMode !== "Double";
  let ended = false;
  let usable = true;
  let routeUsable = true;
  // Target whose inside single left the current odd remainder. Its setup
  // darts keep accruing across own visits until the remainder is even again
  // or a bust clears the debt; a leg that ends first adds no imagined darts.
  let setupTarget = null;
  for (let index = 0; index < turns.length && !ended; index++) {
    const turn = turns[index];
    if (!Array.isArray(turn.throws)) {
      usable = false;
      break;
    }
    const visitOpened = opened;
    const visitStart = remaining;
    const visitKey = visitOpened ? targetAt(remaining) : null;
    let visitCheckout = false;
    let visitBust = false;
    for (const thrw of turn.throws) {
      const dart = dartInfo(thrw);
      if (!dart) {
        usable = false;
        break;
      }
      const start = remaining;
      const wasOpen = opened;
      // Before the opening double only doubles count at all; an exact double
      // still opens and finishes in one dart, so the chance is real.
      const counts = opened || dart.isDouble;
      const key = targetAt(start);
      const hit =
        counts &&
        dart.value === start &&
        (start === 50 ? dart.isBull : dart.isDouble);
      if (key) {
        chances[key].total += 1;
        if (hit) chances[key].hits += 1;
      }
      if (!counts) continue;
      opened = true;
      remaining = start - dart.value;
      const bust = !hit && remaining <= 1;
      if (wasOpen) {
        // Route transitions only cover the post-opening finish window; the
        // opening dart itself and unopened throws are not route samples.
        if (start >= 2 && start <= 60) {
          const to = hit ? 0 : bust ? null : remaining;
          const id = `${start}|${to}|${bust}`;
          const entry = transitions.get(id);
          if (entry) entry.count += 1;
          else transitions.set(id, { from: start, to, bust, count: 1 });
        }
        const target = key;
        const insideSingle =
          target !== null &&
          !dart.isDouble &&
          dart.isSingle &&
          !dart.isBull &&
          dart.value === (target === "bull" ? 25 : start / 2);
        if (setupTarget) targets[setupTarget].setupDarts += 1;
        if (insideSingle) {
          targets[target].insideSingles += 1;
          if (remaining % 2 === 1 && remaining > 1) {
            targets[target].oddInsideSingles += 1;
            setupTarget = target;
          }
        }
        if (bust || (setupTarget && remaining % 2 === 0)) setupTarget = null;
      }
      if (hit) {
        visitCheckout = true;
        ended = true;
        break;
      }
      if (bust) {
        visitBust = true;
        break; // Bust: 0 without a double, 1, or negative.
      }
    }
    if (usable) {
      const expectedEnd = visitBust ? visitStart : remaining;
      if (!finite(turn.score) || turn.score !== expectedEnd ||
          (typeof turn.busted === "boolean" && turn.busted !== visitBust))
        routeUsable = false;
    }
    if (usable && visitKey !== null) {
      const qualified = visitCheckout || visitBust || turn.throws.length >= 3;
      if (qualified) {
        const stats = targets[visitKey];
        stats.visits += 1;
        if (visitCheckout) stats.visitCheckouts += 1;
        else if (visitBust) stats.bustVisits += 1;
        else if (remaining % 2 === 1 && remaining > 1) stats.oddLeaves += 1;
      }
    }
    if (!usable || ended) break;
    if (index < turns.length - 1) {
      if (!finite(turn.score)) {
        usable = false;
        break;
      }
      remaining = turn.score;
      // A bust already cleared the setup debt; if an inconsistent recorded
      // restart score breaks the odd-remainder invariant, drop the debt
      // rather than attribute darts to a target that did not produce them.
      if (setupTarget && (remaining % 2 === 0 || remaining <= 1))
        setupTarget = null;
    }
  }
  const finishing = usable && routeUsable
    ? {
        transitions: [...transitions.values()].sort(
          (a, b) => a.from - b.from || (a.to ?? -1) - (b.to ?? -1),
        ),
        targets,
      }
    : null;
  return { doubleChances: usable ? chances : null, checkout, finishing };
}

// Game winner indices and player ordering differ between API representations.
// Join using stable game/player IDs, never an array index or a display name.
export function normalizeMatch(match, userId) {
  if (
    !Array.isArray(match.players) ||
    !Array.isArray(match.games) ||
    !Array.isArray(match.legStats)
  ) {
    throw new Error(
      "Autodarts match history has an unsupported response shape.",
    );
  }
  const self = match.players.find((player) => player.userId === userId);
  if (!self || match.variant !== "X01")
    return { legs: [], skippedLegs: 0, skippedMatches: 1 };
  const statsByGame = new Map();
  const participants = new Map();
  for (const leg of match.legStats) {
    for (const stats of leg.stats || []) {
      if (stats.playerId === self.id) statsByGame.set(stats.gameId, stats);
      if (!participants.has(stats.gameId))
        participants.set(stats.gameId, new Set());
      participants.get(stats.gameId).add(stats.playerId);
    }
  }
  const legs = [];
  let skippedLegs = 0;
  for (const game of match.games) {
    if (game.variant !== "X01") continue;
    const stats = statsByGame.get(game.id);
    if (!stats) {
      // A player can join only some legs. Do not count legs they never played.
      if ((game.turns || []).some((turn) => turn.playerId === self.id))
        skippedLegs++;
      continue;
    }
    if (
      !game.finishedAt ||
      !Number.isFinite(Date.parse(game.finishedAt)) ||
      !game.winnerPlayerId ||
      game.winnerPlayerId === "00000000-0000-0000-0000-000000000000" ||
      !finite(stats.score) ||
      !finite(stats.dartsThrown) ||
      stats.dartsThrown === 0
    ) {
      skippedLegs++;
      continue;
    }
    const played = participants.get(game.id);
    const other =
      played?.size === 2
        ? match.players.find(
            (player) =>
              player.id !== self.id &&
              played.has(player.id) &&
              player.userId &&
              player.userId !== userId &&
              player.cpuPPR == null,
          )
        : null;
    const settings = game.settings || match.settings || {};
    const turns = Array.isArray(game.turns)
      ? game.turns
          .filter((turn) => turn.playerId === self.id && turn.finishedAt)
          .sort((a, b) => a.turn - b.turn)
      : null;
    let remaining = settings.baseScore;
    let scoringVisits = turns ? 0 : null;
    let lowScoringVisits = turns ? 0 : null;
    let busts = turns ? 0 : null;
    for (const turn of turns || []) {
      if (turn.busted) busts++;
      const points = turn.busted ? 0 : turn.points;
      if (remaining > 170 && turn.throws?.length === 3 && finite(points)) {
        scoringVisits++;
        if (points < 30) lowScoringVisits++;
      }
      remaining = turn.score;
    }
    const validVisits = VISIT_FIELDS.every((key) => finite(stats[key]));
    const won = game.winnerPlayerId === self.id;
    const { doubleChances, checkout, finishing } = turns
      ? simulateThrows(turns, settings, won)
      : { doubleChances: null, checkout: null, finishing: null };
    legs.push({
      gameId: game.id,
      matchId: match.id,
      finishedAt: game.finishedAt,
      startedAt:
        typeof game.createdAt === "string" &&
        Number.isFinite(Date.parse(game.createdAt))
          ? game.createdAt
          : null,
      set: game.set,
      leg: game.leg,
      format: `${settings.baseScore ?? "Unknown score"} · ${settings.inMode ?? "Unknown"} in / ${settings.outMode ?? "Unknown"} out`,
      matchType: match.type,
      won,
      opponent: other ? { id: other.userId, name: other.name } : null,
      darts: stats.dartsThrown,
      points: stats.score,
      first9Points: optional(stats.first9Score),
      first9Darts: finite(stats.first9Score)
        ? Math.min(9, stats.dartsThrown)
        : null,
      scoringPoints: optional(stats.scoreUntil170),
      scoringDarts: optional(stats.dartsUntil170),
      checkoutHits: optional(stats.checkoutsHit),
      checkoutAttempts: optional(stats.checkouts),
      visits: validVisits
        ? VISIT_FIELDS.reduce((sum, key) => sum + stats[key], 0)
        : null,
      tons: validVisits
        ? VISIT_FIELDS.slice(2).reduce((sum, key) => sum + stats[key], 0)
        : null,
      busts,
      scoringVisits,
      lowScoringVisits,
      highVisits: validVisits
        ? Object.fromEntries(VISIT_FIELDS.map((key) => [key, stats[key]]))
        : null,
      doubleOut: settings.outMode === "Double",
      doubleChances,
      checkout,
      finishing,
    });
  }
  return { legs, skippedLegs, skippedMatches: 0 };
}

export function createHistoryReader(fetchJson, historyStore) {
  // Completed summaries persist per account and completion fingerprint.
  // The bounded memory layer also deduplicates concurrent detail downloads.
  const matches = new Map();
  const pending = new Map();
  const ttl = 5 * 60_000;

  function pruneCache() {
    const now = Date.now();
    for (const [key, value] of matches)
      if (value.expires <= now) matches.delete(key);
    // Bound memory even when multiple local accounts/windows are used or a
    // date-range scan touches many matches. Evicting an idle entry only costs
    // a refetch; in-flight results are held by their own promises.
    while (matches.size > MAX_CACHED_MATCHES)
      matches.delete(matches.keys().next().value);
  }

  async function matchLegs(match, userId, token, generation) {
    const key = `${userId}:${match.id}`;
    const cached = matches.get(key);
    if (cached && cached.generation === generation &&
        cached.finishedAt === match.finishedAt && cached.expires > Date.now())
      return cached.value;
    const promise = (async () => {
      const saved = generation === historyStore.generation
        ? await historyStore.get(userId, match.id, match.finishedAt)
        : null;
      if (saved) return saved;
      const detail = await fetchJson(
        `/as/v0/matches/${encodeURIComponent(match.id)}/stats`, token,
      );
      const value = normalizeMatch(detail, userId);
      await historyStore.put(userId, match.id, match.finishedAt, value, generation);
      return value;
    })();
    matches.set(key, {
      expires: Date.now() + ttl, finishedAt: match.finishedAt, generation, value: promise,
    });
    try {
      return await promise;
    } catch (error) {
      if (matches.get(key)?.value === promise) matches.delete(key);
      throw error;
    }
  }

  async function listPage(token, page) {
    const response = await fetchJson(
      `/as/v0/matches/filter?size=${PAGE_SIZE}&page=${page}&sort=-finished_at`,
      token,
    );
    if (!Array.isArray(response.items))
      throw new Error(
        "Autodarts match listing has an unsupported response shape.",
      );
    return response;
  }

  function markSeen(response, seenMatches) {
    const unseen = response.items.filter((match) => !seenMatches.has(match.id));
    if (!unseen.length)
      throw new Error("Autodarts match pagination did not advance.");
    for (const match of unseen) seenMatches.add(match.id);
    return unseen;
  }

  async function fetchDetails(eligible, userId, token, generation, onResult) {
    for (let offset = 0; offset < eligible.length; offset += DETAIL_CONCURRENCY) {
      const batch = await Promise.all(
        eligible
          .slice(offset, offset + DETAIL_CONCURRENCY)
          .map((match) => matchLegs(match, userId, token, generation)),
      );
      for (const result of batch) onResult(result);
    }
  }

  async function collectRecent(userId, token, limit, generation) {
    pruneCache();
    const target = limit * 2;
    const games = new Map();
    const seenMatches = new Set();
    let skippedLegs = 0;
    let skippedMatches = 0;
    let historyExhausted = false;
    let page = 0;
    while (true) {
      const response = await listPage(token, page);
      if (!response.items.length) {
        historyExhausted = true;
        break;
      }
      const unseen = markSeen(response, seenMatches);
      const eligible = unseen.filter((match) => match.variant === "X01");
      await fetchDetails(eligible, userId, token, generation, (result) => {
        skippedLegs += result.skippedLegs;
        skippedMatches += result.skippedMatches;
        for (const leg of result.legs) games.set(leg.gameId, leg);
      });
      pruneCache();
      historyExhausted = response.last === true;
      const ordered = [...games.values()].sort(newestFirst);
      // Match completion order is not necessarily leg completion order: a long
      // match can overlap shorter matches. Read until unseen matches cannot
      // contain legs newer than the requested cutoff.
      const oldestMatch = response.items.at(-1).finishedAt;
      if (
        historyExhausted ||
        (ordered.length >= target &&
          oldestMatch &&
          oldestMatch <= ordered[target - 1].finishedAt)
      )
        break;
      page++;
    }
    return {
      legs: [...games.values()].sort(newestFirst).slice(0, target),
      coverage: { historyExhausted, skippedLegs, skippedMatches },
    };
  }

  // A date-only boundary covers the whole UTC day; a boundary with a time is
  // an exact instant. Both ends are inclusive.
  function rangeBound(value, endOfDay) {
    if (typeof value !== "string") return null;
    const text = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
      : value;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function collectRange(userId, token, start, end, generation) {
    const startBound = rangeBound(start, false);
    const endBound = rangeBound(end, true);
    if (startBound === null || endBound === null || startBound > endBound)
      throw new Error("Autodarts history date range is invalid.");
    pruneCache();
    const games = new Map();
    const seenMatches = new Set();
    let skippedLegs = 0;
    let skippedMatches = 0;
    let historyExhausted = false;
    let page = 0;
    while (true) {
      const response = await listPage(token, page);
      if (!response.items.length) {
        historyExhausted = true;
        break;
      }
      const unseen = markSeen(response, seenMatches);
      const eligible = unseen.filter((match) => {
        if (match.variant !== "X01") return false;
        const finished = Date.parse(match.finishedAt);
        if (Number.isFinite(finished) && finished < startBound) return false;
        // A match created after the range end cannot contain in-range legs,
        // but a long match created earlier may overlap the range: keep it.
        const created = Date.parse(match.createdAt);
        return !(Number.isFinite(created) && created > endBound);
      });
      await fetchDetails(eligible, userId, token, generation, (result) => {
        skippedLegs += result.skippedLegs;
        skippedMatches += result.skippedMatches;
        for (const leg of result.legs) {
          const completed = Date.parse(leg.finishedAt);
          if (completed >= startBound && completed <= endBound)
            games.set(leg.gameId, leg);
        }
      });
      // Large scans can touch hundreds of matches; keep the cache bounded.
      pruneCache();
      historyExhausted = response.last === true;
      // Listings are newest finished first. Once every listed completion on a
      // page is older than the range start, no unseen match can contain an
      // in-range leg, because legs never outlive their match.
      const allOlder = response.items.every((item) => {
        const finished = Date.parse(item.finishedAt);
        return Number.isFinite(finished) && finished < startBound;
      });
      if (historyExhausted || allOlder) break;
      page++;
    }
    return {
      legs: [...games.values()].sort(newestFirst),
      coverage: { historyExhausted, skippedLegs, skippedMatches },
    };
  }

  return function readHistory(userId, token, selector) {
    const generation = historyStore.generation;
    const range = selector !== null && typeof selector === "object";
    const key = range
      ? `${userId}:range:${selector.start}:${selector.end}:${generation}`
      : `${userId}:${selector}:${generation}`;
    if (!pending.has(key)) {
      pending.set(
        key,
        (range
          ? collectRange(userId, token, selector.start, selector.end, generation)
          : collectRecent(userId, token, selector, generation)
        ).finally(() => pending.delete(key)),
      );
    }
    return pending.get(key);
  };
}
