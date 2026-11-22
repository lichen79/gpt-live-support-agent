import test from "node:test";
import assert from "node:assert/strict";
import { LiveSession } from "../public/live-session.js";

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, values = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...values });
  }
}

class FakeChannel extends FakeTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.sent = [];
    this.closed = false;
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.readyState = "closed";
    this.closed = true;
    this.emit("close");
  }
}

class FakePeer extends FakeTarget {
  constructor(sequence) {
    super();
    this.sequence = sequence;
    this.iceGatheringState = "complete";
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
  }
  addTrack() { this.sequence.push("track"); }
  createDataChannel(label) {
    this.sequence.push(`datachannel:${label}`);
    this.channel = new FakeChannel();
    return this.channel;
  }
  async createOffer() {
    this.sequence.push("offer");
    return { type: "offer", sdp: "v=0\r\na=local-offer\r\n" };
  }
  async setLocalDescription(offer) {
    this.sequence.push("local");
    this.localDescription = offer;
  }
  async setRemoteDescription(answer) {
    this.sequence.push("remote");
    this.remoteDescription = answer;
    this.onRemote?.();
  }
  close() { this.closed = true; }
}

class FakeTimers {
  constructor() { this.nextId = 0; this.pending = new Map(); }
  setTimeout = (callback, milliseconds) => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, milliseconds });
    return id;
  };
  clearTimeout = (id) => { this.pending.delete(id); };
  runAll() {
    for (const { callback } of [...this.pending.values()]) callback();
    this.pending.clear();
  }
}

async function setup({ earlyStart = false } = {}) {
  const sequence = [];
  const peer = new FakePeer(sequence);
  const track = { stops: 0, stop() { this.stops += 1; } };
  const statuses = [];
  const finalized = [];
  const timers = new FakeTimers();
  const session = new LiveSession({
    peerConnectionFactory: () => peer,
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      }),
    },
    fetchImpl: async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        session: { id: "live_browser_contract" },
        transport: { type: "webrtc", sdp: "v=0\r\na=remote-answer\r\n" },
      }),
    }),
    timers,
    onStatus: (status) => statuses.push(status),
    onFinalized: (event) => finalized.push(event),
  });
  if (earlyStart) {
    peer.onRemote = () => serverEvent(peer.channel, { type: "session.started", session: { id: "live_browser_contract" } });
  }
  await session.connect();
  return { session, peer, channel: peer.channel, track, statuses, finalized, timers, sequence };
}

function serverEvent(channel, event) {
  channel.emit("message", { data: JSON.stringify(event) });
}
test("an early session.started event is not overwritten by answer bookkeeping", async () => {
  const { session, channel, statuses } = await setup({ earlyStart: true });
  assert.equal(session.ready, true);
  assert.equal(session.state, "ready");
  assert.equal(statuses.at(-1).state, "ready");
  serverEvent(channel, { type: "session.closed", reason: "close_requested", usage: { seconds: 1 } });
});


test("browser creates oai-events before the offer and waits for session.closed before teardown", async () => {
  const { session, peer, channel, track, finalized, sequence } = await setup();
  assert.deepEqual(sequence, ["track", "datachannel:oai-events", "offer", "local", "remote"]);
  assert.deepEqual(peer.remoteDescription, { type: "answer", sdp: "v=0\r\na=remote-answer\r\n" });
  assert.equal(session.ready, false);
  assert.equal(channel.sent.length, 0, "no session.start or other command is sent before session.started");

  serverEvent(channel, { type: "session.started", session: { id: "live_browser_contract" } });
  assert.equal(session.ready, true);
  serverEvent(channel, { type: "session.paused" });
  assert.equal(track.stops, 0, "standby keeps the microphone track active");
  serverEvent(channel, { type: "session.resumed" });
  assert.equal(track.stops, 0);

  assert.equal(session.requestClose(), true);
  assert.deepEqual(channel.sent, [{ type: "session.close" }]);
  assert.equal(track.stops, 0, "media remains alive while final events drain");
  assert.equal(peer.closed, false);

  serverEvent(channel, { type: "session.closed", reason: "close_requested", usage: { seconds: 12 }, session: { id: "live_browser_contract" } });
  assert.equal(session.finalized, true);
  assert.equal(track.stops, 1);
  assert.equal(channel.closed, true);
  assert.equal(peer.closed, true);
  assert.equal(finalized.at(-1).usage.seconds, 12);
});

test("close timeout releases resources and reports unconfirmed finalization", async () => {
  const { session, peer, channel, track, finalized, timers, statuses } = await setup();
  serverEvent(channel, { type: "session.started", session: { id: "live_browser_contract" } });
  session.requestClose();
  assert.equal(timers.pending.size, 1);
  timers.runAll();

  assert.equal(track.stops, 1);
  assert.equal(peer.closed, true);
  assert.equal(finalized[0].type, "session.finalization_unconfirmed");
  assert.match(statuses.at(-1).message, /final usage is unconfirmed/);
});
