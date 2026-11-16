import { createHistoryReader } from "./history.mjs";
import { analyzeLegs } from "./insights.mjs";
import { analyzeHistory } from "./analytics.mjs";

export function parseFilters(params = {}) {
  const limit = String(params.limit ?? "200");
  const start = params.start ?? "2021-01-01";
  const end = params.end ?? new Date().toISOString().slice(0, 10);
  const interval = params.interval ?? "daily";
  const validDate = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (
    !["25", "50", "100", "200", "250", "500"].includes(limit) ||
    !["daily", "weekly", "monthly"].includes(interval) ||
    !validDate(start) || !validDate(end) || start > end
  ) throw new Error("Choose a valid leg window, date range, and interval.");
  return { limit: Number(limit), start, end, interval };
}

export function createStatsReader(upstream) {
  const readHistory = createHistoryReader(upstream);
  return async function readStats(kind, params, token) {
    const filters = parseFilters(params);
    if (kind === "insights") {
      const { legs, coverage } = await readHistory(token.userId, token, filters.limit);
      return {
        ...analyzeLegs(legs, filters.limit),
        coverage,
        fetchedAt: new Date().toISOString(),
      };
    }
    if (kind === "analytics") {
      const { legs, coverage } = await readHistory(token.userId, token, {
        start: filters.start,
        end: filters.end,
      });
      return analyzeHistory(legs, coverage);
    }
    if (kind !== "dashboard") throw new Error("Unsupported statistics request.");
    const [profile, recent] = await Promise.all([
      upstream("/user/v1/profile", token),
      upstream(`/us/v0/profile/stats/x01?limit=${filters.limit}`, token),
    ]);
    return {
      profile: {
        username: profile.username,
        firstName: profile.firstName,
        country: profile.country,
      },
      recent,
      filters,
      fetchedAt: new Date().toISOString(),
    };
  };
}
