import http from "node:http";
import https from "node:https";
import tls from "node:tls";

// Keep Node's bundled/extra roots and add roots trusted by the operating system.
// Certificate and hostname verification remain enabled for both connection paths.
export function useSystemTrust(tlsApi = tls) {
  if (typeof tlsApi.getCACertificates !== "function") return;
  const certificates = [...new Set([...tlsApi.getCACertificates("default"), ...tlsApi.getCACertificates("system")])];
  tlsApi.setDefaultCACertificates?.(certificates);
  return certificates;
}
const certificates = useSystemTrust();
const directAgents = {
  "http:": new http.Agent({ proxyEnv: {} }),
  "https:": new https.Agent({ proxyEnv: {}, rejectUnauthorized: true, ...(certificates ? { ca: certificates } : {}) }),
};

function errorsWithin(error) {
  const errors = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && errors.length < 32) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current); errors.push(current);
    pending.push(current.cause, ...(Array.isArray(current.errors) ? current.errors : []));
  }
  return errors;
}
const loopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
function bypassesProxy(target, environment) {
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const entries = (environment.no_proxy ?? environment.NO_PROXY ?? "").split(/[\s,]+/);
  return entries.some((entry) => {
    if (entry === "*") return true;
    const match = entry.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match || (match[2] && match[2] !== port)) return false;
    const host = match[1];
    if (host.startsWith("*.")) return hostname.endsWith(host.slice(1));
    if (host.startsWith(".")) return hostname.endsWith(host);
    return host === hostname;
  });
}

export function refusedLocalProxy(error, url, environment = process.env) {
  const target = new URL(url);
  if (bypassesProxy(target, environment)) return false;
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY;
  const configured = target.protocol === "https:" ? (environment.https_proxy ?? environment.HTTPS_PROXY) || httpProxy : httpProxy;
  if (!configured) return false;
  let proxy;
  try { proxy = new URL(configured); } catch { return false; }
  if (!["http:", "https:"].includes(proxy.protocol) || !loopback(proxy.hostname)) return false;
  const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const matchesAddress = (address) => proxy.hostname === "localhost"
    ? ["127.0.0.1", "::1"].includes(address)
    : address === proxy.hostname.replace(/^\[|\]$/g, "");
  if (loopback(target.hostname) && Number(target.port || (target.protocol === "https:" ? 443 : 80)) === port) return false;
  const failures = errorsWithin(error).filter((entry) => typeof entry.code === "string");
  // Only retry a refusal at the configured proxy, before an upstream connection.
  // Reset, timeout, TLS, HTTP, and destination failures must never replay a POST.
  return failures.length > 0 && failures.every((entry) => entry.code === "ECONNREFUSED" && entry.syscall === "connect" && Number(entry.port) === port && matchesAddress(entry.address));
}

export function directModelFetch(url, options) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, {
      method: options.method, headers: options.headers, signal: options.signal,
      agent: directAgents[target.protocol],
    }, (response) => {
      const chunks = []; let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) {
          const error = Object.assign(new Error("Model response exceeds limit"), { code: "MODEL_RESPONSE_TOO_LARGE" });
          response.destroy(error); request.destroy(error); return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode;
        // No redirect is followed, so Authorization never moves to a new host.
        try { resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status })); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

export function createModelFetch({ fetchImpl = fetch, directFetch = directModelFetch, environment = process.env } = {}) {
  return async (url, options) => {
    try { return await fetchImpl(url, options); }
    catch (error) {
      if (options.signal?.aborted || !refusedLocalProxy(error, url, environment)) throw error;
      return directFetch(url, options);
    }
  };
}
export const modelFetch = createModelFetch();

export function modelNetworkMessage(error, signal) {
  if (signal?.aborted || ["TimeoutError", "AbortError"].includes(error?.name)) return "模型请求超时，请重试。";
  const failures = errorsWithin(error);
  if (failures.some((entry) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(entry.code || ""))) return "模型接口证书验证失败，请检查系统信任证书或网络代理证书。";
  if (failures.some((entry) => ["ENOTFOUND", "EAI_AGAIN"].includes(entry.code))) return "无法解析模型接口地址，请检查地址与 DNS 网络。";
  if (failures.some((entry) => entry.code === "ECONNREFUSED")) return "模型连接被拒绝，请检查接口地址或本机代理是否运行。";
  if (failures.some((entry) => entry.code === "MODEL_RESPONSE_TOO_LARGE")) return "模型响应过大，请缩短输入后重试。";
  return "无法连接模型平台，请检查地址和网络。";
}
