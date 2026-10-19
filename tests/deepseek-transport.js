"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createDeepseekFetch, publicIPv4 } = require("../src/runtime/deepseek-transport");

(async () => {
  const priorMode = process.env.DEEPSEEK_DNS_MODE;
  try {
    const nativeCalls = [];
    const native = createDeepseekFetch({ fetchImpl: async (...args) => { nativeCalls.push(args); return new Response("native"); }, requestImpl: () => { throw Error("unexpected native HTTPS"); } });
    delete process.env.DEEPSEEK_DNS_MODE;
    assert.equal(await (await native("https://api.deepseek.com/chat/completions")).text(), "native");
    process.env.DEEPSEEK_DNS_MODE = "doh";
    for (const url of ["https://example.com/chat/completions", "http://127.0.0.1:11435/v1/chat/completions", "https://api.deepseek.com.evil.test", "https://api.deepseek.com:8443/models"]) await native(url);
    assert.equal(nativeCalls.length, 5);
    for (const ip of ["127.0.0.1", "28.0.0.25", "192.168.1.2", "169.254.169.254", "198.18.1.1", "::1", "invalid"]) assert.equal(publicIPv4(ip), false);

    let dnsCalls = 0, outgoingCalls = 0, lastOutgoing, lastIncoming, lastBody, clock = 0;
    const run = createDeepseekFetch({ now: () => clock, fetchImpl: async (url, options) => {
      dnsCalls++; assert.equal(url, "https://dns.google/resolve?name=api.deepseek.com&type=A");
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ Status: 0, Answer: [{ type: 1, TTL: 60, data: "3.173.21.63" }] });
    }, requestImpl: (url, options, callback) => {
      outgoingCalls++; assert.equal(url.hostname, "api.deepseek.com");
      assert.equal(options.servername, "api.deepseek.com"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.headers.host, "api.deepseek.com");
      options.lookup("api.deepseek.com", { all: true }, (error, addresses) => { assert.ifError(error); assert.equal(addresses[0].address, "3.173.21.63"); });
      options.lookup("evil.test", {}, error => assert.match(error.message, /refused/));
      const outgoing = lastOutgoing = new EventEmitter();
      outgoing.setTimeout = () => outgoing;
      outgoing.destroy = error => { outgoing.destroyed = true; queueMicrotask(() => outgoing.emit("error", error)); };
      outgoing.end = body => {
        lastBody = body;
        const incoming = lastIncoming = new PassThrough(); incoming.rawHeaders = ["Content-Type", "text/event-stream"]; incoming.statusCode = 200; incoming.statusMessage = "OK";
        queueMicrotask(() => { callback(incoming); incoming.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'); });
      };
      return outgoing;
    } });
    const controller = new AbortController();
    const response = await run("https://api.deepseek.com/chat/completions", { method: "POST", body: '{"stream":true}', headers: { authorization: "Bearer test-only" }, signal: controller.signal });
    assert.equal(lastBody.toString(), '{"stream":true}'); assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /你好/);
    controller.abort(); await assert.rejects(reader.read()); assert.equal(lastOutgoing.destroyed, true);
    const second = await run("https://api.deepseek.com/models"); lastIncoming.end(); await second.text();
    assert.equal(dnsCalls, 1); assert.equal(outgoingCalls, 2);
    clock = 61_000;
    const third = await run("https://api.deepseek.com/models"); lastIncoming.end(); await third.text(); assert.equal(dnsCalls, 2);
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(run("https://api.deepseek.com/models", { signal: cancelled.signal })); assert.equal(outgoingCalls, 3);

    let forbiddenRequests = 0;
    const badDns = createDeepseekFetch({ fetchImpl: async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }), requestImpl: () => { forbiddenRequests++; } });
    await assert.rejects(badDns("https://api.deepseek.com/models"), /no public IPv4/); assert.equal(forbiddenRequests, 0);
    const networkFailure = createDeepseekFetch({ fetchImpl: async () => { throw Error("DNS offline"); }, requestImpl: () => { forbiddenRequests++; } });
    await assert.rejects(networkFailure("https://api.deepseek.com/models"), /DNS offline/); assert.equal(forbiddenRequests, 0);
    console.log("deepseek-transport: host isolation, DNS validation/cache, TLS/SNI, streaming and cancellation passed");
  } finally {
    if (priorMode === undefined) delete process.env.DEEPSEEK_DNS_MODE; else process.env.DEEPSEEK_DNS_MODE = priorMode;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
