import { API, STATISTICS, accessFromRequest, usableAccess } from "./auth.mjs";
import { createStatsReader, parseFilters } from "./stats.mjs";

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let state = { access: null, userId: null, revision: 0 };
const initialized = chrome.storage.session.get("session").then(({ session }) => {
  if (session) state = {
    access: usableAccess(session.access?.header),
    userId: session.userId ?? null,
    revision: session.revision ?? 0,
  };
});
let writes = Promise.resolve();
let connecting;
let capture;
let readStats = createStatsReader(upstream);

function persist() {
  return chrome.storage.session.set({ session: state });
}

function acceptAccess(candidate) {
  // Serialize observations so initialization/storage writes cannot overwrite a
  // newer account or access token. Never persist to local/sync storage.
  writes = writes.catch(() => {}).then(async () => {
    await initialized;
    if (state.access?.header === candidate.header) return;
    if (state.userId === candidate.userId && state.access?.expiresAt > candidate.expiresAt) return;
    const switched = state.userId && state.userId !== candidate.userId;
    state = {
      access: candidate,
      userId: candidate.userId,
      revision: state.revision + (switched ? 1 : 0),
    };
    if (switched) readStats = createStatsReader(upstream);
    await persist();
    capture?.resolve();
    if (switched) {
      // No credentials in messages or dashboard payloads.
      chrome.runtime.sendMessage({ type: "session-changed" }).catch(() => {});
    }
  });
  return writes;
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const candidate = accessFromRequest(details);
    if (candidate) acceptAccess(candidate).catch(() => {});
  },
  { urls: [`${API}/*`], types: ["xmlhttprequest"] },
  ["requestHeaders", "extraHeaders"],
);

async function captureSession() {
  let timer;
  const observed = new Promise((resolve, reject) => {
    capture = { resolve, reject };
    timer = setTimeout(() => reject(new AppError(
      "Sign in on the Autodarts Statistics page, then return here and retry.",
      "SIGN_IN_REQUIRED",
    )), 20_000);
  });
  // Attach the waiter before opening/reloading so even the first API request
  // is observed. Only the website rotates its own refresh token.
  try {
    const tabs = await chrome.tabs.query({ url: "https://play.autodarts.com/statistics*" });
    if (tabs.length) await chrome.tabs.reload(tabs[0].id);
    else await chrome.tabs.create({ url: STATISTICS, active: true });
  } catch {
    capture.reject(new AppError("Open Autodarts Statistics, sign in, and retry.", "SIGN_IN_REQUIRED"));
  }
  try {
    await observed;
  } finally {
    clearTimeout(timer);
    capture = undefined;
  }
}

async function session() {
  await initialized;
  await writes;
  if (!usableAccess(state.access?.header)) {
    if (!connecting) connecting = captureSession().finally(() => { connecting = undefined; });
    await connecting;
    await writes;
  }
  if (!state.access) throw new AppError("Sign in on Autodarts and retry.", "SIGN_IN_REQUIRED");
  return { ...state.access, revision: state.revision };
}

function ensureAccount(token) {
  if (token.userId !== state.userId || token.revision !== state.revision)
    throw new AppError("Your Autodarts account changed. Reload your statistics.", "SESSION_CHANGED");
}

async function upstream(path, token) {
  ensureAccount(token);
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { Authorization: token.header, Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new AppError("Autodarts could not be reached. Check your connection and retry.", "UPSTREAM_UNAVAILABLE");
  }
  ensureAccount(token);
  if (response.status === 401) {
    // A rejected older request must not erase a freshly observed access token.
    if (state.access?.header === token.header) {
      state.access = null;
      await persist();
    }
    throw new AppError("Your Autodarts session expired. Sign in on Statistics and retry.", "SESSION_EXPIRED");
  }
  if (response.status === 403)
    throw new AppError("Autodarts denied access. Advanced statistics may require Autodarts Plus.", "ACCESS_DENIED");
  if (!response.ok)
    throw new AppError(`Autodarts returned HTTP ${response.status}. Try again later.`, "UPSTREAM_ERROR");
  return response.json();
}

function dashboardSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  return url.protocol === "chrome-extension:" &&
    url.host === chrome.runtime.id && url.pathname === "/public/index.html";
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!dashboardSender(sender) || message?.type !== "stats") return;
  (async () => {
    if (!["dashboard", "insights"].includes(message.kind))
      throw new AppError("Unsupported statistics request.", "INVALID_REQUEST");
    try { parseFilters(message.filters); } catch {
      throw new AppError("Choose a valid leg window, date range, and interval.", "INVALID_FILTER");
    }
    const token = await session();
    const data = await readStats(message.kind, message.filters, token);
    await writes;
    ensureAccount(token);
    return { ok: true, data };
  })().then(respond, (error) => respond({
    ok: false,
    error: error instanceof AppError ? error.message : "Unable to read your statistics. Open Autodarts Statistics and retry.",
    code: error instanceof AppError ? error.code : "STATS_UNAVAILABLE",
  }));
  return true;
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("public/index.html");
  const tabs = await chrome.tabs.query({ url: `${url}*` });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});
