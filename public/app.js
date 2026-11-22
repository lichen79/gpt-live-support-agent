import { LiveSession } from "./live-session.js";
import { TaskController } from "./task-controller.js";
import { PlaybackController } from "./playback-controller.js";
import { SessionRecorder } from "./session-recorder.js";
import { ReplayController, formatReplayTime } from "./replay-controller.js";

const byId = (id) => document.getElementById(id);
const startButton = byId("start");
const stopButton = byId("stop");
const muteButton = byId("mute");
const remoteAudio = byId("remote-audio");
let microphoneMuted = false;
let mutePending = false;
let currentSessionId = null;
const taskStates = new Map();
let recorder = new SessionRecorder();
let replayActive = false;
let finalizingRecording = null;
let audioDownloadUrl = null;
let eventDownloadUrl = null;

function trace(message) {
  const text = `${new Date().toISOString().slice(11, 19)} · ${message}`;
  const item = document.createElement("li");
  item.textContent = text;
  const list = byId("trace");
  list.append(item);
  while (list.children.length > 80) list.firstElementChild.remove();
  if (!replayActive) recorder.record("trace", { text });
  // Deliberately no auto-scroll: the trace grows below the current viewport.
}

async function postJson(path, body, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Request failed (${response.status})`);
  return result;
}

function recordBrowserEvent(type, fields = {}) {
  // Lifecycle metadata only: never send SDP, transcripts, tool payloads, or credentials.
  postJson("/api/events", { type, sessionId: currentSessionId ?? undefined, ...fields })
    .catch((error) => console.warn("Could not record browser event", error));
}

function renderTasks(tasks, { observe = true } = {}) {
  const container = byId("tasks");
  container.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No client delegations yet. A spoken “I’ll check” does not create a task.";
    container.append(empty);
    return;
  }

  for (const task of [...tasks].reverse()) {
    const card = document.createElement("article");
    card.className = "task";
    const top = document.createElement("div");
    top.className = "task-top";
    const id = document.createElement("span");
    id.className = "mono";
    id.textContent = `${task.id} · r${task.revision}`;
    const status = document.createElement("span");
    status.className = "task-status";
    status.textContent = task.status.replaceAll("_", " ");
    top.append(id, status);
    card.append(top);

    const detail = document.createElement("p");
    detail.textContent = [task.kind, task.orderId, task.requestedDate, task.tool].filter(Boolean).join(" · ");
    card.append(detail);
    if (task.result || task.error) {
      const result = document.createElement("p");
      result.textContent = task.error ? `${task.result ?? "Task failed"} (${task.error})` : task.result;
      card.append(result);
    }
    const latestUpdate = (task.updates ?? []).at(-1);
    if (latestUpdate) {
      const delivery = document.createElement("p");
      delivery.className = "delivery";
      delivery.textContent = latestUpdate.delivered
        ? `${latestUpdate.type} sent with the original delegation ID. Spoken delivery is tracked separately.`
        : "Result retained in application state; the Live data channel was unavailable.";
      card.append(delivery);
    }
    container.append(card);

    if (observe) {
      const previousStatus = taskStates.get(task.id);
      if (previousStatus !== task.status) {
        trace(`task ${task.id}: ${task.status}`);
        if (task.status === "superseded") recordBrowserEvent("delegation.revised", { delegationId: task.id, revision: task.revision, status: task.status });
        if (task.status === "cancelled") recordBrowserEvent("delegation.cancelled", { delegationId: task.id, revision: task.revision, status: task.status });
        if (task.status === "failed") recordBrowserEvent("delegation.failed", { delegationId: task.id, status: task.status });
        if (task.status === "completed" && ["lookup", "change_request"].includes(task.kind)) {
          recordBrowserEvent("tool.result", { delegationId: task.id, operationId: task.operationId ?? undefined, status: task.status });
        }
        taskStates.set(task.id, task.status);
      }
    }
  }
}

const tasks = new TaskController({
  lookupOrder: async (orderId, { signal }) => (await postJson("/api/tools/orders.lookup", { orderId }, signal)).order,
  requestChange: (payload, { signal }) => postJson("/api/tools/orders.change-request", payload, signal),
  cancelChange: (payload) => postJson("/api/tools/orders.change-request/cancel", payload),
  send: (event) => live.send(event),
  onTranscript: ({ user, assistant }) => {
    if (!replayActive) recorder.record("captions", { user, assistant });
    byId("user-caption").textContent = user || "No caller transcript yet.";
    byId("assistant-caption").textContent = assistant || "No assistant transcript yet.";
  },
  onTasks: (taskList) => {
    if (!replayActive) recorder.record("tasks", { tasks: taskList });
    renderTasks(taskList);
  },
});

const playback = new PlaybackController({
  audio: remoteAudio,
  onChange: ({ hasMedia, trackMuted, playing, pending, buffering, error }) => {
    const button = byId("playback-toggle");
    button.disabled = !hasMedia || pending;
    button.textContent = pending ? "Starting audio…" : (playing ? "Pause audio" : "Play audio");
    button.setAttribute("aria-pressed", String(playing));
    byId("playback-state").textContent = !hasMedia
      ? "Waiting for audio"
      : error
        ? "Audio error"
        : trackMuted
          ? "Assistant track silent"
          : buffering
            ? "Buffering audio"
            : playing
              ? "Audio live"
              : "Audio paused";
    byId("playback-time").textContent = hasMedia
      ? "Live events update on arrival; pausing audio does not pause the session."
      : "Start a conversation to enable assistant audio.";
    byId("playback-error").textContent = error ?? "";
  },
});

let lastReplayCaptions = null;
let lastReplayTasks = null;
let lastReplayTraceCount = -1;

const replay = new ReplayController({
  audio: remoteAudio,
  onFrame: ({ events, playing, positionMs, durationMs, ended, error }) => {
    if (!replayActive) return;
    const captions = events.findLast((event) => event.type === "captions");
    if (captions !== lastReplayCaptions) {
      byId("user-caption").textContent = captions?.user || "No caller transcript yet.";
      byId("assistant-caption").textContent = captions?.assistant || "No assistant transcript yet.";
      lastReplayCaptions = captions;
    }
    const taskFrame = events.findLast((event) => event.type === "tasks");
    if (taskFrame !== lastReplayTasks) {
      renderTasks(taskFrame?.tasks ?? [], { observe: false });
      lastReplayTasks = taskFrame;
    }
    const traceFrames = events.filter((event) => event.type === "trace");
    if (traceFrames.length !== lastReplayTraceCount) {
      const list = byId("trace");
      list.replaceChildren();
      for (const event of traceFrames.slice(-80)) {
        const item = document.createElement("li");
        item.textContent = event.text;
        list.append(item);
      }
      lastReplayTraceCount = traceFrames.length;
    }
    byId("replay-toggle").textContent = playing ? "Pause replay" : (ended ? "Replay again" : "Play replay");
    byId("replay-state").textContent = error ? "Replay error" : (playing ? "Replaying" : (ended ? "Replay complete" : "Recording ready"));
    byId("replay-time").textContent = `${formatReplayTime(positionMs)} / ${formatReplayTime(durationMs)}`;
    const seek = byId("replay-seek");
    seek.max = String(Math.max(1, Math.round(durationMs)));
    seek.value = String(Math.round(positionMs));
    byId("replay-error").textContent = error ?? "";
  },
});

function finishRecording() {
  if (finalizingRecording) return finalizingRecording;
  byId("playback-state").textContent = "Saving recording…";
  finalizingRecording = (async () => {
    const recording = await recorder.stop();
    if (!recording) return;
    const basename = currentSessionId ?? "support-call";
    const manifest = {
      version: 1,
      sessionId: currentSessionId,
      audioOffsetMs: recording.audioOffsetMs,
      audioDurationMs: recording.audioDurationMs,
      events: recording.events,
    };
    eventDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
    byId("download-events").href = eventDownloadUrl;
    byId("download-events").download = `${basename}.events.json`;

    replayActive = true;
    lastReplayCaptions = null;
    lastReplayTasks = null;
    lastReplayTraceCount = -1;
    byId("live-audio-controls").hidden = true;
    byId("replay-controls").hidden = false;
    if (!recording.blob || recording.blob.size === 0) {
      byId("replay-toggle").disabled = true;
      byId("replay-seek").disabled = true;
      byId("replay-state").textContent = "No audio recording";
      byId("replay-time").textContent = "Event log available";
      return;
    }

    audioDownloadUrl = URL.createObjectURL(recording.blob);
    const extension = recording.mimeType.includes("mp4") ? "m4a" : "webm";
    byId("download-audio").href = audioDownloadUrl;
    byId("download-audio").download = `${basename}.${extension}`;
    byId("replay-toggle").disabled = false;
    byId("replay-seek").disabled = false;
    replay.load({
      src: audioDownloadUrl,
      events: recording.events,
      audioOffsetMs: recording.audioOffsetMs,
      audioDurationMs: recording.audioDurationMs,
    });
  })().catch((error) => {
    byId("playback-state").textContent = "Recording failed";
    byId("playback-error").textContent = error instanceof Error ? error.message : String(error);
  });
  return finalizingRecording;
}

function updateMuteButton() {
  muteButton.disabled = live.state !== "ready" || mutePending;
  muteButton.textContent = microphoneMuted ? "Unmute input" : "Mute input";
  muteButton.setAttribute("aria-pressed", String(microphoneMuted));
}

const live = new LiveSession({
  onRemoteTrack: (track) => {
    const stream = new MediaStream([track]);
    void playback.attachTrack(track, stream);
    void recorder.startAudio({ remoteStream: stream, microphoneStream: live.microphone }).catch((error) => {
      byId("playback-error").textContent = `Recording unavailable: ${error instanceof Error ? error.message : String(error)}`;
    });
  },
  onStatus: ({ state, message, sessionId, usage }) => {
    byId("status").textContent = message;
    if (sessionId) {
      currentSessionId = sessionId;
      byId("session-id").textContent = sessionId;
    }
    if (state === "closed" || state === "error") {
      startButton.disabled = false;
      stopButton.disabled = true;
      playback.clear();
      void finishRecording();
    } else {
      startButton.disabled = true;
      stopButton.disabled = state !== "ready";
    }
    if (usage) byId("session-id").textContent = `${currentSessionId} · final usage ${usage.seconds ?? "?"}s`;
    updateMuteButton();
  },
  onEvent: (event) => {
    const delegationId = event.delegation?.id ?? event.delegation_id;
    trace(`${event.type}${delegationId ? ` · ${delegationId}` : ""}`);
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      tasks.appendTranscript(event);
      return;
    }
    if (event.type === "session.delegation.created") {
      if (event.delegation?.target === "client" && event.delegation.id) {
        recordBrowserEvent("delegation.created", { delegationId: event.delegation.id });
        tasks.handleDelegation(event).catch((error) => {
          trace(`Task controller error: ${error.message}`);
        });
      }
      return;
    }
    if (["session.started", "session.paused", "session.resumed", "session.closed"].includes(event.type)) {
      recordBrowserEvent(event.type, { sessionId: event.session?.id ?? currentSessionId ?? undefined, reason: event.reason ?? undefined });
    }
    if (event.type === "session.started") {
      microphoneMuted = false;
      mutePending = false;
      updateMuteButton();
    }
    if (event.type === "session.input_audio.muted" || event.type === "session.input_audio.unmuted") {
      microphoneMuted = event.type === "session.input_audio.muted";
      mutePending = false;
      updateMuteButton();
    }
    if (event.type === "error") {
      mutePending = false;
      updateMuteButton();
      byId("status").textContent = `Live event error: ${event.error?.message ?? "unknown session error"}`;
      recordBrowserEvent("session.error", { reason: event.error?.code ?? event.error?.type ?? "unknown" });
    }
  },
  onClientEvent: (event) => {
    trace(`sent ${event.type}${event.delegation_id ? ` · ${event.delegation_id}` : ""}`);
    if (event.type === "session.close") recordBrowserEvent("session.close_requested");
  },
  onFinalized: (event) => {
    if (event.type === "session.finalization_unconfirmed") recordBrowserEvent(event.type);
  },
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  replayActive = false;
  replay.clear();
  playback.clear();
  if (audioDownloadUrl) URL.revokeObjectURL(audioDownloadUrl);
  if (eventDownloadUrl) URL.revokeObjectURL(eventDownloadUrl);
  audioDownloadUrl = null;
  eventDownloadUrl = null;
  byId("download-audio").removeAttribute("href");
  byId("download-events").removeAttribute("href");
  byId("live-audio-controls").hidden = false;
  byId("replay-controls").hidden = true;
  byId("replay-error").textContent = "";
  finalizingRecording = null;
  recorder = new SessionRecorder();
  recorder.begin();
  taskStates.clear();
  tasks.reset();
  currentSessionId = null;
  byId("session-id").textContent = "Creating a Live session…";
  byId("trace").replaceChildren();
  trace("User started a real WebRTC connection.");
  try {
    await live.connect();
  } catch {
    // LiveSession already rendered the actual startup error and released media.
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  muteButton.disabled = true;
  byId("status").textContent = "Cancelling application-owned work before closing Live…";
  await tasks.shutdown();
  playback.pause();
  if (!live.requestClose()) byId("status").textContent = "The Live channel is no longer open; finalization cannot be confirmed.";
});

muteButton.addEventListener("click", () => {
  if (mutePending) return;
  mutePending = true;
  const sent = live.send({ type: microphoneMuted ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: `mute_${Date.now()}` });
  if (!sent) mutePending = false;
  updateMuteButton();
});

remoteAudio.addEventListener("play", () => {
  if (!replayActive) trace("Assistant audio playback started locally.");
});

byId("playback-toggle").addEventListener("click", () => playback.toggle());
byId("replay-toggle").addEventListener("click", () => replay.toggle());
byId("replay-seek").addEventListener("input", (event) => replay.seek(Number(event.target.value)));

const configResponse = await fetch("/api/config");
if (!configResponse.ok) {
  byId("model").textContent = "Server configuration unavailable";
  byId("standby").textContent = "Unavailable";
} else {
  const config = await configResponse.json();
  byId("model").textContent = config.model;
  byId("standby").textContent = `${config.standby.wakePolicy} wake · ${config.standby.idleTimeoutSeconds}s idle · VAD ${config.standby.vadThreshold}`;
}
