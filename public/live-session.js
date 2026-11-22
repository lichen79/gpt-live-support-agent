const DEFAULT_ICE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

export class LiveSession {
  constructor({
    peerConnectionFactory = () => new globalThis.RTCPeerConnection(),
    mediaDevices = globalThis.navigator?.mediaDevices,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    onRemoteTrack = () => {},
    onEvent = () => {},
    onClientEvent = () => {},
    onStatus = () => {},
    onFinalized = () => {},
    timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
    iceTimeoutMs = DEFAULT_ICE_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  } = {}) {
    this.peerConnectionFactory = peerConnectionFactory;
    this.mediaDevices = mediaDevices;
    this.fetchImpl = fetchImpl;
    this.onRemoteTrack = onRemoteTrack;
    this.onEvent = onEvent;
    this.onClientEvent = onClientEvent;
    this.onStatus = onStatus;
    this.onFinalized = onFinalized;
    this.timers = timers;
    this.iceTimeoutMs = iceTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.state = "idle";
    this.ready = false;
    this.finalized = false;
    this.cleaning = false;
    this.peer = null;
    this.events = null;
    this.microphone = null;
    this.closeTimer = null;
    this.iceTimer = null;
  }

  status(state, message, extra = {}) {
    this.state = state;
    this.onStatus({ state, message, ...extra });
  }

  async connect() {
    if (!["idle", "closed", "error"].includes(this.state)) throw new Error("A connection is already active");
    if (!this.mediaDevices?.getUserMedia) throw new Error("Browser microphone access is unavailable; use HTTPS or localhost");
    if (typeof this.fetchImpl !== "function") throw new Error("Browser fetch is unavailable");

    this.ready = false;
    this.finalized = false;
    this.cleaning = false;
    this.status("connecting", "Requesting microphone access…");
    const peer = this.peerConnectionFactory();
    this.peer = peer;

    try {
      peer.addEventListener("track", (event) => this.onRemoteTrack(event.track));
      this.microphone = await this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);

      // The official flow requires this channel to exist before createOffer().
      const events = peer.createDataChannel("oai-events");
      this.events = events;
      events.addEventListener("message", (message) => this.handleMessage(message));
      events.addEventListener("close", (event) => {
        if (event.target !== events || this.cleaning || this.finalized) return;
        this.status("error", "Disconnected before session.closed; final usage is unconfirmed.");
        this.cleanup();
      });

      this.status("connecting", "Creating the SDP offer…");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.waitForIce(peer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Missing local SDP offer");

      this.status("connecting", "Exchanging the offer through the trusted server…");
      const response = await this.fetchImpl("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp }),
      });
      if (!response.ok) {
        let message = `Session creation failed (${response.status})`;
        try {
          const body = await response.json();
          if (typeof body.error === "string") message = body.error;
        } catch {
          // Keep the HTTP status when the server did not return JSON.
        }
        throw new Error(message);
      }
      const result = await response.json();
      if (typeof result?.session?.id !== "string" || typeof result?.transport?.sdp !== "string") {
        throw new Error("Trusted server returned an invalid Live session response");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      // POST /v1/live/sessions started the session. Never send session.start here.
      if (!this.ready && !this.finalized) {
        this.status("connecting", "Answer applied; waiting for session.started…", { sessionId: result.session.id });
      }
      return result;
    } catch (error) {
      this.status("error", error instanceof Error ? error.message : String(error));
      this.cleanup();
      throw error;
    }
  }

  async waitForIce(peer) {
    if (peer.iceGatheringState === "complete") return;
    await new Promise((resolve, reject) => {
      const onState = () => {
        if (peer.iceGatheringState !== "complete") return;
        this.timers.clearTimeout(this.iceTimer);
        this.iceTimer = null;
        peer.removeEventListener("icegatheringstatechange", onState);
        resolve();
      };
      this.iceTimer = this.timers.setTimeout(() => {
        peer.removeEventListener("icegatheringstatechange", onState);
        reject(new Error("Timed out while gathering ICE candidates"));
      }, this.iceTimeoutMs);
      peer.addEventListener("icegatheringstatechange", onState);
      onState();
    });
  }

  handleMessage(message) {
    let event;
    try {
      if (typeof message.data !== "string") throw new TypeError("Non-string event");
      event = JSON.parse(message.data);
    } catch {
      this.onEvent({ type: "client.error", error: { message: "Ignored a malformed Live data-channel event" } });
      return;
    }
    this.onEvent(event);

    if (event.type === "session.started") {
      this.ready = true;
      this.status("ready", `Connected: ${event.session?.id ?? "Live session"}`, { sessionId: event.session?.id });
    } else if (event.type === "session.paused") {
      if (this.ready) this.status("ready", "Standby: microphone and session remain active; inference is paused.");
    } else if (event.type === "session.resumed") {
      if (this.ready) this.status("ready", "Active: speech resumed inference.");
    } else if (event.type === "session.closed") {
      this.finalized = true;
      this.ready = false;
      this.timers.clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.status("closed", `Conversation finalized (${event.reason ?? "reason not supplied"}); final usage received.`, { usage: event.usage ?? null });
      this.onFinalized(event);
      this.cleanup();
    }
  }

  send(event) {
    if (!this.ready || this.state === "closing" || this.events?.readyState !== "open") return false;
    this.events.send(JSON.stringify(event));
    this.onClientEvent(event);
    return true;
  }

  requestClose() {
    if (!this.ready || this.events?.readyState !== "open") return false;
    this.ready = false;
    this.status("closing", "Finishing the conversation; waiting for session.closed…");
    const event = { type: "session.close" };
    this.events.send(JSON.stringify(event));
    this.onClientEvent(event);
    // Media and the event channel stay alive until finalization or the timeout.
    this.closeTimer = this.timers.setTimeout(() => {
      this.status("error", "Incomplete finalization: no session.closed event; final usage is unconfirmed.");
      this.onFinalized({ type: "session.finalization_unconfirmed" });
      this.cleanup();
    }, this.closeTimeoutMs);
    return true;
  }

  cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    this.ready = false;
    this.timers.clearTimeout(this.closeTimer);
    this.timers.clearTimeout(this.iceTimer);
    this.closeTimer = null;
    this.iceTimer = null;
    this.microphone?.getTracks().forEach((track) => track.stop());
    const events = this.events;
    const peer = this.peer;
    this.events = null;
    this.peer = null;
    this.microphone = null;
    events?.close();
    peer?.close();
    if (this.state !== "error" && this.state !== "closed") this.state = "idle";
    this.cleaning = false;
  }
}
