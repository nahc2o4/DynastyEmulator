import { validateSave } from "../../lib/save-validation.mjs";

const RECORDS = "records";

class BrowserStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BrowserStorageError";
    this.code = code;
  }
}

function storageError(error, operation) {
  if (error instanceof BrowserStorageError) return error;
  if (error?.name === "QuotaExceededError") return new BrowserStorageError("浏览器存储空间不足，存档未保存。请先导出已有存档，再释放空间后重试。", "QUOTA_EXCEEDED");
  return new BrowserStorageError(operation === "open"
    ? "无法打开浏览器存档。请检查浏览器的隐私模式、网站存储权限与磁盘空间后重试。"
    : `无法${operation === "read" ? "读取" : "保存"}浏览器存档，请保留当前页面并检查网站存储权限后重试。`, "STORAGE_FAILED");
}

function assertName(name) {
  if (!["world", "settings"].includes(name)) throw new TypeError("Invalid save name");
}

function copySave(name, value) {
  if (name === "settings") {
    const metadata = { ...value };
    delete metadata.apiKey;
    return structuredClone(metadata);
  }
  return structuredClone(value);
}

function validCopy(name, value) {
  if (value === undefined) return null;
  try { validateSave(name, value); return copySave(name, value); }
  catch { return null; }
}

function transactionFor(database) {
  try { return database.transaction(RECORDS, "readwrite", { durability: "strict" }); }
  catch (error) {
    // Older IndexedDB implementations do not accept the durability option.
    if (!["TypeError", "NotSupportedError"].includes(error?.name)) throw error;
    return database.transaction(RECORDS, "readwrite");
  }
}

function readPair(records, name, done, fail) {
  const values = {};
  let received = 0;
  for (const [field, key] of [["primary", name], ["backup", `${name}.previous`]]) {
    const request = records.get(key);
    request.onsuccess = () => {
      values[field] = request.result;
      if (++received !== 2) return;
      try { done(values); } catch (error) { fail(error); }
    };
  }
}

function writeSnapshot(records, name, snapshot, done, fail) {
  readPair(records, name, (values) => {
    const primary = validCopy(name, values.primary);
    const backup = validCopy(name, values.backup);
    if (primary !== null) records.put(primary, `${name}.previous`);
    else if (backup !== null && name === "settings" && Object.hasOwn(values.backup, "apiKey")) records.put(backup, `${name}.previous`);
    records.put(snapshot, name);
    done();
  }, fail);
}

export class BrowserStore {
  constructor({ dbName = "dynasty-emulator-v1", indexedDB = globalThis.indexedDB } = {}) {
    this.dbName = dbName;
    this.indexedDB = indexedDB;
    this.databasePromise = null;
    this.pendingWrites = new Map();
    this.recovered = new Set();
  }

  openDatabase() {
    if (this.databasePromise) return this.databasePromise;
    const pending = new Promise((resolve, reject) => {
      if (!this.indexedDB || typeof this.indexedDB.open !== "function") {
        reject(new BrowserStorageError("此浏览器未提供 IndexedDB，无法安全保存游戏。请启用网站存储或使用支持 IndexedDB 的浏览器。", "STORAGE_UNAVAILABLE"));
        return;
      }
      let request;
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      try { request = this.indexedDB.open(this.dbName, 1); }
      catch (error) { fail(storageError(error, "open")); return; }
      request.onupgradeneeded = () => {
        try { if (!request.result.objectStoreNames.contains(RECORDS)) request.result.createObjectStore(RECORDS); }
        catch (error) { request.transaction?.abort(); fail(storageError(error, "open")); }
      };
      request.onblocked = () => fail(new BrowserStorageError("浏览器存档升级被其他页面阻止，请关闭此游戏的其他标签页后重试。", "STORAGE_BLOCKED"));
      request.onerror = () => fail(storageError(request.error, "open"));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true;
        database.onversionchange = () => { database.close(); this.databasePromise = null; };
        database.onclose = () => { this.databasePromise = null; };
        resolve(database);
      };
    });
    this.databasePromise = pending;
    pending.catch(() => { if (this.databasePromise === pending) this.databasePromise = null; });
    return pending;
  }

  async transact(operation, execute) {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      let transaction;
      try { transaction = transactionFor(database); }
      catch (error) { reject(storageError(error, operation)); return; }
      let result;
      let failure;
      const fail = (error) => {
        failure = storageError(error, operation);
        try { transaction.abort(); } catch { reject(failure); }
      };
      transaction.onerror = (event) => { failure ||= storageError(event.target?.error || transaction.error, operation); };
      transaction.onabort = () => reject(failure || storageError(transaction.error, operation));
      // Request success only means a write was queued; the transaction commit
      // confirms both the primary and its backup have been saved atomically.
      transaction.oncomplete = () => failure ? reject(failure) : resolve(result);
      try { execute(transaction.objectStore(RECORDS), (value) => { result = value; }, fail); }
      catch (error) { fail(error); }
    });
  }

  async read(name) {
    assertName(name);
    const pending = this.pendingWrites.get(name);
    if (pending) await pending.catch(() => {});
    const result = await this.transact("read", (records, done, fail) => {
      readPair(records, name, (values) => {
        const primary = validCopy(name, values.primary);
        const backup = validCopy(name, values.backup);
        if (primary !== null) {
          if (name === "settings") {
            if (Object.hasOwn(values.primary, "apiKey")) records.put(primary, name);
            if (backup !== null && Object.hasOwn(values.backup, "apiKey")) records.put(backup, `${name}.previous`);
          }
          done({ data: primary, recovered: false });
          return;
        }
        if (backup !== null) {
          records.put(backup, name);
          if (name === "settings" && Object.hasOwn(values.backup, "apiKey")) records.put(backup, `${name}.previous`);
          done({ data: backup, recovered: true });
          return;
        }
        if (values.primary === undefined && values.backup === undefined) {
          done({ data: null, recovered: false });
          return;
        }
        throw new BrowserStorageError(`浏览器主存档 ${name} 与备用存档均无法读取，原始数据已保留，请保留浏览器网站数据后检查。`, "INVALID_SAVE");
      }, fail);
    });
    if (result.recovered) this.recovered.add(name);
    return result.data;
  }

  async save(name, data) {
    return this.saveMany({ [name]: data });
  }

  async saveMany(data) {
    const entries = Object.entries(data);
    if (!entries.length) throw new TypeError("No saves provided");
    for (const [name, value] of entries) { assertName(name); validateSave(name, value); }
    let snapshots;
    try { snapshots = entries.map(([name, value]) => [name, copySave(name, value)]); }
    catch { throw new BrowserStorageError("存档数据无法复制，存档未保存。", "INVALID_SAVE"); }
    const previous = snapshots.map(([name]) => this.pendingWrites.get(name) || Promise.resolve());
    const pending = Promise.all(previous.map((write) => write.catch(() => {}))).then(() => this.transact("save", (records, done, fail) => {
      let remaining = snapshots.length;
      for (const [name, snapshot] of snapshots) writeSnapshot(records, name, snapshot, () => { if (--remaining === 0) done(undefined); }, fail);
    }));
    for (const [name] of snapshots) this.pendingWrites.set(name, pending);
    try { await pending; }
    finally { for (const [name] of snapshots) if (this.pendingWrites.get(name) === pending) this.pendingWrites.delete(name); }
  }
}
