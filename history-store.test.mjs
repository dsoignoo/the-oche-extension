import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  createHistoryStore,
  NORMALIZATION_VERSION,
} from "./history-store.mjs";

const FINISHED = "2026-10-15T12:00:00Z";
const OTHER_FINISHED = "2026-10-15T13:00:00Z";

const freshStore = () => createHistoryStore(new IDBFactory());

function leg(gameId = "g1") {
  return {
    gameId,
    matchId: "m1",
    finishedAt: FINISHED,
    won: true,
    darts: 15,
    points: 501,
  };
}

function result(legs = [leg()], skippedLegs = 0, skippedMatches = 0) {
  return { legs, skippedLegs, skippedMatches };
}


test("put and get round-trip a normalized result for the exact fingerprint", async () => {
  const store = freshStore();
  const value = result([leg("g1"), leg("g2")], 1, 2);
  assert.equal(await store.put("u1", "m1", FINISHED, value), true);
  assert.deepEqual(await store.get("u1", "m1", FINISHED), value);
  store.close();
});

test("cache entries cannot cross account, match, or finishedAt fingerprints", async () => {
  const store = freshStore();
  await store.put("u1", "m1", FINISHED, result());
  assert.equal(await store.get("u2", "m1", FINISHED), null);
  assert.equal(await store.get("u1", "m2", FINISHED), null);
  assert.equal(await store.get("u1", "m1", OTHER_FINISHED), null);
  store.close();
});

test("unfinished or invalid matches never persist or read back", async () => {
  const store = freshStore();
  for (const finishedAt of ["", "not-a-date", null, undefined, 0]) {
    assert.equal(await store.put("u1", "m1", finishedAt, result()), false);
    assert.equal(await store.get("u1", "m1", finishedAt), null);
  }
  const summary = await store.summary("u1");
  assert.equal(summary.matches, 0);
  store.close();
});

test("records from a different normalization version are treated as absent", async () => {
  const factory = new IDBFactory();
  // Seed a record directly with a stale schema version.
  const db = await new Promise((resolve, reject) => {
    const request = factory.open("autodarts-normalized-history", 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("matches", { keyPath: ["userId", "matchId"] })
        .createIndex("userId", "userId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("matches", "readwrite");
    transaction.objectStore("matches").put({
      userId: "u1",
      matchId: "m1",
      finishedAt: FINISHED,
      schemaVersion: NORMALIZATION_VERSION + 1,
      updatedAt: FINISHED,
      value: result(),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();

  const store = createHistoryStore(factory);
  assert.equal(await store.get("u1", "m1", FINISHED), null);
  // A fresh normalization overwrites the stale record.
  const value = result([leg("g9")]);
  assert.equal(await store.put("u1", "m1", FINISHED, value), true);
  assert.deepEqual(await store.get("u1", "m1", FINISHED), value);
  store.close();
});

test("values survive closing and reopening with the same factory", async () => {
  const factory = new IDBFactory();
  const first = createHistoryStore(factory);
  const value = result([leg("g1"), leg("g2")], 3, 1);
  await first.put("u1", "m1", FINISHED, value);
  first.close();

  const second = createHistoryStore(factory);
  assert.deepEqual(await second.get("u1", "m1", FINISHED), value);
  const summary = await second.summary("u1");
  assert.equal(summary.matches, 1);
  assert.equal(summary.legs, 2);
  assert.equal(typeof summary.updatedAt, "string");
  second.close();
});

test("only allowlisted normalized fields persist; tokens, headers, and extras are dropped", async () => {
  const store = freshStore();
  const dirty = {
    ...result([leg()]),
    token: "secret-bearer",
    headers: { Authorization: "Bearer secret-bearer" },
    rawMatch: { players: [{ name: "Ada" }] },
  };
  assert.equal(await store.put("u1", "m1", FINISHED, dirty), true);
  const stored = await store.get("u1", "m1", FINISHED);
  assert.deepEqual(Object.keys(stored).sort(), [
    "legs",
    "skippedLegs",
    "skippedMatches",
  ]);
  assert.equal(stored.token, undefined);
  assert.equal(stored.headers, undefined);
  assert.equal(stored.rawMatch, undefined);
  store.close();
});

test("non-normalized values are rejected", async () => {
  const store = freshStore();
  assert.equal(await store.put("u1", "m1", FINISHED, null), false);
  assert.equal(await store.put("u1", "m1", FINISHED, { legs: "nope" }), false);
  assert.equal(await store.get("u1", "m1", FINISHED), null);
  store.close();
});

test("summary is scoped to the account and reflects stored legs", async () => {
  const store = freshStore();
  await store.put("u1", "m1", FINISHED, result([leg("g1"), leg("g2")]));
  await store.put("u1", "m2", OTHER_FINISHED, result([leg("g3")], 1));
  await store.put("u2", "m1", FINISHED, result([leg("g4")]));

  const summary = await store.summary("u1");
  assert.equal(summary.matches, 2);
  assert.equal(summary.legs, 3);
  assert.equal(typeof summary.updatedAt, "string");
  assert.ok(Number.isFinite(Date.parse(summary.updatedAt)));

  const other = await store.summary("u2");
  assert.equal(other.matches, 1);
  assert.equal(other.legs, 1);

  assert.deepEqual(await store.summary("nobody"), {
    matches: 0,
    legs: 0,
    updatedAt: null,
  });
  store.close();
});

test("clear deletes everything and a put begun before it cannot repopulate", async () => {
  const store = freshStore();
  await store.put("u1", "m0", OTHER_FINISHED, result());
  const begunBeforeClear = store.put("u1", "m1", FINISHED, result());
  await store.clear();
  assert.equal(await begunBeforeClear, false);
  assert.equal(await store.get("u1", "m0", OTHER_FINISHED), null);
  assert.equal(await store.get("u1", "m1", FINISHED), null);
  assert.deepEqual(await store.summary("u1"), {
    matches: 0,
    legs: 0,
    updatedAt: null,
  });
  store.close();
});

test("a put begun after a clear stores under the new generation", async () => {
  const store = freshStore();
  await store.put("u1", "m1", FINISHED, result());
  await store.clear();
  assert.equal(await store.put("u1", "m1", FINISHED, result()), true);
  assert.deepEqual(await store.get("u1", "m1", FINISHED), result());
  store.close();
});

test("an explicit stale generation is refused even without a clear", async () => {
  const store = freshStore();
  const value = result();
  await store.put("u1", "m1", FINISHED, value);
  await store.clear();
  assert.equal(
    await store.put("u1", "m1", FINISHED, value, store.generation - 1),
    false,
  );
  assert.equal(await store.get("u1", "m1", FINISHED), null);
  store.close();
});

test("a failed database open stays recoverable and surfaces the error", async () => {
  const inner = new IDBFactory();
  let blocked = true;
  const flaky = {
    open: (...args) => {
      if (blocked) throw new Error("IndexedDB blocked by the browser.");
      return inner.open(...args);
    },
  };
  const store = createHistoryStore(flaky);
  await assert.rejects(() => store.get("u1", "m1", FINISHED), /blocked/);
  await assert.rejects(() => store.put("u1", "m1", FINISHED, result()), /blocked/);
  blocked = false;
  const value = result();
  assert.equal(await store.put("u1", "m1", FINISHED, value), true);
  assert.deepEqual(await store.get("u1", "m1", FINISHED), value);
  store.close();
});
