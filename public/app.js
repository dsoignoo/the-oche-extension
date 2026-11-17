import { invalidateInsights, loadInsights } from "./insights.js";
import { onSessionChanged, requestStats } from "./api.js";
import { estimateRouteEfficiencies, MIN_ROUTE_SAMPLES } from "../finishing.mjs";

const $ = (selector) => document.querySelector(selector);
const number = (value, digits = 0) =>
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
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const shortDate = (value) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const today = () => new Date().toISOString().slice(0, 10);
const query = new URLSearchParams(location.search);
let range = ["all", "30", "90", "custom"].includes(query.get("range"))
  ? query.get("range")
  : "all";
let start = query.get("start") || "2021-01-01";
let end = query.get("end") || today();
let data;
let analysis;
let analysisError = false;
let analysisLoadId = 0;
let trend;
let distribution;
let chartMode = "scoring";
let controller;
let loadId = 0;
let analyticsController;
let analyticsLoadId = 0;
let analyticsError;

$("#range").value = range;
$("#limit").value = ["25", "50", "100", "200", "250", "500"].includes(
  query.get("limit"),
)
  ? query.get("limit")
  : "200";
$("#start").value = start;
$("#end").value = end;
$("#date-form").hidden = range !== "custom";

function applyPreset() {
  if (range === "custom") return;
  end = today();
  const from = new Date(`${end}T00:00:00Z`);
  if (range !== "all") from.setUTCDate(from.getUTCDate() - Number(range) + 1);
  start = range === "all" ? "2021-01-01" : from.toISOString().slice(0, 10);
  $("#start").value = start;
  $("#end").value = end;
  $("#end").setCustomValidity("");
}

function delta(current, previous, suffix = "") {
  if (!Number.isFinite(current) || !Number.isFinite(previous))
    return "<span>No previous window</span>";
  const difference = current - previous;
  return `<span class="delta ${difference < 0 ? "negative" : ""}">${difference > 0 ? "↗ +" : difference < 0 ? "↘ " : ""}${number(difference, 1)}${suffix}</span><span>vs previous ${number(previous, 1)}${suffix === " pp" ? "%" : ""}</span>`;
}

function card(label, value, foot, icon, featured = false) {
  return `<article class="metric-card ${featured ? "featured" : ""}"><div class="metric-label">${label}<span class="metric-icon" aria-hidden="true">${icon}</span></div><strong class="metric-value">${value}</strong><div class="metric-foot">${foot}</div></article>`;
}

function renderRecent() {
  const r = data.recent;
  const hasLegs = r.numLegs > 0;
  const a = hasLegs ? r.average || {} : {};
  const previous = r.numLegsLast > 0 ? r.averageLast || {} : {};
  $("#comparison-caption").textContent =
    `${number(r.numLegs)} recorded legs · previous ${number(r.numLegsLast)} · source aggregates; game plan below excludes undecided legs`;
  $("#recent-cards").innerHTML = [
    card(
      "3-dart average",
      number(a.average, 2),
      delta(a.average, previous.average),
      "↗",
      true,
    ),
    card(
      "First 9 average",
      number(a.first9Average, 2),
      delta(a.first9Average, previous.first9Average),
      "≋",
    ),
    card(
      "Checkout rate",
      pct(a.checkoutPercent),
      delta(a.checkoutPercent * 100, previous.checkoutPercent * 100, " pp"),
      "◎",
    ),
    card(
      "Legs won",
      pct(hasLegs ? r.numLegsWon / r.numLegs : undefined, 0),
      `<span>${number(r.numLegsWon)} won from ${number(r.numLegs)} legs</span>`,
      "⚑",
    ),
  ].join("");
  $("#recent-visits").innerHTML = [
    ["60–99", "plus60"],
    ["100–139", "plus100"],
    ["140–169", "plus140"],
    ["170–179", "plus170"],
    ["180", "total180"],
  ]
    .map(
      ([label, key]) =>
        `<div class="visit-chip"><span>${label}</span><strong>${number(a[key])}</strong></div>`,
    )
    .join("");
}

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "#20382f",
      padding: 12,
      titleFont: { size: 11 },
      bodyFont: { size: 10 },
      displayColors: true,
    },
  },
  scales: {
    x: {
      border: { display: false },
      grid: { display: false },
      ticks: {
        color: "#9aa38e",
        font: { size: 9 },
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 8,
      },
    },
    y: {
      border: { display: false },
      grid: { color: "#f0f3eb", drawTicks: false },
      ticks: {
        color: "#9aa38e",
        font: { size: 9 },
        padding: 12,
        maxTicksLimit: 5,
      },
      beginAtZero: true,
    },
  },
};

function renderTrend() {
  const rows = analysis?.groups || [];
  const is180 = chartMode === "180s";
  const fields =
    chartMode === "scoring"
      ? [
          ["average", "3-dart average"],
          ["first9Average", "First 9 average"],
        ]
      : chartMode === "checkout"
        ? [["checkoutRate", "Checkout rate"]]
        : is180
          ? [["frequency180", "180s per 100 recorded visits"]]
          : [["darts", "Darts thrown"]];
  const isPercent = chartMode === "checkout";
  const value = (n) => (Number.isFinite(n) ? n * (isPercent ? 100 : 1) : null);
  const displayValue = (n, key) =>
    isPercent ? pct(n) : number(n, chartMode === "activity" || (is180 && key !== "frequency180") ? 0 : 2);
  const tableFields = is180
    ? [["count180", "180s"], ["recordedVisits", "Recorded visits"], ["frequency180", "180s / 100 visits"], ["visitLegs", "Coverage (legs)"]]
    : fields;
  const label = (row) =>
    row.from === 1
      ? `Last ${row.n}${row.n < 10 ? " (partial)" : ""}`
      : `Previous ${row.n} · legs ${row.from}–${row.to}${row.n < 10 ? " (partial)" : ""}`;
  const emptyMessage = analysisError
    ? "Could not load leg groups. Retry to reconnect."
    : analysis
      ? "No completed X01 legs available."
      : "Loading completed-leg groups…";
  $("#trend-caption").textContent = rows.length
    ? `${number(analysis.current.n)} completed legs · separate groups of 10 · newest on the left · date range does not apply`
    : emptyMessage;
  $("#trend-retry").hidden = !analysisError;
  $("#chart-legend").innerHTML = fields
    .map(
      ([, title], i) =>
        `<span><i class="legend-dot ${i ? "secondary" : ""}"></i>${title}</span>`,
    )
    .join("");
  $("#trend-chart").setAttribute(
    "aria-label",
    `${fields.map((f) => f[1]).join(" and ")} in non-overlapping groups of 10 completed legs, newest first. Exact values in the chart data table below.`,
  );
  trend?.destroy();
  trend = new Chart($("#trend-chart"), {
    type: "bar",
    data: {
      labels: rows.map((row) =>
        row.from === 1 ? `Last ${row.n}` : `${row.from}–${row.to}`,
      ),
      datasets: fields.map(([key, title], index) => ({
        label: title,
        data: rows.map((row) => value(row[key])),
        backgroundColor: index ? "#a5b9c9" : "#4c8065",
        borderRadius: 3,
      })),
    },
    options: {
      ...chartOptions,
      plugins: {
        ...chartOptions.plugins,
        tooltip: {
          ...chartOptions.plugins.tooltip,
          callbacks: {
            title: (items) =>
              items.length ? label(rows[items[0].dataIndex]) : "",
            afterTitle: (items) => {
              const row = rows[items[0]?.dataIndex];
              return row ? `${date(row.start)} – ${date(row.end)}` : "";
            },
            label: (context) =>
              `${context.dataset.label}: ${number(context.parsed.y, chartMode === "activity" ? 0 : 2)}${isPercent ? "%" : ""}`,
            afterBody: (items) => {
              const row = rows[items[0]?.dataIndex];
              return is180 && row
                ? [
                    `${number(row.count180)} 180s / ${number(row.recordedVisits)} recorded visits`,
                    `Visit data: ${number(row.visitLegs)} / ${number(row.n)} legs`,
                  ]
                : [];
            },
          },
        },
      },
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
          ...(isPercent ? { max: 100 } : {}),
          title: {
            display: is180,
            text: "180s per 100 recorded visits",
            color: "#9aa38e",
            font: { size: 9 },
          },
          ticks: {
            ...chartOptions.scales.y.ticks,
            callback: (n) => `${number(n, is180 ? 2 : 0)}${isPercent ? "%" : ""}`,
          },
        },
      },
    },
  });
  const frequency = is180
    ? rows.reduce((total, row) => ({
        count: total.count + (row.count180 ?? 0),
        visits: total.visits + (row.recordedVisits ?? 0),
        legs: total.legs + row.visitLegs,
      }), { count: 0, visits: 0, legs: 0 })
    : null;
  $("#trend-summary").textContent = !rows.length
    ? emptyMessage
    : chartMode === "scoring"
      ? `Completed-leg average: ${number(analysis.current.average, 2)}`
      : chartMode === "checkout"
        ? `Completed-leg checkout rate: ${pct(analysis.current.checkoutRate)}`
        : is180
          ? frequency.legs
            ? `${number(frequency.count)} 180s / ${number(frequency.visits)} recorded visits · ${number(frequency.visits ? (100 * frequency.count) / frequency.visits : undefined, 2)} per 100 · visit data for ${number(frequency.legs)} of ${number(analysis.current.n)} legs`
            : "180 frequency unavailable: no recorded visit data in this window."
          : `${number(analysis.groups.reduce((sum, row) => sum + (row.darts ?? 0), 0))} darts across ${number(analysis.current.n)} legs`;
  $("#chart-table-head").innerHTML =
    `<tr><th>Leg group (newest first)</th>${tableFields.map(([, title]) => `<th>${title}</th>`).join("")}</tr>`;
  $("#chart-table-body").innerHTML =
    rows
      .map(
        (row) =>
          `<tr><td>${escape(label(row))}</td>${tableFields.map(([key]) => `<td>${key === "visitLegs" ? `${number(row.visitLegs)} / ${number(row.n)}` : displayValue(row[key], key)}</td>`).join("")}</tr>`,
      )
      .join("") ||
    `<tr><td colspan="${tableFields.length + 1}" class="empty-cell">${emptyMessage}</td></tr>`;
}

async function loadRecentAnalysis({ force = false } = {}) {
  const id = ++analysisLoadId;
  analysis = undefined;
  analysisError = false;
  renderTrend();
  const payload = await loadInsights($("#limit").value, { force });
  if (id !== analysisLoadId) return;
  analysis = payload;
  analysisError = !payload;
  renderTrend();
  refreshSavedHistory();
}

function renderActivity() {
  const a = data.analytics;
  $("#darts-count").textContent = number(a.numDarts);
  const hours = Number.isFinite(a.fun?.playtime)
    ? `${number(Math.floor(a.fun.playtime / 3600))}h ${Math.floor((a.fun.playtime % 3600) / 60)}m`
    : "—";
  const activity = [
    ["Legs played", number(a.numLegsPlayed)],
    ["Matches played", number(a.numGames)],
    [
      "Legs won",
      `${number(a.numLegsWon)} <small>${pct(a.numLegsPlayed ? a.numLegsWon / a.numLegsPlayed : undefined, 0)}</small>`,
    ],
    ["Recorded leg time", hours],
    [
      "Distance walked",
      Number.isFinite(a.fun?.walkingDistance)
        ? `${number(a.fun.walkingDistance, 2)} <small>km</small>`
        : "Not recorded",
    ],
  ];
  $("#activity-list").innerHTML = activity
    .map(
      ([label, value]) =>
        `<div class="activity-row"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  const modes = Object.entries(a.gameCounts || {}).sort((a, b) => b[1] - a[1]);
  const mix = $("#game-mix");
  mix.replaceChildren();
  const track = document.createElement("div");
  track.className = "mix-track";
  track.setAttribute("aria-hidden", "true");
  const legend = document.createElement("div");
  legend.className = "mix-legend";
  for (const [name, count] of modes) {
    if (!count) continue;
    const segment = document.createElement("span");
    segment.style.flexGrow = count;
    track.append(segment);
    const label = document.createElement("span");
    label.textContent = `${name} ${number(count)}`;
    legend.append(label);
  }
  mix.append(track, legend);
  $("#activity-scope").textContent =
    `Selected date range. ${number(a.coverage.timedLegs)} of ${number(a.numLegsPlayed)} legs have timing data; recorded leg time includes pauses. Walking distance is not recorded.`;
  const best = a.performanceBest || {};
  const record = (icon, value, label) =>
    `<div class="record"><span class="record-icon" aria-hidden="true">${icon}</span><div><strong>${value}</strong><small>${label} · date range</small></div></div>`;
  $("#records-strip").innerHTML = [
    record(
      "↗",
      number(a.numLegsPlayed ? best.averageBest : undefined, 2),
      "Best leg average",
    ),
    record(
      "◎",
      number(best.numDartsBest > 0 ? best.numDartsBest : undefined),
      "Fewest darts in a win",
    ),
    record(
      "⚑",
      number(best.bestCheckout > 0 ? best.bestCheckout : undefined),
      "Highest checkout",
    ),
    record("✧", number(a.coverage.visitLegs || !a.numLegsPlayed ? a.highVisits?.total180 : undefined), "Recorded 180s"),
  ].join("");
}

function renderDistribution() {
  const counts = data.analytics.highVisits || {};
  const visitLegs = data.analytics.coverage.visitLegs;
  $("#distribution-caption").textContent =
    `Recorded visits · ${number(visitLegs)} of ${number(data.analytics.numLegsPlayed)} completed legs · selected date range`;
  $("#scoring-chart").hidden = visitLegs === 0;
  if (visitLegs === 0) {
    distribution?.destroy();
    distribution = undefined;
    $("#scoring-summary").textContent = "No recorded visit counts are available for this date range.";
    return;
  }
  const groups = [
    ["0–59", "less60"],
    ["60–99", "plus60"],
    ["100–139", "plus100"],
    ["140–169", "plus140"],
    ["170–179", "plus170"],
    ["180", "total180"],
  ];
  distribution?.destroy();
  distribution = new Chart($("#scoring-chart"), {
    type: "bar",
    data: {
      labels: groups.map((g) => g[0]),
      datasets: [
        {
          label: "Visits",
          data: groups.map(([, key]) => counts[key] ?? 0),
          backgroundColor: [
            "#dbe4d4",
            "#b7cba8",
            "#94b57f",
            "#709961",
            "#517c44",
            "#355c30",
          ],
          borderRadius: 4,
          maxBarThickness: 45,
        },
      ],
    },
    options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
          ticks: { ...chartOptions.scales.y.ticks, precision: 0 },
        },
      },
    },
  });
  const total = groups.reduce((sum, [, key]) => sum + (counts[key] || 0), 0);
  const tons = ["plus100", "plus140", "plus170", "total180"].reduce(
    (sum, key) => sum + (counts[key] || 0),
    0,
  );
  $("#scoring-summary").innerHTML =
    `<span><strong>${number(total)}</strong>Total scoring visits</span><span><strong>${number(tons)}</strong>Visits of 100 or more</span><span><strong>${pct(total ? tons / total : undefined)}</strong>100+ visit rate</span>`;
  $("#scoring-chart").setAttribute(
    "aria-label",
    `Scoring visits in selected date range: ${groups.map(([label, key]) => `${label}: ${number(counts[key])}`).join("; ")}.`,
  );
}

function renderDoubles() {
  const checkout = data.analytics.checkoutPerformance;
  const coverage = data.analytics.coverage;
  $("#double-checkout-rate").textContent = pct(checkout.percent);
  $("#double-checkout-counts").textContent =
    `${number(checkout.hits)} / ${number(checkout.attempts)}`;
  $("#double-checkout-coverage").textContent = checkout.recordedLegs > 0
    ? `Calculated locally from recorded leg hits / attempts · ${number(checkout.recordedLegs)} of ${number(checkout.eligibleLegs)} Double-out legs. Does not require individual throw records.`
    : checkout.eligibleLegs > 0
      ? "Overall checkout rate unavailable: checkout hits / attempts are missing from the leg records."
      : "No completed Double-out legs in this date range.";
  const order = [
    "d20",
    "d1",
    "d18",
    "d4",
    "d13",
    "d6",
    "d10",
    "d15",
    "d2",
    "d17",
    "d3",
    "d19",
    "d7",
    "d16",
    "d8",
    "d11",
    "d14",
    "d9",
    "d12",
    "d5",
    "bull",
  ];
  const entries = Object.entries(data.analytics.doublePerformance || {}).filter(
    ([, chance]) => chance.total > 0,
  );
  const sort = $("#double-sort").value;
  $("#double-sort").disabled = entries.length === 0;
  entries.sort(
    sort === "rate"
      ? (a, b) => b[1].percent - a[1].percent || b[1].total - a[1].total
      : sort === "number"
        ? (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
        : (a, b) => b[1].total - a[1].total,
  );
  const container = $("#double-list");
  container.innerHTML =
    entries
      .map(
        ([key, d]) =>
          `<div class="double-row"><span class="double-name">${escape(key.toUpperCase())}</span><div class="double-track" aria-hidden="true"><div class="double-fill"></div></div><span class="double-rate">${pct(d.total ? d.percent : undefined)}</span><span class="double-sample" title="Hits / finish opportunities">${number(d.hits)} / ${number(d.total)}</span></div>`,
      )
      .join("") ||
    (coverage.doubleEligibleLegs > 0 && coverage.doubleLegs === 0
      ? '<p class="empty-cell">Per-double percentages unavailable: no usable throw records. The overall checkout rate above uses leg totals instead.</p>'
      : '<p class="empty-cell">No recorded double-finish opportunities in this date range.</p>');
  container.querySelectorAll(".double-fill").forEach((bar, index) => {
    bar.style.width = `${Math.max(0, Math.min(100, entries[index][1].percent * 100 || 0))}%`;
  });
  $("#double-note").textContent =
    `Darts thrown with that double left to finish, not inferred aim. Hits / opportunities from ${number(coverage.doubleLegs)} of ${number(coverage.doubleEligibleLegs)} Double-out legs.`;
}

function matchLink(game) {
  const label = `Open match from ${date(game.matchDate)}`;
  return `<a class="match-link" href="https://play.autodarts.com/history/matches/${encodeURIComponent(game.matchId)}" target="_blank" rel="noreferrer" aria-label="${escape(label)}">↗</a>`;
}

function renderBests() {
  const a = data.analytics;
  $("#best-legs").innerHTML =
    (a.bestGames || [])
      .map(
        (game, index) =>
          `<tr><td>${index + 1}</td><td>${escape(date(game.matchDate))}</td><td><strong>${number(game.numDarts)}</strong></td><td>${number(game.average, 2)}</td><td>${matchLink(game)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty-cell">No completed legs in this date range.</td></tr>';
  $("#best-checkouts").innerHTML =
    (a.bestCheckouts || [])
      .map(
        (game, index) =>
          `<tr><td>${index + 1}</td><td>${escape(date(game.matchDate))}</td><td><strong>${number(game.score)}</strong></td><td>${String(
            game.targets || "—",
          )
            .split(/\s+/)
            .filter(Boolean)
            .map(
              (target) => `<span class="target-chip">${escape(target)}</span>`,
            )
            .join("")}</td><td>${matchLink(game)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty-cell">No checkouts in this date range.</td></tr>';
}

// Clear notation for a remaining score: the board has no D32, so 32 is
// written as "32 left · D16". Scores no single dart can finish (odd leaves,
// anything above 40 except bull) are labeled as setup states.
function scoreLabel(score) {
  if (score === 50) return "50 left · Bull";
  if (score >= 2 && score <= 40 && score % 2 === 0)
    return `${score} left · D${score / 2}`;
  return `${score} left · setup`;
}

function routeDetails(result, stateByScore, targetByScore) {
  if (result.status === "missing")
    return `<p>Not enough history: no usable recorded outcomes at ${escape(result.missingScores.map(scoreLabel).join(", "))}. A reachable score without usable records blocks the estimate instead of being guessed.</p>`;
  if (result.status === "non-finishing")
    return `<p>No finite estimate: the recorded outcomes at ${escape(result.closedScores.map(scoreLabel).join(", "))} leave no checkout escape in this model. This describes limited evidence, not whether you can finish this score.</p>`;
  const rows = [...result.states]
    .sort((left, right) => right.score - left.score)
    .map((entry) => {
      const state = stateByScore.get(entry.score);
      const finish = state?.outcomes.find((outcome) => outcome.to === 0);
      const direct = state ? (finish ? finish.probability : 0) : null;
      const target = targetByScore.get(entry.score);
      const inside =
        state && target && state.observations > 0
          ? target.insideSingles / state.observations
          : null;
      return `<tr><th scope="row">${escape(scoreLabel(entry.score))}</th><td>${number(entry.expectedDarts, 2)}</td><td>${number(entry.observations)}</td><td>${pct(direct)}</td><td>${pct(inside)}</td></tr>`;
    })
    .join("");
  return `<div class="route-details"><table><caption class="sr-only">Expected darts spent at each reachable score starting from ${escape(scoreLabel(result.score))}</caption><thead><tr><th>State</th><th>Expected darts</th><th>Observed throws</th><th>Direct finish</th><th>Inside single</th></tr></thead><tbody>${rows}</tbody></table><p>States sum to the ${number(result.expectedDarts, 1)} expected darts. Expected visits: ${number(result.expectedVisits, 1)} (every started visit, including the finishing one). Forfeited bust slots: ${number(result.expectedForfeitedDarts, 1)} — darts left unthrown after a bust, reported separately and never counted as throws.</p></div>`;
}

function renderRoutes() {
  const model = data.analytics.finishing;
  const stateByScore = new Map(model.states.map((state) => [state.score, state]));
  const targetByScore = new Map(
    model.targets.map((target) => [target.score, target]),
  );
  const results = estimateRouteEfficiencies(model);
  const rows = [...results].sort((left, right) => right.score - left.score);
  let sparse = 0;
  let missing = 0;
  let closed = 0;
  const solid = rows.filter(
    (result) =>
      result.status === "ok" &&
      !(result.minSamples !== null && result.minSamples < MIN_ROUTE_SAMPLES),
  );
  const solidDarts = solid.map((result) => result.expectedDarts);
  const bestDarts = solidDarts.length ? Math.min(...solidDarts) : 0;
  const worstDarts = solidDarts.length ? Math.max(...solidDarts) : 0;
  $("#route-table").innerHTML = model.coverage.legs === 0
    ? '<tr><td colspan="6" class="empty-cell">No usable throw records for route estimates. The overall double-out checkout rate above only needs recorded leg totals.</td></tr>'
    : rows.map((result) => {
      const lowSample =
        result.status === "ok" &&
        result.minSamples !== null &&
        result.minSamples < MIN_ROUTE_SAMPLES;
      if (result.status === "missing") missing += 1;
      else if (result.status === "non-finishing") closed += 1;
      else if (lowSample) sparse += 1;
      let mainCell;
      if (result.status === "ok") {
        const heat = lowSample
          ? null
          : worstDarts > bestDarts
            ? (100 * (worstDarts - result.expectedDarts)) / (worstDarts - bestDarts)
            : 50;
        const style =
          heat === null ? "" : ` style="--heat:${heat.toFixed(1)}%"`;
        mainCell = `<td class="route-cell route-known${lowSample ? " route-sparse" : ""}"${style}>${number(result.expectedDarts, 1)}${lowSample ? " †" : ""}<small>${lowSample ? `min n=${number(result.minSamples)}` : "expected darts"}</small></td>`;
      } else if (result.status === "missing") {
        mainCell = `<td class="route-cell route-missing">Not enough history<small>missing: ${escape(result.missingScores.join(", "))}</small></td>`;
      } else {
        mainCell = `<td class="route-cell route-closed">No finite estimate<small>no exit observed: ${escape(result.closedScores.join(", "))}</small></td>`;
      }
      const state = stateByScore.get(result.score);
      const finish = state?.outcomes.find((outcome) => outcome.to === 0);
      const direct = state ? (finish ? finish.probability : 0) : null;
      const target = targetByScore.get(result.score);
      const inside =
        state && target && state.observations > 0
          ? target.insideSingles / state.observations
          : null;
      const leave =
        result.score === 50
          ? scoreLabel(25)
          : result.score >= 2 && result.score <= 40
            ? scoreLabel(result.score / 2)
            : null;
      const single = result.score === 50 ? 25 : result.score / 2;
      const insideLabel = result.score === 2
        ? "S1 → bust; visit resets"
        : leave ? `S${single} → ${leave}` : "—";
      return `<tr data-finish="${result.score}"><th scope="row">${escape(scoreLabel(result.score))}</th>${mainCell}<td class="route-cell">${pct(direct)}<small>direct${state ? ` · n=${number(state.observations)}` : ""}</small></td><td class="route-cell">${pct(inside)}<small>${escape(insideLabel)}</small></td><td class="route-cell">${result.status === "ok" ? number(result.expectedSetupDarts, 1) : "—"}<small>expected setup</small></td><td class="route-cell route-why"><details><summary>Why?</summary>${routeDetails(result, stateByScore, targetByScore)}</details></td></tr>`;
    }).join("");
  $("#route-verdict").textContent = model.coverage.legs === 0
    ? "The finish matrix needs recorded individual throws. No numbers are invented when those records are missing."
    : `Expected darts to finish from a fresh visit of three darts, following misses across later visits — lower is better, greener cells are lower. † marks a route whose smallest reached-score sample is under ${MIN_ROUTE_SAMPLES} recorded throws.${sparse ? ` ${number(sparse)} of ${number(rows.length)} routes are sparse.` : ""}${missing ? ` ${number(missing)} routes lack history at a reached score and show no number instead of a guess.` : ""}${closed ? ` ${number(closed)} routes have no finite estimate from the recorded outcomes.` : ""} Estimates start at the listed score; the cost of getting there is not counted.`;
  $("#route-evidence").textContent =
    `${number(model.coverage.legs)} legs with usable throw records in the selected date range. Historical behavior only: intended aim is not recorded, opponent finishing is ignored, and misses are followed with the recorded outcome mix, weighted by how often each score is actually reached. Setup darts can span visits; busts forfeit the remaining darts of a visit, reported separately from actual throws. The matrix describes your history; it does not declare a universally best double.`;
}

async function refreshSavedHistory() {
  const id = loadId;
  try {
    const summary = await requestStats("history-summary", {});
    if (id !== loadId) return;
    $("#saved-history-status").textContent =
      `${number(summary.matches)} saved matches · ${number(summary.legs)} completed legs · stored on this device for this account.`;
  } catch (error) {
    if (id === loadId) $("#saved-history-status").textContent = `Saved-history status unavailable: ${error.message}`;
  }
}

function renderAnalytics() {
  const hasAnalytics = !!data.analytics;
  $("#footer-range").textContent = hasAnalytics
    ? `${date(data.filters.start)} – ${date(data.filters.end)} (UTC)`
    : analyticsError ? "Date-range statistics unavailable" : "Calculating date-range statistics…";
  $("#analytics-notice").hidden = hasAnalytics;
  $("#analytics-message").textContent = analyticsError
    ? `Detailed statistics unavailable: ${analyticsError.message} Recent form is still available; recent-leg analysis loads independently.`
    : "Calculating date-range statistics from your match history. The first load may take a while.";
  $("#analytics-retry").hidden = !analyticsError;
  $("#analytics-source").hidden = !hasAnalytics;
  $("#analytics-source").textContent = hasAnalytics
    ? `${number(data.analytics.numLegsPlayed)} completed X01 legs · calculated locally from match history · selected date range (UTC)`
    : "";
  for (const selector of ["#activity-panel", "#records-strip", "#finishing", "#routes", "#bests"])
    $(selector).hidden = !hasAnalytics;
  for (const target of ["finishing", "bests"])
    $(`.nav-link[href="#${target}"]`).hidden = !hasAnalytics;
  $(".performance-grid").classList.toggle("without-analytics", !hasAnalytics);
  $("#empty-range").hidden = !hasAnalytics || data.analytics.numLegsPlayed > 0;
  if (hasAnalytics) {
    renderActivity();
    renderDistribution();
    renderDoubles();
    renderBests();
    renderRoutes();
  } else {
    distribution?.destroy();
    distribution = undefined;
  }
}

async function loadAnalytics() {
  const id = ++analyticsLoadId;
  analyticsController?.abort();
  analyticsController = new AbortController();
  data.analytics = null;
  analyticsError = undefined;
  renderAnalytics();
  try {
    const payload = await requestStats("analytics", {
      start: data.filters.start,
      end: data.filters.end,
    }, { signal: analyticsController.signal });
    if (id !== analyticsLoadId || !data) return;
    data.analytics = payload;
  } catch (error) {
    if (id !== analyticsLoadId || error.name === "AbortError") return;
    analyticsError = error;
  } finally {
    if (id === analyticsLoadId && data) renderAnalytics();
    if (id === analyticsLoadId && data) refreshSavedHistory();
  }
}

function render() {
  $("#username").textContent = data.profile.username;
  $("#avatar").textContent = (
    data.profile.firstName ||
    data.profile.username ||
    "?"
  )
    .slice(0, 2)
    .toUpperCase();
  $("#greeting").textContent =
    `${data.profile.firstName || data.profile.username}, here’s how your game is coming together.`;
  $("#updated").textContent =
    `Updated ${new Date(data.fetchedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  renderRecent();
  renderTrend();
  renderAnalytics();
}

async function load({ reloadInsights = true, forceInsights = false } = {}) {
  const id = ++loadId;
  analyticsLoadId += 1;
  analyticsController?.abort();
  controller?.abort();
  controller = new AbortController();
  applyPreset();
  const params = new URLSearchParams({
    limit: $("#limit").value,
    start,
    end,
    interval: "daily",
  });
  $("#error-panel").hidden = true;
  $("#notice").hidden = false;
  $("#notice").textContent = data
    ? "Updating your statistics…"
    : "Loading your statistics through the extension…";
  $("#dashboard").setAttribute("aria-busy", "true");
  $("#refresh").disabled = true;
  $("#retry").disabled = true;
  $("#connection-state").textContent = "Syncing";
  $("#connection-state").classList.remove("connected");
  try {
    const result = await requestStats(
      "dashboard",
      {
        limit: params.get("limit"),
        start,
        end,
        interval: "daily",
      },
      { signal: controller.signal },
    );
    if (id !== loadId) return;
    data = { ...result, analytics: null };
    analyticsError = undefined;
    $("#dashboard").hidden = false;
    render();
    $("#connection-state").textContent = "Connected";
    $("#connection-state").classList.add("connected");
    params.set("range", range);
    history.replaceState(null, "", `?${params}${location.hash}`);
    if (reloadInsights)
      loadRecentAnalysis({ force: forceInsights });
    loadAnalytics();
  } catch (error) {
    if (id !== loadId || error.name === "AbortError") return;
    $("#dashboard").hidden = true;
    $("#error-panel").hidden = false;
    $("#error-message").textContent = /auth|sign.?in|unauthor|session/i.test(
      error.code || "",
    )
      ? "Sign in on the Autodarts Statistics page, then retry."
      : error.message;
    $("#connection-state").textContent = "Disconnected";
    $("#updated").textContent = "Statistics unavailable";
  } finally {
    if (id === loadId) {
      $("#notice").hidden = true;
      $("#dashboard").setAttribute("aria-busy", "false");
      $("#refresh").disabled = false;
      $("#retry").disabled = false;
    }
  }
}

$("#refresh").addEventListener("click", () =>
  load({ reloadInsights: true, forceInsights: true }),
);
$("#retry").addEventListener("click", () =>
  load({ reloadInsights: true, forceInsights: true }),
);
$("#analytics-retry").addEventListener("click", loadAnalytics);
$("#clear-history").addEventListener("click", async () => {
  if (!confirm("Delete saved match summaries for all accounts on this device? Your Autodarts records and login are not changed. Refreshing stats will save history again.")) return;
  $("#clear-history").disabled = true;
  try {
    await requestStats("clear-history", {});
    await refreshSavedHistory();
  } catch (error) {
    $("#saved-history-status").textContent = `Could not clear saved history: ${error.message}`;
  } finally {
    $("#clear-history").disabled = false;
  }
});
$("#limit").addEventListener("change", () => {
  analysisLoadId += 1;
  analysis = undefined;
  analysisError = false;
  invalidateInsights($("#limit").value);
  load();
});
$("#range").addEventListener("change", () => {
  range = $("#range").value;
  $("#date-form").hidden = range !== "custom";
  if (range !== "custom") load({ reloadInsights: false });
});
$("#date-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("#start").value > $("#end").value) {
    $("#end").setCustomValidity(
      "The end date must be on or after the start date.",
    );
    $("#end").reportValidity();
    return;
  }
  start = $("#start").value;
  end = $("#end").value;
  load({ reloadInsights: false });
});
for (const input of [$("#start"), $("#end")])
  input.addEventListener("input", () => $("#end").setCustomValidity(""));
for (const button of [$("#insights-retry"), $("#trend-retry")])
  button.addEventListener("click", () => loadRecentAnalysis({ force: true }));
$("#double-sort").addEventListener("change", renderDoubles);
for (const button of document.querySelectorAll("[data-chart]"))
  button.addEventListener("click", () => {
    chartMode = button.dataset.chart;
    for (const other of document.querySelectorAll("[data-chart]")) {
      const selected = other === button;
      other.classList.toggle("selected", selected);
      other.setAttribute("aria-pressed", String(selected));
    }
    renderTrend();
  });
for (const link of document.querySelectorAll(".nav-link"))
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((other) => {
      other.classList.toggle("active", other === link);
      if (other === link) other.setAttribute("aria-current", "location");
      else other.removeAttribute("aria-current");
    });
  });

function resetForAccountSwitch() {
  loadId += 1;
  analysisLoadId += 1;
  analyticsLoadId += 1;
  analyticsController?.abort();
  analyticsController = undefined;
  analyticsError = undefined;
  controller?.abort();
  controller = undefined;
  data = undefined;
  analysis = undefined;
  analysisError = false;
  trend?.destroy();
  trend = undefined;
  distribution?.destroy();
  distribution = undefined;
  invalidateInsights($("#limit").value);
  $("#dashboard").hidden = true;
  $("#dashboard").setAttribute("aria-busy", "true");
  $("#error-panel").hidden = true;
  $("#username").textContent = "Your account";
  $("#avatar").textContent = "—";
  $("#saved-history-status").textContent = "Loading saved-history status for this account…";
  $("#greeting").textContent = "A little perspective. A better next leg.";
  $("#connection-state").textContent = "Syncing";
  $("#connection-state").classList.remove("connected");
  $("#updated").textContent = "Loading through the extension";
  load({ reloadInsights: true, forceInsights: true });
}

onSessionChanged(resetForAccountSwitch);
load();
