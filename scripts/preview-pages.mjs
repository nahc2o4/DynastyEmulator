import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const base = "/DynastyEmulator/";
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".md": "text/plain" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/" || pathname === base.slice(0, -1)) { response.writeHead(302, { Location: base }); response.end(); return; }
    if (!pathname.startsWith(base)) throw new Error("Not found");
    const path = resolve(root, pathname.slice(base.length) || "index.html");
    const inside = relative(root, path);
    if (inside.startsWith("..") || inside.includes(":")) throw new Error("Invalid path");
    const data = await readFile(path);
    response.writeHead(200, { "Content-Type": `${types[extname(path)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
    response.end(data);
  } catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(Number(process.env.PAGES_PREVIEW_PORT || 4174), "127.0.0.1", () => console.log(`Pages 预览：http://127.0.0.1:${server.address().port}${base}`));
