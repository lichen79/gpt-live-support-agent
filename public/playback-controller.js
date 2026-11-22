// Controls a non-seekable live WebRTC audio element. Transcripts, tasks, and
// protocol events deliberately live outside this class: muting local output
// must never pause the remote session or hide its observed events.
const DEFAULT_PLAY_TIMEOUT_MS = 4000;

export class PlaybackController {
  constructor({
    audio = null,
    onChange = () => {},
    playTimeoutMs = DEFAULT_PLAY_TIMEOUT_MS,
    timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  } = {}) {
    this.audio = audio;
    this.onChange = onChange;
    this.playTimeoutMs = playTimeoutMs;
    this.timers = timers;
    this.track = null;
    this.hasMedia = false;
    this.trackMuted = false;
    this.playing = false;
    this.pending = false;
    this.buffering = false;
    this.error = null;
    this.playPromise = null;
    this.playAttempt = 0;

    this.onTrackMute = () => {
      this.trackMuted = true;
      this.emit();
    };
    this.onTrackUnmute = () => {
      this.trackMuted = false;
      this.emit();
    };
    this.onTrackEnded = () => {
      this.hasMedia = false;
      this.playing = false;
      this.error = "The assistant audio track ended";
      this.emit();
    };
    this.onMediaEvent = (event) => this.handleMediaEvent(event);
    if (this.audio) {
      for (const type of ["play", "playing", "pause", "waiting", "stalled", "ended", "error"]) {
        this.audio.addEventListener(type, this.onMediaEvent);
      }
    }
  }

  get state() {
    return {
      hasMedia: this.hasMedia,
      trackMuted: this.trackMuted,
      playing: this.playing,
      pending: this.pending,
      buffering: this.buffering,
      error: this.error,
    };
  }

  emit() {
    this.onChange(this.state);
  }

  handleMediaEvent(event) {
    if (!this.hasMedia) return;
    if (event.type === "playing") {
      this.playing = true;
      this.buffering = false;
      this.error = null;
    } else if (event.type === "play") {
      this.error = null;
    } else if (event.type === "pause" || event.type === "ended") {
      this.playing = false;
      this.buffering = false;
    } else if (event.type === "waiting" || event.type === "stalled") {
      this.buffering = true;
    } else if (event.type === "error") {
      this.playing = false;
      this.error = this.audio?.error?.message || "Assistant audio playback failed";
    }
    this.emit();
  }

  attachTrack(track, stream) {
    if (!track || !stream) throw new TypeError("A remote audio track and MediaStream are required");
    this.clear();
    this.track = track;
    this.hasMedia = true;
    this.trackMuted = track.muted === true;
    track.addEventListener?.("mute", this.onTrackMute);
    track.addEventListener?.("unmute", this.onTrackUnmute);
    track.addEventListener?.("ended", this.onTrackEnded);
    if (this.audio) {
      this.audio.srcObject = stream;
      this.audio.muted = false;
    }
    this.emit();
    return this.play();
  }

  async play() {
    if (this.pending && this.playPromise) return this.playPromise;
    if (!this.audio || !this.hasMedia || !this.audio.srcObject) {
      this.error = "No assistant audio track yet; start a conversation first";
      this.playing = false;
      this.emit();
      return false;
    }
    if (this.playing && this.audio.paused === false) return true;

    const attempt = ++this.playAttempt;
    this.pending = true;
    this.error = null;
    this.audio.muted = false;
    this.emit();
    this.playPromise = (async () => {
      let timeout;
      try {
        const context = this.audio.context ?? this.audio.audioContext;
        if (context?.state === "suspended") await context.resume();
        const result = await Promise.race([
          Promise.resolve(this.audio.play()),
          new Promise((_, reject) => {
            timeout = this.timers.setTimeout(() => reject(new Error("Audio playback timed out; select Play audio to retry")), this.playTimeoutMs);
          }),
        ]);
        if (result === false) throw new Error("The browser rejected audio playback");
        if (attempt !== this.playAttempt) return false;
        this.playing = true;
        this.buffering = false;
        return true;
      } catch (error) {
        if (attempt !== this.playAttempt) return false;
        this.playing = false;
        this.error = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        this.timers.clearTimeout(timeout);
        if (attempt === this.playAttempt) {
          this.pending = false;
          this.playPromise = null;
          this.emit();
        }
      }
    })();
    return this.playPromise;
  }

  pause() {
    this.playAttempt += 1;
    this.pending = false;
    this.playPromise = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.muted = true;
    }
    this.playing = false;
    this.buffering = false;
    this.emit();
  }

  toggle() {
    return this.playing ? (this.pause(), true) : this.play();
  }

  clear() {
    this.playAttempt += 1;
    this.pending = false;
    this.playPromise = null;
    if (this.track) {
      this.track.removeEventListener?.("mute", this.onTrackMute);
      this.track.removeEventListener?.("unmute", this.onTrackUnmute);
      this.track.removeEventListener?.("ended", this.onTrackEnded);
    }
    this.track = null;
    this.hasMedia = false;
    this.trackMuted = false;
    this.playing = false;
    this.buffering = false;
    this.error = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.muted = false;
    }
    this.emit();
  }
}
