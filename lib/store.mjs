import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateSave, InvalidSaveError } from "./save-validation.mjs";
import { setTimeout as delay } from "node:timers/promises";

export class Store {
  constructor(directory) { this.directory = resolve(directory); this.pendingWrites = new Map(); this.recovered = new Set(); }
  path(name) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9.-]*$/.test(name)) throw new TypeError("Invalid save name");
    return join(this.directory, `${name}.json`);
  }
  async read(name) {
    // A read through this Store observes all writes already queued for the
    // record, and does not keep the old Windows file open during replacement.
    const pending = this.pendingWrites.get(name);
    if (pending) await pending.catch(() => {});
    const load = async (record) => validateSave(name, JSON.parse(await readFile(this.path(record), "utf8")));
    try { return await load(name); }
    catch (error) {
      if (!["world", "settings"].includes(name)) {
        if (error.code === "ENOENT") return null;
        throw new Error(`无法读取存档 ${name}.json，请保留文件后检查。`);
      }
      let previous;
      try { previous = await load(`${name}.previous`); }
      catch (backupError) {
        if (error.code === "ENOENT" && backupError.code === "ENOENT") return null;
        throw new Error(`主存档 ${name}.json 与备用存档均无法读取，请保留文件后检查。`);
      }
      await this.save(name, previous);
      this.recovered.add(name);
      return previous;
    }
  }
  async save(name, data) {
    validateSave(name, data);
    const serialized = JSON.stringify(name === "settings" ? { ...data, apiKey: undefined } : data);
    if (serialized === undefined) throw new TypeError("Invalid save data");
    await this.saveRaw(name, serialized);
  }
  async saveRaw(name, data) {
    const path = this.path(name);
    const previous = this.pendingWrites.get(name) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      if (["world", "settings"].includes(name)) {
        try {
          const raw = await readFile(path, "utf8");
          const parsed = validateSave(name, JSON.parse(raw));
          const backup = name === "settings" ? JSON.stringify({ ...parsed, apiKey: undefined }) : raw;
          await this.atomicWrite(`${name}.previous`, backup);
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof InvalidSaveError)) throw error;
        }
      }
      await this.atomicWrite(name, data);
    });
    this.pendingWrites.set(name, pending);
    try { await pending; }
    finally { if (this.pendingWrites.get(name) === pending) this.pendingWrites.delete(name); }
  }
  async atomicWrite(name, data) {
    const path = this.path(name);
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx");
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 7) throw error;
          // Windows readers and antivirus scanners may briefly hold a sharing
          // lock. Retrying the rename keeps the old complete file intact.
          await delay(Math.min(160, 10 * 2 ** attempt));
        }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
  async backupWorld() {
    try { const raw = await readFile(this.path("world"), "utf8"); validateSave("world", JSON.parse(raw)); await this.saveRaw("world.previous", raw); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
