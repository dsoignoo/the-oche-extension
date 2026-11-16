export const API = "https://api.autodarts.com";
export const PLAY = "https://play.autodarts.com";
export const STATISTICS = `${PLAY}/statistics?mode=x01&legs=100&interval=daily`;

// Parsing is only a freshness/issuer guard. Autodarts validates the signature
// when the token is used; no website message or decoded claim grants API access.
export function usableAccess(header, now = Date.now()) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  try {
    const parts = header.slice(7).split(".");
    if (parts.length !== 3 || !parts.every(Boolean)) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    if (
      claims.iss !== `${API}/auth` ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now + 60_000
    ) return null;
    return { header, expiresAt: claims.exp * 1000, userId: claims.sub };
  } catch {
    return null;
  }
}

export function accessFromRequest(details) {
  if (
    details.initiator !== PLAY ||
    !Number.isInteger(details.tabId) ||
    details.tabId < 0 ||
    !details.url.startsWith(`${API}/`)
  ) return null;
  const header = details.requestHeaders?.find(
    (entry) => entry.name.toLowerCase() === "authorization",
  );
  return usableAccess(header?.value);
}
