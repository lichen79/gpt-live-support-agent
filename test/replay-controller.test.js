import test from "node:test";
import assert from "node:assert/strict";
import { ReplayController, formatReplayTime } from "../public/replay-controller.js";

class FakeAudio {
  constructor() {
    this.currentTime = 0;
    this.muted = false;
    this.paused = true;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  load() {}
  async play() { this.paused = false; return true; }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") delete this.src; }
}

function setup() {
  let now = 0;
  let tick;
  const audio = new FakeAudio();
  const frames = [];
  const replay = new ReplayController({
    audio,
    now: () => now,
    onFrame: (frame) => frames.push(frame),
    timers: {
      setInterval(callback) { tick = callback; return 1; },
      clearInterval() { tick = null; },
    },
  });
  const events = [
    { atMs: 0, type: "trace", text: "start" },
    { atMs: 100, type: "captions", user: "first question", assistant: "" },
    { atMs: 1500, type: "captions", user: "first question", assistant: "first answer" },
    { atMs: 2000, type: "tasks", tasks: [{ id: "item_1", status: "running" }] },
    { atMs: 3000, type: "trace", text: "task running" },
    { atMs: 3500, type: "tasks", tasks: [{ id: "item_1", status: "completed" }] },
  ];
  replay.load({ src: "blob:recording", events, audioOffsetMs: 1000, audioDurationMs: 3000 });
  return { replay, audio, frames, advance: (value) => { now = value; }, tick: () => tick?.() };
}

test("replay synchronizes pre-roll, captions, tasks, trace, pause, resume, and seek", async () => {
  const { replay, audio, advance, tick } = setup();
  assert.equal(replay.state.durationMs, 4000);
  assert.equal(replay.state.positionMs, 0);
  assert.equal(replay.visibleEvents().length, 1);

  await replay.play();
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.muted, true, "audio is muted while pre-audio events replay");
  advance(500);
  tick();
  assert.equal(replay.state.positionMs, 500);
  assert.equal(audio.muted, true);
  assert.equal(replay.visibleEvents().at(-1).type, "captions");

  advance(1600);
  tick();
  assert.equal(replay.state.positionMs, 1600);
  assert.equal(audio.muted, false);
  assert.equal(replay.visibleEvents().filter((event) => event.type === "captions").at(-1).assistant, "first answer");
  replay.pause();
  assert.equal(replay.state.positionMs, 1600);
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, true);

  advance(6000);
  await replay.play();
  assert.equal(replay.state.positionMs, 1600, "resume preserves the paused replay position");
  advance(6400);
  tick();
  assert.equal(replay.state.positionMs, 2000);
  assert.equal(replay.visibleEvents().filter((event) => event.type === "tasks").at(-1).tasks[0].status, "running");

  replay.seek(3500);
  assert.equal(audio.currentTime, 2.5);
  assert.equal(replay.visibleEvents().filter((event) => event.type === "tasks").at(-1).tasks[0].status, "completed");
  replay.seek(0);
  assert.equal(replay.visibleEvents().some((event) => event.type === "captions"), false);
  assert.equal(replay.visibleEvents().some((event) => event.type === "tasks"), false);
  assert.equal(replay.visibleEvents().filter((event) => event.type === "trace").length, 1);

  replay.seek(4000);
  tick();
  assert.equal(replay.state.playing, false);
  assert.equal(replay.state.ended, true);
  assert.equal(replay.visibleEvents().length, 6);
});

test("replay reports a browser playback rejection without advancing", async () => {
  const { replay, audio } = setup();
  audio.play = async () => { throw new Error("NotAllowedError"); };
  assert.equal(await replay.play(), false);
  assert.equal(replay.state.playing, false);
  assert.equal(replay.state.positionMs, 0);
  assert.match(replay.state.error, /NotAllowedError/);
});

test("formatReplayTime renders elapsed and total timestamps", () => {
  assert.equal(formatReplayTime(0), "0:00");
  assert.equal(formatReplayTime(84_000), "1:24");
});
