import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
if (relative(root, output) !== "dist") throw new Error("Invalid build destination");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Only this explicit list is published. User saves, keys and server files stay local.
const files = [
  ["public/app.js", "app.js"], ["public/styles.css", "styles.css"], ["agent.md", "agent.md"],
  ["public/browser/runtime.mjs", "browser/runtime.mjs"], ["public/browser/store.mjs", "browser/store.mjs"],
  ...["engine", "random", "model-core", "agent", "save-validation"].map((name) => [`lib/${name}.mjs`, `lib/${name}.mjs`]),
  ["config/rules.mjs", "config/rules.mjs"],
];
for (const [source, destination] of files) {
  const path = resolve(output, destination); await mkdir(dirname(path), { recursive: true });
  if (source.startsWith("public/browser/")) {
    const code = await readFile(resolve(root, source), "utf8");
    await writeFile(path, code.replaceAll('"../../lib/', '"../lib/'), "utf8");
  } else await copyFile(resolve(root, source), path);
}
let html = await readFile(resolve(root, "public/index.html"), "utf8");
html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-runtime="browser">')
  .replace('href="/styles.css"', 'href="./styles.css"').replace('src="/app.js"', 'src="./app.js"')
  .replaceAll('href="/"', 'href="./"');
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'";
html = html.replace('<meta name="viewport"', `<meta http-equiv="Content-Security-Policy" content="${policy}">\n  <meta name="viewport"`);
await writeFile(resolve(output, "index.html"), html, "utf8");
await writeFile(resolve(output, ".nojekyll"), "", "utf8");
console.log(`GitHub Pages 发布包已生成：${output}`);
