const MODEL = "gpt-live-1.1";

const INSTRUCTIONS = `You are Lumen, a calm, concise support voice assistant for a small equipment store.
Speak naturally and briefly. Never invent order data or claim that an action happened without an application result.

Backchannel policy: Use moderate backchannels without competing with the caller's main response.

Interruption policy: Stop speaking when the user interrupts and keep listening. A correction changes the task; do not assume backend work stopped.

Delegation policy:
Backend tools:
- Orders: look up real order status and scheduled delivery from the application datastore.
- Delivery changes: prepare a requested delivery date and, after explicit confirmation, submit a change request. A change request is not a confirmed delivery change.
- Task control: revise or cancel application work when the caller corrects or cancels a request.

Delegate to the backend when:
- The user asks about an order or delivery.
- The user confirms, corrects, revises, or cancels order work.
- A short confirmation refers to a pending delivery change.

Do not delegate when:
- The user only greets you or asks a question unrelated to orders.
- You need the order ID or requested date and cannot infer it from the conversation.

Delegate before giving an answer that depends on backend work. Do not guess while waiting.
A spoken promise such as "I am checking" is not proof that work began or succeeded.
Report only verified application results, and distinguish a recorded change request from confirmed delivery.`;

export function buildSessionConfig({
  idleTimeoutSeconds = 20,
  vadThreshold = 0.5,
  voice = "marin",
} = {}) {
  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 5 || idleTimeoutSeconds > 60) {
    throw new RangeError("LIVE_IDLE_TIMEOUT_S must be a whole number from 5 to 60");
  }
  if (typeof vadThreshold !== "number" || !Number.isFinite(vadThreshold) || vadThreshold < 0 || vadThreshold > 1) {
    throw new RangeError("LIVE_VAD_THRESHOLD must be a number from 0 to 1");
  }
  if (typeof voice !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(voice)) {
    throw new TypeError("LIVE_VOICE must be a valid voice name");
  }

  return {
    model: MODEL,
    instructions: INSTRUCTIONS,
    // WebRTC negotiates the input codec through SDP. Do not force PCM here.
    audio: { output: { voice } },
    delegation: {
      type: "client",
      acknowledgement_delay_ms: 800,
    },
    wake_policy: {
      type: "speech",
      vad_threshold: vadThreshold,
    },
    idle_timeout_s: idleTimeoutSeconds,
    store: false,
  };
}
