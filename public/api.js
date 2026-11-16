// Messaging bridge to the extension background service worker.
// The background owns the Autodarts session; this page never sees a token,
// password, or refresh token.

const CONTEXT_ERROR =
  "The Oche dashboard must run inside its Chrome extension. Open it from the extension’s toolbar button.";
const BACKGROUND_ERROR =
  "The extension background could not load your statistics. Reload the extension and retry.";

function contextUnavailable() {
  return (
    typeof chrome === "undefined" ||
    !chrome.runtime?.id ||
    typeof chrome.runtime.sendMessage !== "function"
  );
}

export function requestStats(kind, filters, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The request was aborted.", "AbortError"));
      return;
    }
    if (contextUnavailable()) {
      reject(new Error(CONTEXT_ERROR));
      return;
    }
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () =>
      finish(
        reject,
        new DOMException("The request was aborted.", "AbortError"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    let sent = true;
    try {
      chrome.runtime.sendMessage({ type: "stats", kind, filters }, (reply) => {
        if (chrome.runtime.lastError) {
          finish(reject, new Error(BACKGROUND_ERROR));
          return;
        }
        if (!reply || reply.ok !== true) {
          const error = new Error(reply?.error || BACKGROUND_ERROR);
          if (reply?.code) error.code = reply.code;
          finish(reject, error);
          return;
        }
        finish(resolve, reply.data);
      });
    } catch {
      sent = false; // extension context invalidated mid-call
    }
    if (!sent) finish(reject, new Error(CONTEXT_ERROR));
  });
}

// Fires only when the background reports an account switch. Messages from
// anything outside this extension are ignored.
export function onSessionChanged(callback) {
  if (contextUnavailable() || !chrome.runtime.onMessage) return () => {};
  const listener = (message, sender) => {
    if (sender?.id !== chrome.runtime.id) return;
    if (message?.type !== "session-changed") return;
    callback();
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
