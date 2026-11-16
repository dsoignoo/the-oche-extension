import { requestStats } from "./api.js";

const $ = (selector) => document.querySelector(selector);

const number = (value, digits = 1) =>
  Number.isFinite(value)
    ? value.toLocaleString("en-GB", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "—";
const pct = (value, digits = 1) =>
  Number.isFinite(value) ? `${number(value * 100, digits)}%` : "—";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const date = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "an unknown date"
    : parsed.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
};
const signed = (value, digits = 1, suffix = "") =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${number(value, digits)}${suffix}`
    : "—";

let controller;
let requestId = 0;
let cached;
let chart;
let chartRenderId = 0;
let requestedLimit;

function destroyChart() {
  chartRenderId += 1;
  chart?.destroy();
  chart = undefined;
}

function setStatus(text) {
  $("#insights-status").textContent = text;
}

function showLoading(limit) {
  destroyChart();
  $("#insights-error").hidden = true;
  $("#insights-caption").textContent =
    `Preparing an evidence-backed view of your latest ${number(limit, 0)} completed legs.`;
  $("#insights-content").innerHTML =
    '<div class="insights-loading">Looking at your recent completed X01 legs…</div>';
  setStatus("Loading recent form");
}

function metricDelta(current, previous) {
  if (!Number.isFinite(current))
    return "<span>Not available in this window</span>";
  if (!Number.isFinite(previous))
    return "<span>No equally sized prior window</span>";
  const difference = current - previous;
  const direction =
    difference > 0 ? "positive" : difference < 0 ? "negative" : "neutral";
  const label =
    difference > 0
      ? `↗ ${signed(difference)}`
      : difference < 0
        ? `↘ ${signed(difference)}`
        : "Unchanged";
  return `<span class="insight-delta ${direction}">${label}</span><span>vs prior ${number(previous)}</span>`;
}

function percentileCard(label, value, previous, explanation) {
  return `<article class="insight-metric"><span>${label}</span><strong>${number(value)}</strong><p>${escape(explanation)}</p><div>${metricDelta(value, previous)}</div></article>`;
}

function momentum(current) {
  const older = current?.older || {};
  const newer = current?.newer || {};
  const difference =
    Number.isFinite(newer.average) && Number.isFinite(older.average)
      ? newer.average - older.average
      : null;
  const description = Number.isFinite(difference)
    ? `${difference > 0 ? "Later" : difference < 0 ? "Earlier" : "Both"} half ${
        difference === 0 ? "matched" : "was higher"
      } by ${number(Math.abs(difference))} points.`
    : "A half-window average is unavailable.";
  return `<article class="insight-momentum"><div><span class="eyebrow">CHRONOLOGICAL MOMENTUM</span><h3>First half to latest half</h3><p>${escape(description)} This is a descriptive comparison, not a forecast.</p></div><div class="momentum-values"><strong>${number(newer.average)}</strong><span>latest ${number(newer.n, 0)} legs</span><small>vs ${number(older.average)} · first ${number(older.n, 0)} legs</small></div></article>`;
}

function renderSignals(signals) {
  if (!signals?.length)
    return '<div class="insights-empty">No extra coaching signal is shown until there is enough recent evidence for a clear comparison.</div>';
  return signals
    .slice(0, 4)
    .map((signal) => {
      const kind = ["improving", "strength", "focus", "context"].includes(
        signal.kind,
      )
        ? signal.kind
        : "context";
      return `<article class="signal-card signal-${kind}"><span>${escape(
        kind,
      )}</span><h3>${escape(signal.title)}</h3><p>${escape(signal.detail)}</p></article>`;
    })
    .join("");
}

function scoreComparison(opponent) {
  if (!Number.isFinite(opponent.average)) return "Average unavailable";
  if (!Number.isFinite(opponent.averageDelta))
    return `${number(opponent.average)} <small>Everyone-else baseline unavailable</small>`;
  const baseline = Number.isFinite(opponent.baseline?.average)
    ? ` (${number(opponent.baseline.average)})`
    : "";
  return `${number(opponent.average)} <small>${signed(opponent.averageDelta)} vs everyone else${baseline ? `; baseline${baseline}` : ""}</small>`;
}

function checkoutComparison(opponent) {
  if (!Number.isFinite(opponent.checkoutRate))
    return "No recorded checkout attempts";
  const sample = `<small>${number(opponent.checkoutHits, 0)} / ${number(opponent.checkoutAttempts, 0)} checkout darts</small>`;
  if (!Number.isFinite(opponent.checkoutDelta))
    return `${pct(opponent.checkoutRate)}${sample}<small>Everyone-else baseline unavailable</small>`;
  return `${pct(opponent.checkoutRate)}${sample}<small>${signed(opponent.checkoutDelta * 100, 1, " pp")} vs everyone else (${pct(opponent.baseline.checkoutRate)} across ${number(opponent.baseline.checkoutAttempts, 0)} checkout darts)</small>`;
}
function renderOpponents(opponents) {
  if (!opponents?.length)
    return '<div class="insights-empty">No eligible heads-up human opponents appear in this recent window.</div>';
  return `<div class="table-scroll insights-table-scroll"><table class="opponents-table"><caption class="sr-only">Top human opponents in the recent leg window, including leg results and comparisons with all other eligible opponents.</caption><thead><tr><th>Opponent</th><th>Leg result</th><th>Scoring</th><th>Checkout</th><th>Read</th></tr></thead><tbody>${opponents
    .slice(0, 5)
    .map(
      (opponent) =>
        `<tr><td><strong>${escape(opponent.name || "Unknown opponent")}</strong><small>${number(opponent.legs, 0)} legs · ${number(opponent.matches, 0)} matches</small></td><td><strong>${number(opponent.wins, 0)}–${number(opponent.losses, 0)}</strong><small>leg W–L</small></td><td>${scoreComparison(opponent)}</td><td>${checkoutComparison(opponent)}</td><td><p>${escape(opponent.verdict || "No clear comparison yet.")}</p>${opponent.caution ? `<small>${escape(opponent.caution)}</small>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderChart(rolling) {
  const rows = Array.isArray(rolling) ? rolling : [];
  const renderId = chartRenderId;
  const tableRows = rows.length
    ? rows
        .map(
          (leg) =>
            `<tr><td>${number(leg.index, 0)}</td><td>${escape(date(leg.date))}</td><td>${number(
              leg.average,
              2,
            )}</td><td>${number(leg.rollingAverage, 2)}</td><td>${leg.won === true ? "Won" : leg.won === false ? "Lost" : "—"}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty-cell">No completed leg averages are available in this window.</td></tr>';
  const chartMarkup = `<article class="panel insights-chart-panel"><div class="panel-heading"><div><p class="eyebrow">LEG-BY-LEG RHYTHM</p><h3>Per-leg scoring and trailing 25</h3><p>Each point is a completed leg’s three-dart average. The line begins only once 25 legs are available.</p></div></div><div class="chart-wrap insights-chart-wrap"><canvas id="insights-chart" role="img" aria-label="Per-leg three-dart averages and dart-weighted trailing 25-leg averages. Exact values are available in the table below."></canvas></div><details class="chart-data"><summary>View exact chart values</summary><div class="table-scroll"><table><caption class="sr-only">Recent leg scoring and trailing 25-leg average</caption><thead><tr><th>Leg</th><th>Completed</th><th>Leg average</th><th>Trailing 25</th><th>Result</th></tr></thead><tbody>${tableRows}</tbody></table></div></details></article>`;
  requestAnimationFrame(() => {
    if (renderId !== chartRenderId || !rows.length || !window.Chart) return;
    const canvas = $("#insights-chart");
    if (!canvas) return;
    chart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels: rows.map((leg) => `Leg ${leg.index}`),
        datasets: [
          {
            label: "Per-leg average",
            data: rows.map((leg) => leg.average),
            borderColor: "#a8b9a2",
            backgroundColor: "#a8b9a2",
            borderWidth: 1.5,
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.2,
          },
          {
            label: "Trailing 25-leg average",
            data: rows.map((leg) => leg.rollingAverage),
            borderColor: "#527d57",
            backgroundColor: "#527d57",
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            spanGaps: false,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: { boxWidth: 9, color: "#667466", font: { size: 10 } },
          },
          tooltip: {
            backgroundColor: "#20382f",
            padding: 12,
            callbacks: {
              title: (items) => {
                const row = rows[items[0]?.dataIndex];
                return row ? `Leg ${row.index} · ${date(row.date)}` : "";
              },
              label: (item) =>
                `${item.dataset.label}: ${Number.isFinite(item.raw) ? number(item.raw, 2) : "not available"}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 8, color: "#8a9680", font: { size: 9 } },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { color: "#8a9680", font: { size: 9 } },
            grid: { color: "#edf1e9" },
          },
        },
      },
    });
  });
  return chartMarkup;
}

function windowCaption(payload) {
  const window = payload.window || {};
  const current = payload.current || {};
  const count = Number.isFinite(window.currentCount)
    ? window.currentCount
    : current.n;
  const previousCount = Number.isFinite(window.previousCount)
    ? window.previousCount
    : payload.previous?.n;
  const dates =
    window.start && window.end
      ? `${date(window.start)} – ${date(window.end)}`
      : "recent completed legs";
  const matches = Number.isFinite(window.matchCount)
    ? ` across ${number(window.matchCount, 0)} match${window.matchCount === 1 ? "" : "es"}`
    : "";
  const previous =
    Number.isFinite(previousCount) && previousCount > 0
      ? ` · ${number(previousCount, 0)} prior legs`
      : "";
  return `${number(count, 0)} decided legs${previous}${matches} · ${dates}`;
}

function render(payload) {
  destroyChart();
  const current = payload.current || {};
  const previous = payload.previous || {};
  const window = payload.window || {};
  const coverage = payload.coverage || {};
  const skipped =
    Number(coverage.skippedLegs || 0) + Number(coverage.skippedMatches || 0);
  $("#insights-caption").textContent =
    `${windowCaption(payload)} (UTC). Only legs with a recorded winner; excludes abandoned/undecided legs, so averages can differ from the Autodarts overview. Date-range filters do not affect this view.`;
  setStatus(
    window.currentCount === window.requested &&
      window.previousCount === window.requested
      ? "Recent form ready"
      : "Partial history",
  );
  $("#insights-error").hidden = true;

  const hasLegs = Number(current.n || window.currentCount || 0) > 0;
  if (!hasLegs) {
    $("#insights-content").innerHTML =
      '<div class="insights-empty">No completed X01 legs were available for this recent window. Play or sync more completed legs, then retry.</div>';
    return;
  }

  const spread = Number.isFinite(current.spread)
    ? `P10 to P90 spans ${number(current.spread)} points. A higher floor and median alongside the ceiling is a fuller scoring gain; spread alone is not a verdict.`
    : "The floor-to-ceiling spread is unavailable for this window.";
  const formats = (payload.formats || [])
    .map(
      (format) =>
        `${format.name || "Unknown format"} (${number(format.count, 0)})`,
    )
    .join(" · ");
  const coverageNote = skipped
    ? `${number(skipped, 0)} incomplete or ineligible records were excluded while loading history.`
    : coverage.historyExhausted
      ? "All currently available history was considered."
      : "Recent completed history was considered.";

  $("#insights-content").innerHTML = `
    <div class="insight-metric-grid">
      ${percentileCard("P10 3-dart floor", current.p10, previous.p10, "Lower-end threshold: roughly 1 in 10 legs falls below this.")}
      ${percentileCard("P50 3-dart median", current.p50, previous.p50, "The middle individual-leg average.")}
      ${percentileCard("P90 3-dart ceiling", current.p90, previous.p90, "Upper-end threshold: roughly 1 in 10 legs reaches this.")}
    </div>
    <p class="insight-interpretation">${escape(spread)}</p>
    ${momentum(payload.halves)}
    <div class="signals-heading"><div><p class="eyebrow">EVIDENCE TO USE</p><h3>What the recent window suggests</h3></div><span>Observations, not predictions</span></div>
    <div class="signal-grid">${renderSignals(payload.signals)}</div>
    ${renderChart(payload.rolling)}
    <article class="panel opponents-panel"><div class="panel-heading"><div><p class="eyebrow">WHO YOU MET</p><h3>Top human opponents</h3><p>Ranked by matches played in this leg window. Results are leg W–L; a boundary match may be partial. “Everyone else” excludes the named opponent.</p></div></div>${renderOpponents(payload.opponents)}</article>
    <div class="insights-method"><p><strong>How to read this.</strong> Averages are dart-weighted; checkout rates pool hits and attempts. Percentiles use individual completed legs, wins and losses, with linear interpolation (R7). ${escape(coverageNote)} ${formats ? `Formats in this window: ${escape(formats)}.` : ""} Historical match summaries are cached locally for up to five minutes.</p></div>`;
}

export function invalidateInsights(limit) {
  requestedLimit = Number(limit);
  requestId += 1;
  controller?.abort();
  controller = undefined;
  cached = undefined;
  showLoading(requestedLimit);
}

export async function loadInsights(limit, { force = false } = {}) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return;
  requestedLimit = numericLimit;
  if (!force && cached?.limit === numericLimit) {
    render(cached.payload);
    return cached.payload;
  }

  const id = ++requestId;
  controller?.abort();
  controller = new AbortController();
  showLoading(numericLimit);
  try {
    const payload = await requestStats(
      "insights",
      { limit: String(numericLimit) },
      { signal: controller.signal },
    );
    if (id !== requestId || requestedLimit !== numericLimit) return;
    cached = { limit: numericLimit, payload };
    render(payload);
    return payload;
  } catch (error) {
    if (id !== requestId || error.name === "AbortError") return;
    destroyChart();
    $("#insights-content").innerHTML = "";
    $("#insights-error").hidden = false;
    $("#insights-error-message").textContent =
      error.message || "Could not load recent-leg analysis.";
    $("#insights-caption").textContent =
      "Your dashboard is still available; only recent-leg analysis needs another try.";
    setStatus("Analysis unavailable");
  } finally {
    if (id === requestId) controller = undefined;
  }
}

