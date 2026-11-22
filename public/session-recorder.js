// Records microphone + assistant audio and timestamped UI snapshots. The event
// clock starts with the user action; the audio blob records its own start offset.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function supportedMimeType(MediaRecorderClass) {
  if (!MediaRecorderClass) return "";
  return MIME_CANDIDATES.find((type) => MediaRecorderClass.isTypeSupported?.(type)) ?? "";
}

export class SessionRecorder {
  constructor({
    now = () => performance.now(),
    audioContextFactory = () => new globalThis.AudioContext(),
    mediaRecorderFactory = null,
    mediaRecorderClass = globalThis.MediaRecorder,
    mimeType = null,
  } = {}) {
    this.now = now;
    this.audioContextFactory = audioContextFactory;
    this.mediaRecorderClass = mediaRecorderClass;
    this.mimeType = mimeType ?? supportedMimeType(mediaRecorderClass);
    this.mediaRecorderFactory = mediaRecorderFactory;
    this.startedAt = null;
    this.events = [];
    this.sources = [];
    this.audioContext = null;
    this.destination = null;
    this.mediaRecorder = null;
    this.audioOffsetMs = 0;
    this.audioStartedAt = null;
    this.audioStoppedAt = null;
    this.audioResult = null;
    this.stopPromise = null;
  }

  get active() {
    return this.startedAt !== null && this.stopPromise === null;
  }

  begin() {
    if (this.active || this.mediaRecorder) throw new Error("A recording is already active");
    this.startedAt = this.now();
    this.events = [];
  }

  record(type, fields = {}) {
    if (!this.active || this.startedAt === null) return null;
    const event = { atMs: Math.max(0, Math.round(this.now() - this.startedAt)), type, ...fields };
    this.events.push(globalThis.structuredClone(event));
    return event;
  }

  async startAudio({ remoteStream, microphoneStream = null }) {
    if (!this.active || this.startedAt === null) throw new Error("Begin the event recording before starting audio");
    if (this.audioResult) return;
    if (!remoteStream) throw new TypeError("A remote assistant stream is required");
    if (!this.mediaRecorderClass && !this.mediaRecorderFactory) throw new Error("MediaRecorder is unavailable in this browser");
    if (!this.mimeType && this.mediaRecorderClass?.isTypeSupported && !supportedMimeType(this.mediaRecorderClass)) {
      throw new Error("This browser has no supported audio recording format");
    }

    this.audioOffsetMs = Math.max(0, Math.round(this.now() - this.startedAt));
    this.audioStartedAt = this.now();
    this.audioContext = this.audioContextFactory();
    this.destination = this.audioContext.createMediaStreamDestination();
    for (const stream of [microphoneStream, remoteStream]) {
      if (!stream) continue;
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.destination);
      this.sources.push(source);
    }

    const chunks = [];
    this.mediaRecorderFactory ??= (stream, type) => new this.mediaRecorderClass(stream, type ? { mimeType: type } : undefined);
    this.mediaRecorder = this.mediaRecorderFactory(this.destination.stream, this.mimeType);
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data?.size > 0) chunks.push(event.data);
    };
    this.audioResult = new Promise((resolve, reject) => {
      this.mediaRecorder.onerror = (event) => {
        const error = event.error ?? new Error("Audio recording failed");
        this.releaseAudioGraph();
        reject(error);
      };
      this.mediaRecorder.onstop = () => {
        const type = this.mediaRecorder.mimeType || this.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        this.releaseAudioGraph();
        resolve(blob);
      };
    });
    // The final stop awaits this promise; mark early recorder errors handled too.
    this.audioResult.catch(() => {});
    try {
      this.mediaRecorder.start(250);
    } catch (error) {
      this.mediaRecorder = null;
      this.audioResult = null;
      this.releaseAudioGraph();
      throw error;
    }
  }

  releaseAudioGraph() {
    for (const source of this.sources) source.disconnect();
    this.sources = [];
    this.destination?.disconnect?.();
    this.destination?.stream?.getTracks?.().forEach((track) => track.stop());
    this.destination = null;
    if (this.audioContext && this.audioContext.state !== "closed") void this.audioContext.close();
    this.audioContext = null;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startedAt === null) return null;
      if (this.audioStartedAt !== null) this.audioStoppedAt = this.now();
      const audioDurationMs = this.audioStartedAt === null ? 0 : Math.max(1, Math.round(this.audioStoppedAt - this.audioStartedAt));
      let blob = null;
      if (this.mediaRecorder) {
        if (this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
        blob = await this.audioResult;
      }
      return {
        blob,
        mimeType: blob?.type || this.mimeType || "audio/webm",
        audioOffsetMs: this.audioOffsetMs,
        audioDurationMs,
        events: globalThis.structuredClone(this.events),
      };
    })();
    return this.stopPromise;
  }
}
