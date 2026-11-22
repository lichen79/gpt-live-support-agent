import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createDemoServer } from "../lib/app.js";
import { listen, close, post, temporaryDatastore, FIXED_CLOCK } from "./helpers.js";

test("trusted server posts the official Live WebRTC request and returns the 201 answer unchanged", async (t) => {
  const requests = [];
  const contract = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      session: { id: "live_contract_123", model: "gpt-live-1.1" },
      transport: { type: "webrtc", sdp: "v=0\r\na=contract-answer\r\n" },
    }));
  });
  const contractBase = await listen(contract);
  const files = await temporaryDatastore(t);
  let id = 0;
  const { server, recorder } = await createDemoServer({
    apiKey: "contract-test-key",
    openaiUrl: `${contractBase}/v1/live/sessions`,
    dataFile: files.dataFile,
    eventLogFile: files.eventLogFile,
    clock: FIXED_CLOCK,
    idFactory: () => `cr_test_${++id}`,
    session: { idleTimeoutSeconds: 25, vadThreshold: 0.65, voice: "marin" },
  });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    await close(contract);
  });

  const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
  const response = await post(base, "/api/session", { sdp: offer });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.session.id, "live_contract_123");
  assert.equal(result.transport.sdp, "v=0\r\na=contract-answer\r\n");
  assert.equal(requests.length, 1);
  const upstream = requests[0];
  assert.equal(upstream.method, "POST");
  assert.equal(upstream.url, "/v1/live/sessions");
  assert.equal(upstream.authorization, "Bearer contract-test-key");
  assert.match(upstream.contentType, /^application\/json/);
  assert.equal(upstream.body.session.model, "gpt-live-1.1");
  assert.equal(upstream.body.session.delegation.type, "client");
  assert.equal(upstream.body.session.delegation.acknowledgement_delay_ms, 800);
  assert.deepEqual(upstream.body.session.wake_policy, { type: "speech", vad_threshold: 0.65 });
  assert.equal(upstream.body.session.idle_timeout_s, 25);
  assert.equal(upstream.body.session.audio.output.voice, "marin");
  assert.equal(upstream.body.session.audio.input, undefined, "WebRTC must negotiate the input codec through SDP");
  assert.equal(upstream.body.session.store, false);
  assert.deepEqual(upstream.body.transport, { type: "webrtc", sdp: offer });
  assert.equal(upstream.body.type, undefined, "session.start must not be sent in the creation payload");

  await recorder.flush();
  const events = (await readFile(files.eventLogFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ["session.create_requested", "session.created"]);
  assert.equal(events[1].sessionId, "live_contract_123");
  assert.equal(JSON.stringify(events).includes("contract-test-key"), false);
  assert.equal(JSON.stringify(events).includes(offer), false);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(index.headers.get("content-security-policy"), /connect-src 'self' blob:/);
  const html = await index.text();
  assert.match(html, /Start real conversation/);
  const browser = await (await fetch(`${base}/live-session.js`)).text();
  assert.match(browser, /createDataChannel\("oai-events"\)/);
  assert.equal(browser.includes("contract-test-key"), false);
});

test("missing server credential fails honestly without any upstream request", async (t) => {
  const files = await temporaryDatastore(t);
  let upstreamCalls = 0;
  const { server } = await createDemoServer({
    apiKey: undefined,
    fetchImpl: async () => { upstreamCalls += 1; throw new Error("must not be called"); },
    dataFile: files.dataFile,
    eventLogFile: files.eventLogFile,
    clock: FIXED_CLOCK,
  });
  const base = await listen(server);
  t.after(() => close(server));

  const response = await post(base, "/api/session", { sdp: "v=0\r\n" });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
  assert.equal(upstreamCalls, 0);
});

test("cross-origin session creation is rejected before using the credential", async (t) => {
  const files = await temporaryDatastore(t);
  let upstreamCalls = 0;
  const { server } = await createDemoServer({
    apiKey: "contract-test-key",
    fetchImpl: async () => { upstreamCalls += 1; },
    dataFile: files.dataFile,
    eventLogFile: files.eventLogFile,
  });
  const base = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ sdp: "v=0\r\n" }),
  });
  assert.equal(response.status, 403);
  assert.equal(upstreamCalls, 0);
});
