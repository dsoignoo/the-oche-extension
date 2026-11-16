// Local normalized match-history cache backed by IndexedDB. Each record holds
// one completed match's allowlisted normalized result, scoped to the owning
// account. Raw API responses, tokens, headers, and coordinates are never
// written here; put() rebuilds the stored value from an explicit allowlist.
export const NORMALIZATION_VERSION = 1;

const DB_NAME = "autodarts-normalized-history";
const DB_VERSION = 1;
const STORE = "matches";

// Only stable, completed matches may persist: a parseable finishedAt string.
const isCompleted = (finishedAt) =>
  typeof finishedAt === "string" && Number.isFinite(Date.parse(finishedAt));

const isId = (value) => typeof value === "string" && value.length > 0;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Read-write operations must outlive the request's onsuccess: the transaction
// can still abort afterwards (e.g. quota), which is a real error to surface.
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

// Allowlist copy: only the normalized result shape { legs, skippedLegs,
// skippedMatches } may reach disk. Anything else the caller hangs on the
// value (tokens, headers, raw payloads) is dropped before persistence.
function allowlisted(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.legs))
    return null;
  return {
    legs: value.legs,
    skippedLegs: Number.isFinite(value.skippedLegs) ? value.skippedLegs : 0,
    skippedMatches: Number.isFinite(value.skippedMatches)
      ? value.skippedMatches
      : 0,
  };
}

export function createHistoryStore(indexedDBFactory = globalThis.indexedDB) {
  let database = null;
  let opening = null;
  let generation = 0;
  // Operations run one at a time in call order so put/clear interleavings are
  // deterministic regardless of how IndexedDB schedules transactions.
  let queue = Promise.resolve();

  function open() {
    if (database) return Promise.resolve(database);
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!indexedDBFactory) {
          reject(new Error("IndexedDB is unavailable in this context."));
          return;
        }
        const request = indexedDBFactory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, {
              keyPath: ["userId", "matchId"],
            }).createIndex("userId", "userId", { unique: false });
          }
        };
        request.onsuccess = () => {
          database = request.result;
          database.onversionchange = () => {
            database.close();
            database = null;
            opening = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error);
      });
      // A failed open must not poison later calls: clear the cached promise so
      // the next operation retries instead of reusing a rejected promise.
      opening.catch(() => {
        if (!database) opening = null;
      });
    }
    return opening;
  }

  function enqueue(task) {
    const result = queue.then(task);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  const store = {
    // Monotonic counter bumped by clear(); puts capture it at call time and a
    // stale capture proves the put began before the last clear.
    get generation() {
      return generation;
    },

    get(userId, matchId, finishedAt) {
      if (!isId(userId) || !isId(matchId) || !isCompleted(finishedAt))
        return Promise.resolve(null);
      return enqueue(async () => {
        const db = await open();
        const record = await requestResult(
          db.transaction(STORE, "readonly").objectStore(STORE).get([userId, matchId]),
        );
        if (
          !record ||
          record.userId !== userId ||
          record.matchId !== matchId ||
          record.finishedAt !== finishedAt ||
          record.schemaVersion !== NORMALIZATION_VERSION
        )
          return null;
        return record.value;
      });
    },

    put(userId, matchId, finishedAt, value, captured = generation) {
      const normalized = allowlisted(value);
      if (!isId(userId) || !isId(matchId) || !isCompleted(finishedAt) || !normalized)
        return Promise.resolve(false);
      return enqueue(async () => {
        // Begun before a clear that has since run: refuse to repopulate.
        if (captured !== generation) return false;
        const db = await open();
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put({
          userId,
          matchId,
          finishedAt,
          schemaVersion: NORMALIZATION_VERSION,
          updatedAt: new Date().toISOString(),
          value: normalized,
        });
        await transactionDone(transaction);
        return true;
      });
    },

    summary(userId) {
      if (!isId(userId))
        return Promise.resolve({ matches: 0, legs: 0, updatedAt: null });
      return enqueue(async () => {
        const db = await open();
        const records = await requestResult(
          db
            .transaction(STORE, "readonly")
            .objectStore(STORE)
            .index("userId")
            .getAll(userId),
        );
        let legs = 0;
        let updatedAt = null;
        for (const record of records) {
          legs += record.value.legs.length;
          if (updatedAt === null || record.updatedAt > updatedAt)
            updatedAt = record.updatedAt;
        }
        return { matches: records.length, legs, updatedAt };
      });
    },

    clear() {
      // Bump synchronously at call time: any put that began before this call
      // captured the old generation and must fail even if it runs later.
      generation += 1;
      return enqueue(async () => {
        const db = await open();
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).clear();
        await transactionDone(transaction);
      });
    },

    // Releases the connection so tests can reopen or delete the database.
    close() {
      const db = database;
      database = null;
      opening = null;
      if (db) db.close();
    },
  };
  return store;
}
