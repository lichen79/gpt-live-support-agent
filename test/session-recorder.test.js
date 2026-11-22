import test from "node:test";
import assert from "node:assert/strict";
import { SessionRecorder } from "../public/session-recorder.js";

class FakeAudioContext {
  constructor() {
    this.sources = [];
    this.closed = false;
    this.destinationTrack = { stopped: false, stop() { this.stopped = true; } };
  }
  createMediaStreamDestination() {
    this.destination = {
      stream: { getTracks: () => [this.destinationTrack] },
      disconnect() {},
    };
    return this.destination;
  }
  createMediaStreamSource(stream) {
    const owner = this;
    const source = {
      stream,
      connected: false,
      connect(target) { this.connected = target === owner.destination; },
      disconnect() { this.connected = false; },
    };
    this.sources.push(source);
    return source;
  }
  async close() { this.closed = true; }
}

class FakeMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/webm";
    this.state = "inactive";
  }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["recorded audio"], { type: this.mimeType }) });
    this.onstop();
  }
}

function setup({ startError = null } = {}) {
  let now = 0;
  const context = new FakeAudioContext();
  const recorder = new SessionRecorder({
    now: () => now,
    audioContextFactory: () => context,
    mediaRecorderClass: FakeMediaRecorder,
    mediaRecorderFactory: (stream, type) => {
      const media = new FakeMediaRecorder(stream, { mimeType: type });
      if (startError) media.start = () => { throw startError; };
      return media;
    },
    mimeType: "audio/webm;codecs=opus",
  });
  return { recorder, context, advance: (value) => { now = value; } };
}

test("recording preserves event timestamps, audio offset, snapshots, and mixed sources", async () => {
  const { recorder, context, advance } = setup();
  const microphone = { name: "microphone" };
  const remote = { name: "assistant" };
  recorder.begin();
  advance(100);
  recorder.record("trace", { text: "connecting" });
  advance(1000);
  await recorder.startAudio({ remoteStream: remote, microphoneStream: microphone });
  assert.ok(context.sources.every((source) => source.connected), "microphone and assistant feeds must both reach the recorder");

  advance(1600);
  recorder.record("captions", { user: "Order A-1042", assistant: "Checking" });
  const task = { id: "item_1", status: "running" };
  advance(2600);
  recorder.record("tasks", { tasks: [task] });
  task.status = "mutated after capture";
  advance(3000);
  const recording = await recorder.stop();

  assert.equal(recording.audioOffsetMs, 1000);
  assert.equal(recording.audioDurationMs, 2000);
  assert.deepEqual(recording.events.map((event) => [event.atMs, event.type]), [[100, "trace"], [1600, "captions"], [2600, "tasks"]]);
  assert.equal(recording.events[2].tasks[0].status, "running");
  assert.ok(recording.blob.size > 0);
  assert.equal(recording.blob.type, "audio/webm;codecs=opus");
  assert.equal(context.sources.length, 2);
  assert.deepEqual(context.sources.map((source) => source.stream), [microphone, remote]);
  assert.ok(context.sources.every((source) => source.connected === false));
  assert.equal(context.destinationTrack.stopped, true);
  assert.equal(context.closed, true);
});

test("an event-only stop is honest when no audio track arrived", async () => {
  const { recorder, advance } = setup();
  recorder.begin();
  advance(250);
  recorder.record("trace", { text: "connection failed" });
  const recording = await recorder.stop();
  assert.equal(recording.blob, null);
  assert.equal(recording.audioDurationMs, 0);
  assert.equal(recording.events.length, 1);
});

test("a recorder startup failure does not leave stop waiting for audio", async () => {
  const { recorder, context } = setup({ startError: new Error("unsupported recorder") });
  recorder.begin();
  await assert.rejects(recorder.startAudio({ remoteStream: {} }), /unsupported recorder/);
  const recording = await recorder.stop();
  assert.equal(recording.blob, null);
  assert.equal(context.closed, true);
});
