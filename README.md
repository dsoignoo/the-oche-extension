# The Oche — Autodarts Stats

A Chrome extension that shows your own Autodarts X01 stats. No server, Node.js, OMP relay, password sharing, or account data bundled with the extension.

## Install and use

Requires desktop Chrome 120+ and an Autodarts account with access to its own match history. Detailed analytics are calculated locally; the extension does not use Autodarts' aggregated advanced-statistics endpoint.

1. Open [Releases](https://github.com/dsoignoo/the-oche-extension/releases/latest) and download **`the-oche-extension.zip`** under **Assets**. Do not download GitHub's automatically generated “Source code” ZIP.
2. Extract the ZIP into a permanent folder. Keep that folder; Chrome loads the extension from it.
3. In Chrome, open **`chrome://extensions`**.
4. Turn on **Developer mode** at the top right.
5. Click **Load unpacked** and select the extracted folder that directly contains **`manifest.json`**.
6. Open [Autodarts Statistics](https://play.autodarts.com/statistics?mode=x01&legs=100&interval=daily) and sign in with **your own** account.
7. Click Chrome's **Extensions** puzzle icon, then **The Oche — Autodarts Stats**. Pin it for easier access. Clicking its toolbar icon opens the dashboard in a full tab.

The extension uses the account signed into Autodarts in that Chrome profile. Your friend's installation uses their account, not the developer's. You never need to send anyone your password, cookies, or access token.

### Daily use and reconnecting

- Click the extension icon to open or return to the dashboard.
- Click **Refresh stats** after playing.
- If prompted to sign in, finish signing in on Autodarts Statistics, return to the dashboard, and click **Retry**.
- When a new session is needed, the extension opens Statistics or reloads an existing Statistics tab. It never reloads your match tab.
- Autodarts owns session renewal. The extension observes only the short-lived access token the website sends; it never reads or submits the refresh token.
- After switching Autodarts accounts, load Statistics for the new account. Observing the new account clears the previous dashboard and loads fresh data.
- Recent form and ten-leg groups load independently of date-range analytics. The first full-history scan can take longer; later requests reuse account-scoped match summaries.
- If detailed statistics cannot be calculated, the dashboard keeps recent form and groups available, shows the history error, and offers **Retry history analytics**.
- Completed normalized match summaries are saved in this Chrome profile, separately for each Autodarts account. Reloading the extension reuses saved matches instead of downloading every detail again. Login credentials are not part of this database.
- **Clear all saved match history** removes local summaries for every account on this device, without deleting Autodarts records or signing anyone out. A later Refresh saves history again. Clear then refresh if an old match was corrected without its completion timestamp changing.

### Updating or removing

This release is installed manually, not through the Chrome Web Store, so it does **not** auto-update.

To update: download the new release, replace the files in the same extracted folder, open `chrome://extensions`, click the extension's reload button, and reopen its dashboard. If you move the folder, remove the old installation and load the new folder instead.

To remove: click **Remove** on its card in `chrome://extensions`. Removing the extension does not sign you out of Autodarts.

## What it shows

- **Recent form:** three-dart average, first-nine average, checkout rate, leg win rate, and scoring visit bands. Choose 25, 50, 100, 200 (default), 250, or 500 legs.
- **Separate groups of 10:** last 10 legs, previous 10 (11–20), previous 10 (21–30), and so on, newest first. Groups do not overlap and are not daily buckets or rolling averages. An incomplete oldest group shows its actual sample count.
- **180 frequency:** select **180 frequency** in the grouped performance chart. Each bar is `100 × recorded 180s / recorded visits` for that ten-leg group. Tooltips and the data table show actual counts, visit totals, and covered legs. The window summary pools counts rather than averaging group rates. Missing visit data is excluded, not treated as zero; shortened finishing visits are included in recorded visits. Choose up to 500 legs for more history.
- **Game plan:** individual-leg P10/median/P90, current versus previous window, momentum, descriptive practice signals, and top human opponents.
- **Activity and finishing:** locally calculated darts thrown, legs played/won, represented matches, recorded leg time, game-type mix, visit distribution, double-finish opportunities, best winning legs/checkouts, and original match links.
- **Local double-out checkout %:** calculated from recorded leg hits and attempts, even when individual throw records are unavailable. Missing attempts remain unavailable, not 0%. Per-double breakdowns still need usable throw records.
- **Checkout matrix:** all 20 double finishes and bull, with side-by-side checkout estimates for 1, 2, and 3 darts. The empirical model includes inside singles, odd-score setup, busts, and later doubles—not just the first-double hit rate. Compare 36 → 18 → 9 with 40 → 20 → 10 alongside observed full-visit conversion, setup burden, and sample counts.
- **Date ranges:** all time (from 2021), 30 days, 90 days, or custom. These affect activity, finishing, and records—not the recent-leg groups or game plan.

### Statistical scope

The overview preserves Autodarts' aggregate response. Grouped performance and the game plan use your completed X01 legs with a recorded winner and usable scoring data, including wins and losses. Abandoned/undecided legs and hosted games you did not play are excluded. Consequently the two sources can produce different averages.

Date-range analytics scan **all matching history**, not the recent-leg sample. Legs are selected by their individual completion timestamps, inclusive of the requested UTC dates; a match can contribute only some of its legs. Each game is counted once. Fetch failures do not produce silently incomplete totals.

Scoring is dart-weighted: `3 × total points / total darts`, not the mean of leg averages. Checkout rates pool hits and attempts; no attempts means unavailable, not zero. Percentiles use R7 interpolation over individual-leg averages. Opponent results are leg W–L, not match W–L; bots, unstable guest identities, and multiplayer games are excluded from opponent comparisons.

Signals are descriptive heuristics, not significance tests or causal explanations. Small samples and mixed settings need caution. The separate leg-by-leg game-plan chart retains its trailing-25 curve; the main performance chart uses disjoint groups of 10.

Double finishing opportunities count darts thrown when the remaining score could be finished on that double (or bull) in Double-out games. They do not infer where the player aimed. The displayed rate pools successful finishes over those opportunities; coverage shows how many legs had usable throw records. Visit totals likewise identify the legs with recorded visit counts.

Recorded leg time is the union of known leg start/end intervals, including pauses and opponent turns; overlapping intervals count once. It is not an estimate of active throwing time. Walking distance is absent from match history and is displayed as **Not recorded**. Missing timing, visit, route, or throw data is not replaced with invented values.

Route estimates replay the recorded outcome mix at each remaining score, without guessing intended aim or an optimal action. Greener matrix cells mean higher modeled chances; † marks fewer than 20 recorded darts at a reached score. A missing reached score gives a range covering its unknown outcomes, not an invented zero and not a statistical confidence interval. Probabilities assume you already have the starting score left; they exclude the cost of getting there. Full-visit counts and descriptive Wilson intervals provide separate observed evidence. This is a historical comparison, not proof that a route causes better play or a universally best-double recommendation.

## Privacy and permissions

The only website permissions are:

| Permission | Purpose |
| --- | --- |
| `https://play.autodarts.com/*` | Observe requests made by the signed-in Autodarts website and locate its Statistics tab. |
| `https://api.autodarts.com/*` | Read your profile, X01 aggregates, and match history. |
| `webRequest` | Observe the access token already attached to website API requests, without modifying requests. |
| `storage` | Keep that short-lived token in Chrome's **in-memory `storage.session`**, across background-worker restarts. |

There is no cookies permission, content script, all-sites permission, external-message API, analytics service, or application server. Chart.js is bundled locally; no CDN scripts are loaded.

Login tokens are held only in Chrome's in-memory `storage.session`; they are never written to the match database, `storage.local`, `storage.sync`, or application files. This token memory clears when Chrome restarts or the extension is disabled, reloaded, updated, or removed. Separately, **normalized completed-match summaries persist in IndexedDB on this device**, scoped by account and match ID. They include personal scoring, opponent identities, and compact finishing counts/transitions, but no raw request headers, credentials, or throw coordinates. Saved summaries survive extension reloads, are invalidated when a match's completion timestamp or normalization version changes, and are removed by **Clear all saved match history** or extension removal. No match data is bundled with a release or uploaded to an application server. Account switches invalidate pending results and clear the displayed account before loading the new one.

Only the extension's own dashboard can request statistics from its background worker. The dashboard receives statistics, never an access token in its messages. API access tokens remain sensitive: do not copy extension storage or browser profiles to share the extension.

Autodarts' endpoints are undocumented and may change. This extension is not affiliated with Autodarts. Authentication, subscription, network, and history failures are shown explicitly; missing data is never replaced with fabricated stats.

## Develop and build

Node.js 22+ is needed **only to develop/build**, not to install or use a release.

```sh
npm ci
npm test
npm run build
```

Outputs:

- **`dist/the-oche/`** — load this folder unpacked during development.
- **`dist/the-oche-extension.zip`** — share this file or attach it to a GitHub release.

The builder uses an explicit source allowlist. Environment files, browser profiles, credentials, tests, development dependencies, and old local-server archives are not included. Only the bundled Chart.js runtime and its license are copied from dependencies.

Architecture:

- `manifest.json` — Manifest V3 permissions, toolbar action, and extension CSP.
- `background.mjs` / `auth.mjs` — website access-token observation, memory-only sessions, account isolation, and toolbar navigation.
- `stats.mjs` — fixed profile/statistics requests and filter validation.
- `history.mjs` / `insights.mjs` / `analytics.mjs` — account-scoped history, recent-leg insights, and full date-range analytics calculated from normalized completed legs.
- `history-store.mjs` — account-scoped IndexedDB summaries, completion/version invalidation, and explicit local deletion.
- `finishing.mjs` — pooled finishing evidence and finite-horizon checkout-route estimates with explicit missing-state bounds.
- `public/` — dashboard, bundled-chart integration, and abort-aware extension messaging.
- `scripts/build-extension.mjs` — portable unpacked-folder and ZIP builder.

## Verification

- Initial extension release: 19 deterministic tests passed for scoring/checkout weighting, ten-leg boundaries, chronology, opponents, history account separation, access-token guards, and date validation.
- Loaded the actual unpacked Manifest V3 extension in Chrome against a signed-in Autodarts account; the dashboard and completed-leg groups used real API data.
- Exercised scoring/checkout/activity controls, a 25-leg window with a five-leg final group, and date-range independence.
- Session continuity after stopping/restarting the background worker was exercised with Chrome's debugging protocol. Full token-expiry renewal and switching between two real accounts were not part of the live smoke test.
- History-analytics update: 27 affected tests passed for UTC range boundaries, overlapping matches, full pagination, throw replay, pooled finishing rates, elapsed-time unions, records, missing-data coverage, and independent overview availability.
- Verified real all-time, 30-day, and 90-day history-derived analytics in the installed Chrome extension. A simulated history HTTP 403 left recent form and ten-leg groups usable; retry restored detailed statistics. No aggregated advanced-endpoint requests were made by the extension during the check, and no browser runtime errors were observed.
- 180-frequency update: all 13 insights tests passed, including disjoint-group rates, partial coverage, duplicates, and missing/zero-visit cases. Verified the installed extension's 500-leg chart against its displayed counts, real tooltip content, fractional axis labels, and a 390px-wide layout without horizontal overflow or runtime errors.
- Saved-history/finishing update: 80 affected tests passed across focused runs, covering account separation, completion/version invalidation, clear-during-sync races, missing throws, inside singles, odd setup, busts, and route probabilities. Verified the real 21-row/63-cell matrix, sample markers, monotonic 1/2/3-dart estimates, and a 390px layout with scrolling confined to the table.
- Reloaded the installed extension without removing it: 1,278 saved matches and 3,145 completed legs survived, with zero match-detail downloads during the subsequent load. Exercised the native clear confirmation, observed zero saved records, and refreshed back to the same history. Simulated missing throw arrays still produced overall checkout % from leg hits/attempts; per-double data remained explicitly unavailable. No dashboard runtime errors were observed.

