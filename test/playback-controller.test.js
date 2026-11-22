import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackController } from "../public/playback-controller.js";

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
  }
}

class FakeAudio extends FakeTarget {
  constructor(playImpl = null) {
    super();
    this.playImpl = playImpl;
    this.srcObject = null;
    this.paused = true;
    this.muted = false;
    this.calls = [];
  }
  async play() {
    this.calls.push("play");
    if (this.playImpl) return this.playImpl();
    this.paused = false;
    this.emit("play");
    this.emit("playing");
    return true;
  }
  pause() {
    this.calls.push("pause");
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.emit("pause");
  }
}

class FakeTrack extends FakeTarget {
  constructor() {
    super();
    this.muted = false;
  }
}

test("Play reports that no remote track exists instead of starting a synthetic clock", async () => {
  const audio = new FakeAudio();
  const controller = new PlaybackController({ audio });
  assert.equal(await controller.play(), false);
  assert.equal(controller.state.hasMedia, false);
  assert.equal(controller.state.playing, false);
  assert.match(controller.state.error, /No assistant audio track/);
  assert.deepEqual(audio.calls, []);
});

test("remote audio plays, pauses silently, and resumes through the same media element", async () => {
  const audio = new FakeAudio();
  const track = new FakeTrack();
  const stream = {};
  const controller = new PlaybackController({ audio });

  assert.equal(await controller.attachTrack(track, stream), true);
  assert.equal(audio.srcObject, stream);
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false);
  assert.equal(controller.state.playing, true);

  controller.pause();
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, true, "pause must silence a live stream even if frames continue arriving");
  assert.equal(controller.state.playing, false);

  assert.equal(await controller.play(), true);
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false);
  assert.equal(controller.state.playing, true);

  controller.clear();
  assert.equal(audio.srcObject, null);
  assert.equal(controller.state.hasMedia, false);
  track.emit("mute");
  assert.equal(controller.state.trackMuted, false, "cleared tracks no longer change the UI");
});

test("browser media and track events keep the visible audio state synchronized", async () => {
  const audio = new FakeAudio();
  const track = new FakeTrack();
  const controller = new PlaybackController({ audio });
  await controller.attachTrack(track, {});

  audio.emit("waiting");
  assert.equal(controller.state.buffering, true);
  audio.emit("playing");
  assert.equal(controller.state.buffering, false);
  assert.equal(controller.state.playing, true);

  track.emit("mute");
  assert.equal(controller.state.trackMuted, true);
  track.emit("unmute");
  assert.equal(controller.state.trackMuted, false);

  audio.emit("pause");
  assert.equal(controller.state.playing, false);
  audio.emit("playing");
  assert.equal(controller.state.playing, true);
});

test("autoplay failure is visible and a later user retry starts audio", async () => {
  let blocked = true;
  const audio = new FakeAudio(() => {
    if (blocked) throw new Error("NotAllowedError");
    audio.paused = false;
    audio.emit("playing");
    return true;
  });
  const controller = new PlaybackController({ audio });

  assert.equal(await controller.attachTrack(new FakeTrack(), {}), false);
  assert.equal(controller.state.playing, false);
  assert.match(controller.state.error, /NotAllowedError/);

  blocked = false;
  assert.equal(await controller.play(), true);
  assert.equal(controller.state.error, null);
  assert.equal(controller.state.playing, true);
});

test("a stalled play request times out, clears its timer, and can be retried", async () => {
  let fireTimeout;
  let cleared = false;
  const timers = {
    setTimeout(callback) { fireTimeout = callback; return 17; },
    clearTimeout(id) { cleared = id === 17; },
  };
  const audio = new FakeAudio(() => new Promise(() => {}));
  const controller = new PlaybackController({ audio, timers });
  const starting = controller.attachTrack(new FakeTrack(), {});
  assert.equal(controller.state.pending, true);
  fireTimeout();
  assert.equal(await starting, false);
  assert.equal(cleared, true);
  assert.match(controller.state.error, /timed out/);

  audio.playImpl = () => {
    audio.paused = false;
    audio.emit("playing");
    return true;
  };
  assert.equal(await controller.play(), true);
  assert.equal(controller.state.playing, true);
  assert.equal(controller.state.error, null);
});
