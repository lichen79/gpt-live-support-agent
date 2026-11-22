// One replay clock drives recorded audio and timestamped UI snapshots. Audio is
// muted during the pre-audio event prefix, then plays at the matching offset.
export class ReplayController {
  constructor({
    audio,
    onFrame = () => {},
    now = () => performance.now(),
    tickMs = 80,
    timers = { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) },
  } = {}) {
    if (!audio) throw new TypeError("A replay audio element is required");
    this.audio = audio;
    this.onFrame = onFrame;
    this.now = now;
    this.tickMs = tickMs;
    this.timers = timers;
    this.timer = null;
    this.events = [];
    this.ready = false;
    this.playing = false;
    this.positionMs = 0;
    this.durationMs = 0;
    this.audioOffsetMs = 0;
    this.startedAt = null;
    this.startedPositionMs = 0;
    this.error = null;
    this.audio.addEventListener("loadedmetadata", () => this.syncAudioPosition());
  }

  get state() {
    return {
      ready: this.ready,
      playing: this.playing,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      ended: this.ready && this.positionMs >= this.durationMs,
      error: this.error,
    };
  }

  load({ src, events, audioOffsetMs = 0, audioDurationMs = 0 }) {
    this.clear();
    this.events = [...events].sort((left, right) => left.atMs - right.atMs);
    this.audioOffsetMs = Math.max(0, audioOffsetMs);
    const audioEndMs = this.audioOffsetMs + Math.max(0, audioDurationMs);
    const lastEventMs = this.events.at(-1)?.atMs ?? 0;
    this.durationMs = Math.max(audioEndMs, lastEventMs);
    this.ready = true;
    this.audio.src = src;
    this.audio.load();
    this.emit();
  }

  visibleEvents() {
    return this.events.filter((event) => event.atMs <= this.positionMs);
  }

  emit() {
    this.onFrame({ events: this.visibleEvents(), ...this.state });
  }

  syncAudioPosition() {
    if (!this.ready) return;
    const target = Math.max(0, (this.positionMs - this.audioOffsetMs) / 1000);
    if (Number.isFinite(this.audio.currentTime) && Math.abs(this.audio.currentTime - target) > 0.15) {
      try { this.audio.currentTime = target; } catch { /* metadata will reapply the position */ }
    }
    this.audio.muted = !this.playing || this.positionMs < this.audioOffsetMs;
  }

  async play() {
    if (!this.ready || this.playing) return this.ready;
    if (this.positionMs >= this.durationMs) this.positionMs = 0;
    this.error = null;
    this.playing = true;
    this.syncAudioPosition();
    try {
      const result = await this.audio.play();
      if (result === false) throw new Error("The browser rejected replay");
    } catch (error) {
      this.playing = false;
      this.audio.muted = true;
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return false;
    }
    this.startedAt = this.now();
    this.startedPositionMs = this.positionMs;
    this.stopTimer();
    this.timer = this.timers.setInterval(() => this.tick(), this.tickMs);
    this.timer?.unref?.();
    this.emit();
    return true;
  }

  tick() {
    if (!this.playing) return;
    this.positionMs = Math.min(this.durationMs, this.startedPositionMs + Math.max(0, this.now() - this.startedAt));
    this.audio.muted = this.positionMs < this.audioOffsetMs;
    if (this.positionMs >= this.durationMs) {
      this.playing = false;
      this.stopTimer();
      this.audio.pause();
      this.audio.muted = true;
    }
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.positionMs = Math.min(this.durationMs, this.startedPositionMs + Math.max(0, this.now() - this.startedAt));
    this.playing = false;
    this.stopTimer();
    this.audio.pause();
    this.audio.muted = true;
    this.emit();
  }

  toggle() {
    return this.playing ? (this.pause(), true) : this.play();
  }

  seek(positionMs) {
    if (!this.ready) return;
    this.positionMs = Math.min(this.durationMs, Math.max(0, Number(positionMs) || 0));
    if (this.playing) {
      this.startedAt = this.now();
      this.startedPositionMs = this.positionMs;
    }
    this.syncAudioPosition();
    if (this.playing && this.audio.paused) {
      this.audio.play().catch((error) => {
        this.playing = false;
        this.stopTimer();
        this.error = error instanceof Error ? error.message : String(error);
        this.emit();
      });
    }
    this.emit();
  }

  stopTimer() {
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  clear() {
    this.playing = false;
    this.stopTimer();
    this.audio.pause();
    this.audio.muted = false;
    this.audio.removeAttribute("src");
    this.audio.load();
    this.events = [];
    this.ready = false;
    this.positionMs = 0;
    this.durationMs = 0;
    this.audioOffsetMs = 0;
    this.error = null;
  }
}

export function formatReplayTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
