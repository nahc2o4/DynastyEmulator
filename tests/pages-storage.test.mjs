import test from "node:test";
import assert from "node:assert/strict";
import { BrowserStore } from "../public/browser/store.mjs";
import { InvalidSaveError, validateSave } from "../lib/save-validation.mjs";
import { createWorld } from "../lib/engine.mjs";

const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => createWorld({ name: "萧景", opening: "founding", seed: 71349 });

// A small injected IndexedDB test double models structured clones, queued
// request events, serial transactions and commit/abort. Browser integration
// tests additionally exercise the native IndexedDB implementation.
function memoryIndexedDB() {
  const databases = new Map();
  const factory = {
    calls: [],
    openMode: "success",
    legacy: false,
    nextCommitError: null,
    commitGate: null,
    records(name = "dynasty-emulator-v1") { return databases.get(name)?.records || new Map(); },
    seed(key, value, name = "dynasty-emulator-v1") { this.records(name).set(key, structuredClone(value)); },
    open(name, version) {
      this.calls.push({ kind: "open", name, version });
      const request = {};
      setImmediate(() => {
        if (this.openMode === "error") {
          request.error = new DOMException("Injected storage denial", "SecurityError");
          request.onerror?.({ target: request });
          return;
        }
        if (this.openMode === "blocked") { request.onblocked?.({ target: request }); return; }
        let state = databases.get(name);
        const fresh = !state;
        if (!state) { state = { records: new Map(), queue: [], created: false }; databases.set(name, state); }
        const database = {
          closed: false,
          objectStoreNames: { contains: (store) => state.created && store === "records" },
          createObjectStore(store) { assert.equal(store, "records"); state.created = true; },
          close() { this.closed = true; },
          transaction(store, mode, options) {
            factory.calls.push({ kind: "transaction", store, mode, options });
            if (factory.legacy && options) throw new TypeError("Durability options unsupported");
            assert.equal(store, "records"); assert.equal(mode, "readwrite");
            const operations = [];
            const transaction = { error: null, aborted: false, working: null };
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              state.queue.shift();
              if (state.queue.length) setImmediate(state.queue[0]);
            };
            const pump = async () => {
              if (transaction.aborted) { transaction.onabort?.({ target: transaction }); finish(); return; }
              const operation = operations.shift();
              if (operation) {
                operation();
                setImmediate(pump);
                return;
              }
              const gate = factory.commitGate;
              factory.commitGate = null;
              if (gate) { gate.entered.resolve(); await gate.release.promise; }
              if (factory.nextCommitError) {
                transaction.error = factory.nextCommitError;
                factory.nextCommitError = null;
                transaction.onabort?.({ target: transaction });
                finish();
                return;
              }
              state.records = transaction.working;
              transaction.oncomplete?.({ target: transaction });
              finish();
            };
            transaction.abort = () => { transaction.aborted = true; };
            transaction.objectStore = () => ({
              get(key) {
                const item = {};
                operations.push(() => { item.result = structuredClone(transaction.working.get(key)); item.onsuccess?.({ target: item }); });
                return item;
              },
              put(value, key) {
                const snapshot = structuredClone(value);
                const item = {};
                operations.push(() => { transaction.working.set(key, snapshot); item.result = key; item.onsuccess?.({ target: item }); });
                return item;
              },
            });
            state.queue.push(() => { transaction.working = structuredClone(state.records); setImmediate(pump); });
            if (state.queue.length === 1) setImmediate(state.queue[0]);
            return transaction;
          },
        };
        request.result = database;
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  return factory;
}

test("shared validation retains world guards and permits credential-free settings", () => {
  const world = fixture();
  assert.equal(validateSave("world", world), world);
  for (const field of ["id", "rng", "lastNpcTick", "version", "people"]) {
    const damaged = structuredClone(world); delete damaged[field];
    assert.throws(() => validateSave("world", damaged), InvalidSaveError);
  }
  validateSave("settings", { provider: "compatible", baseUrl: "https://example.test/v1", model: "test-model" });
  assert.throws(() => validateSave("settings", { provider: "compatible", baseUrl: "invalid", model: "test-model" }), InvalidSaveError);
});

test("browser saves commit cloned primary and last valid backup together", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  assert.equal(await store.read("world"), null);
  const first = fixture();
  await store.save("world", first);
  const second = { ...first, version: 2 };
  const gate = { entered: defer(), release: defer() };
  indexedDB.commitGate = gate;
  let completed = false;
  const save = store.save("world", second).then(() => { completed = true; });
  second.version = 50;
  await gate.entered.promise;
  assert.equal(completed, false);
  assert.deepEqual(indexedDB.records().get("world"), first);
  assert.equal(indexedDB.records().has("world.previous"), false);
  gate.release.resolve();
  await save;
  assert.equal(indexedDB.records().get("world").version, 2);
  assert.deepEqual(indexedDB.records().get("world.previous"), first);
  const freshConnection = new BrowserStore({ indexedDB });
  const read = await freshConnection.read("world");
  read.version = 99;
  assert.equal((await store.read("world")).version, 2);
  assert.ok(indexedDB.calls.filter((call) => call.kind === "transaction").every((call) => call.options?.durability === "strict"));
});

test("browser queued writes and competing connections preserve the preceding version", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  const other = new BrowserStore({ indexedDB });
  const world = fixture();
  await store.save("world", world);
  await other.read("world");
  const saves = Array.from({ length: 8 }, (_, index) => store.save("world", { ...world, version: index + 2 }));
  const read = store.read("world");
  await Promise.all(saves);
  assert.equal((await read).version, 9);
  assert.equal(indexedDB.records().get("world.previous").version, 8);
  await Promise.all([store.save("world", { ...world, version: 10 }), other.save("world", { ...world, version: 11 })]);
  assert.equal(indexedDB.records().get("world").version, 11);
  assert.equal(indexedDB.records().get("world.previous").version, 10);
});

test("browser recovery restores a valid backup, and preserves unrecoverable damage", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  const world = fixture();
  await store.save("world", world);
  await store.save("world", { ...world, version: 2 });
  indexedDB.seed("world", { schema: 1, marker: "damaged-primary" });
  const recovered = new BrowserStore({ indexedDB });
  assert.deepEqual(await recovered.read("world"), world);
  assert.ok(recovered.recovered.has("world"));
  assert.deepEqual(indexedDB.records().get("world"), world);
  assert.deepEqual(indexedDB.records().get("world.previous"), world);
  indexedDB.seed("world", "damaged-primary");
  indexedDB.seed("world.previous", "damaged-backup");
  const damaged = new BrowserStore({ indexedDB });
  await assert.rejects(damaged.read("world"), (error) => {
    assert.match(error.message, /主存档.*备用存档均无法读取/);
    assert.ok(!error.message.includes("damaged-primary"));
    return true;
  });
  assert.equal(indexedDB.records().get("world"), "damaged-primary");
  assert.equal(indexedDB.records().get("world.previous"), "damaged-backup");
  assert.equal(damaged.recovered.size, 0);
});

test("browser settings and backups never persist session credentials", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  const settings = { provider: "compatible", baseUrl: "https://example.test/v1", model: "first", additionalInstructions: "", apiKey: "storage-test-placeholder" };
  await store.save("settings", settings);
  await store.save("settings", { ...settings, model: "second" });
  assert.equal(settings.apiKey, "storage-test-placeholder");
  for (const saved of indexedDB.records().values()) assert.equal(Object.hasOwn(saved, "apiKey"), false);
  assert.equal(Object.hasOwn(await store.read("settings"), "apiKey"), false);
  indexedDB.seed("settings", { ...settings, model: "third" });
  indexedDB.seed("settings.previous", settings);
  await store.read("settings");
  for (const saved of indexedDB.records().values()) assert.equal(Object.hasOwn(saved, "apiKey"), false);
  indexedDB.seed("settings", { ...settings, baseUrl: "invalid" });
  assert.equal((await store.read("settings")).model, "first");
  assert.ok(store.recovered.has("settings"));
  assert.equal(Object.hasOwn(indexedDB.records().get("settings"), "apiKey"), false);
});

test("browser quota failure rolls back both records and reports an actionable error", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  const world = fixture();
  await store.save("world", world);
  await store.save("world", { ...world, version: 2 });
  const before = structuredClone(indexedDB.records());
  indexedDB.nextCommitError = new DOMException("Injected quota failure", "QuotaExceededError");
  await assert.rejects(store.save("world", { ...world, version: 3 }), /存储空间不足/);
  assert.deepEqual(indexedDB.records(), before);
  await store.save("world", { ...world, version: 4 });
  assert.equal(indexedDB.records().get("world.previous").version, 2);
});

test("browser open failures and blocked upgrades remain explicit without a new game", async () => {
  await assert.rejects(new BrowserStore({ indexedDB: null }).read("world"), /未提供 IndexedDB/);
  const denied = memoryIndexedDB(); denied.openMode = "error";
  await assert.rejects(new BrowserStore({ indexedDB: denied }).read("world"), /无法打开浏览器存档/);
  const blocked = memoryIndexedDB(); blocked.openMode = "blocked";
  const store = new BrowserStore({ indexedDB: blocked, dbName: "isolated-test" });
  await assert.rejects(store.read("world"), /其他标签页/);
  assert.equal(blocked.records("isolated-test").size, 0);
  blocked.openMode = "success";
  assert.equal(await store.read("world"), null);
  assert.equal(blocked.calls.filter((call) => call.kind === "open").length, 2);
});

test("import transaction saves world and settings together or rolls both back", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  const world = fixture();
  const settings = { provider: "offline", baseUrl: "", model: "", additionalInstructions: "旧设定" };
  await store.saveMany({ world, settings });
  const before = structuredClone(indexedDB.records());
  indexedDB.nextCommitError = new DOMException("Injected quota failure", "QuotaExceededError");
  await assert.rejects(store.saveMany({ world: { ...world, version: 2 }, settings: { ...settings, additionalInstructions: "新设定" } }), /存储空间不足/);
  assert.deepEqual(indexedDB.records(), before);
  await store.saveMany({ world: { ...world, version: 3 }, settings: { ...settings, additionalInstructions: "新设定" } });
  assert.equal((await store.read("world")).version, 3);
  assert.equal((await store.read("settings")).additionalInstructions, "新设定");
  assert.deepEqual(indexedDB.records().get("world.previous"), world);
  assert.deepEqual(indexedDB.records().get("settings.previous"), settings);
});

test("older IndexedDB APIs fall back from strict durability without changing saves", async () => {
  const indexedDB = memoryIndexedDB(); indexedDB.legacy = true;
  const store = new BrowserStore({ indexedDB });
  const world = fixture();
  await store.save("world", world);
  assert.deepEqual(await store.read("world"), world);
  const calls = indexedDB.calls.filter((call) => call.kind === "transaction");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.durability, "strict");
  assert.equal(calls[1].options, undefined);
});

test("browser rejects invalid names and worlds before opening a database", async () => {
  const indexedDB = memoryIndexedDB();
  const store = new BrowserStore({ indexedDB });
  await assert.rejects(store.save("../world", fixture()), TypeError);
  await assert.rejects(store.read("world.previous"), TypeError);
  await assert.rejects(store.save("world", {}), InvalidSaveError);
  assert.equal(indexedDB.calls.length, 0);
});
