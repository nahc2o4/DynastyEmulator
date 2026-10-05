import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
test("Pages artifact resolves all static imports inside its project path and excludes private/server files", async () => {
  await exec(process.execPath, ["scripts/build-pages.mjs"], { cwd: fileURLToPath(root) });
  const dist = new URL("dist/", root);
  const files = await readdir(dist, { recursive: true });
  assert.ok(!files.some((path) => /(^|[\\/])(data|server\.mjs|\.env|model-transport\.mjs|model\.mjs|store\.mjs)$/.test(path) && !path.replaceAll("\\", "/").startsWith("browser/")));
  assert.equal(files.length, 16);
  const html = await readFile(new URL("index.html", dist), "utf8");
  assert.match(html, /data-runtime="browser"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /src="\.\/app.js"/);
  assert.match(html, /href="\.\/styles.css"/);
  assert.doesNotMatch(html, /(?:src|href)="\//);
  for (const name of files.filter((name) => /\.m?js$/.test(name))) {
    const url = new URL(name.replaceAll("\\", "/"), dist);
    const code = await readFile(url, "utf8");
    for (const match of code.matchAll(/\bimport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.ok(!specifier.startsWith("node:"), `${name}: ${specifier}`);
      const target = new URL(specifier, url);
      assert.ok(target.href.startsWith(dist.href), `${name} escapes project site: ${specifier}`);
      await access(target);
    }
  }
});
