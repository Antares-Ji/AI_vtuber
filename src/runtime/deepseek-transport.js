"use strict";

const https = require("node:https");
const { Readable } = require("node:stream");
const { isIP } = require("node:net");

const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DNS_URL = "https://dns.google/resolve?name=api.deepseek.com&type=A";

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  // Also reject this installation's known fake-IP range (28/8).
  return !(a === 0 || a === 10 || a === 28 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function createDeepseekFetch({ fetchImpl = (...args) => globalThis.fetch(...args), requestImpl = https.request, now = Date.now } = {}) {
  let dnsCache = null;

  async function resolveAddress(signal) {
    signal?.throwIfAborted();
    if (dnsCache && dnsCache.expiresAt > now()) return dnsCache.address;
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetchImpl(DNS_URL, { headers: { accept: "application/dns-json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`DeepSeek DNS lookup HTTP ${response.status}`);
    const data = await response.json();
    const record = data.Status === 0 && Array.isArray(data.Answer)
      ? data.Answer.find(value => value.type === 1 && publicIPv4(value.data)) : null;
    if (!record) throw new Error("DeepSeek DNS lookup returned no public IPv4 address");
    const ttl = Number.isFinite(record.TTL) ? Math.max(1, Math.min(60, record.TTL)) : 30;
    dnsCache = { address: record.data, expiresAt: now() + ttl * 1000 };
    return record.data;
  }

  return async function deepseekFetch(input, options = {}) {
    const url = new URL(input instanceof Request ? input.url : input);
    // Default requests still use fetch, including test mocks. Select the DNS
    // route BEFORE sending: never replay a possibly accepted POST on failure.
    if (process.env.DEEPSEEK_DNS_MODE !== "doh" || url.origin !== DEEPSEEK_ORIGIN) return fetchImpl(input, options);
    if (url.username || url.password) throw new TypeError("Credentials in a DeepSeek URL are not supported");

    const request = new Request(input, options);
    request.signal.throwIfAborted();
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const address = await resolveAddress(request.signal);
    request.signal.throwIfAborted();
    const headers = Object.fromEntries(request.headers);
    delete headers.connection;
    delete headers["transfer-encoding"];
    delete headers["proxy-authorization"];
    delete headers["content-length"];
    headers.host = "api.deepseek.com";
    headers["accept-encoding"] = "identity";
    if (body) headers["content-length"] = String(body.length);

    return new Promise((resolve, reject) => {
      let incoming;
      const abortError = () => request.signal.reason instanceof Error ? request.signal.reason : new DOMException("The operation was aborted", "AbortError");
      const lookup = (hostname, lookupOptions, callback) => {
        if (hostname !== "api.deepseek.com") return callback(new Error("DeepSeek DNS override refused another hostname"));
        return lookupOptions?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);
      };
      const outgoing = requestImpl(url, {
        method: request.method, headers, lookup, servername: "api.deepseek.com",
        rejectUnauthorized: true, agent: false,
      }, response => {
        incoming = response;
        response.once("close", cleanup);
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.statusCode);
        if (noBody) response.resume();
        const result = new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders });
        Object.defineProperty(result, "url", { value: url.href });
        // Deliberately do not follow redirects or forward credentials to a
        // second origin. Callers receive the original HTTP status.
        resolve(result);
      });
      function cleanup() { request.signal.removeEventListener("abort", abort); }
      function abort() { const error = abortError(); incoming?.destroy(error); outgoing.destroy(error); reject(error); }
      outgoing.on("error", error => { cleanup(); reject(error); });
      outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("DeepSeek connection timed out")));
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) return abort();
      outgoing.end(body);
    });
  };
}

const deepseekFetch = createDeepseekFetch();
module.exports = { deepseekFetch, createDeepseekFetch, publicIPv4 };
