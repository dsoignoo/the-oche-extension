const VISIT_FIELDS = [
  "less60",
  "plus60",
  "plus100",
  "plus140",
  "plus170",
  "total180",
];
const finite = (value) => Number.isFinite(value) && value >= 0;
const optional = (value) => (finite(value) ? value : null);
const newestFirst = (a, b) =>
  b.finishedAt.localeCompare(a.finishedAt) || b.gameId.localeCompare(a.gameId);

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
    legs.push({
      gameId: game.id,
      matchId: match.id,
      finishedAt: game.finishedAt,
      set: game.set,
      leg: game.leg,
      format: `${settings.baseScore ?? "Unknown score"} · ${settings.inMode ?? "Unknown"} in / ${settings.outMode ?? "Unknown"} out`,
      matchType: match.type,
      won: game.winnerPlayerId === self.id,
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
    });
  }
  return { legs, skippedLegs, skippedMatches: 0 };
}

export function createHistoryReader(fetchJson) {
  // Only normalized personal leg summaries are cached, scoped by account ID.
  // Short TTL permits corrected archived matches to be picked up on refresh.
  const matches = new Map();
  const pending = new Map();
  const ttl = 5 * 60_000;

  async function matchLegs(matchId, userId, token) {
    const key = `${userId}:${matchId}`;
    const cached = matches.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const promise = fetchJson(
      `/as/v0/matches/${encodeURIComponent(matchId)}/stats`,
      token,
    ).then((match) => normalizeMatch(match, userId));
    matches.set(key, { expires: Date.now() + ttl, value: promise });
    try {
      return await promise;
    } catch (error) {
      if (matches.get(key)?.value === promise) matches.delete(key);
      throw error;
    }
  }

  async function collect(userId, token, limit) {
    for (const [key, value] of matches)
      if (value.expires <= Date.now()) matches.delete(key);
    // Bound memory even when multiple local accounts/windows are used.
    while (matches.size > 500) matches.delete(matches.keys().next().value);
    const target = limit * 2;
    const games = new Map();
    const seenMatches = new Set();
    let skippedLegs = 0;
    let skippedMatches = 0;
    let historyExhausted = false;
    let page = 0;
    while (true) {
      const response = await fetchJson(
        `/as/v0/matches/filter?size=50&page=${page}&sort=-finished_at`,
        token,
      );
      if (!Array.isArray(response.items))
        throw new Error(
          "Autodarts match listing has an unsupported response shape.",
        );
      if (!response.items.length) {
        historyExhausted = true;
        break;
      }
      const unseen = response.items.filter(
        (match) => !seenMatches.has(match.id),
      );
      if (!unseen.length)
        throw new Error("Autodarts match pagination did not advance.");
      for (const match of unseen) seenMatches.add(match.id);
      const eligible = unseen.filter((match) => match.variant === "X01");
      for (let offset = 0; offset < eligible.length; offset += 4) {
        const batch = await Promise.all(
          eligible
            .slice(offset, offset + 4)
            .map((match) => matchLegs(match.id, userId, token)),
        );
        for (const result of batch) {
          skippedLegs += result.skippedLegs;
          skippedMatches += result.skippedMatches;
          for (const leg of result.legs) games.set(leg.gameId, leg);
        }
      }
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

  return function readHistory(userId, token, limit) {
    const key = `${userId}:${limit}`;
    if (!pending.has(key)) {
      pending.set(
        key,
        collect(userId, token, limit).finally(() => pending.delete(key)),
      );
    }
    return pending.get(key);
  };
}
