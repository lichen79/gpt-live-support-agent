import test from "node:test";
import assert from "node:assert/strict";
import { TaskController, classifyRequest, resolveRequestedDate } from "../public/task-controller.js";

const NOW = () => new Date("2026-11-21T12:00:00.000Z");
const ORDER = {
  id: "A-1042",
  status: "in_transit",
  carrier: "Northstar Parcel",
  delivery: { scheduledDate: "2026-11-27" },
};

function delegation(id, offsetMs = 1000) {
  return {
    type: "session.delegation.created",
    event_id: `event_${id}`,
    offset_ms: offsetMs,
    delegation: { id, type: "delegation", target: "client" },
  };
}

function user(controller, text, startMs = 0) {
  controller.appendTranscript({
    type: "session.input_transcript.delta",
    delta: text,
    start_ms: startMs,
    end_ms: startMs + 500,
  });
}

function controllerWith(overrides = {}) {
  const sent = [];
  const snapshots = [];
  const controller = new TaskController({
    lookupOrder: async () => structuredClone(ORDER),
    requestChange: async () => { throw new Error("unexpected write"); },
    cancelChange: async () => ({ status: "cancelled" }),
    send: (event) => { sent.push(event); return true; },
    now: NOW,
    onTasks: (tasks) => snapshots.push(tasks),
    ...overrides,
  });
  return { controller, sent, snapshots };
}

function abortOnSignal(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
}

test("client delegation uses saved transcript context and returns the original delegation ID", async () => {
  const { controller, sent } = controllerWith();
  user(controller, "Where is order ", 0);
  user(controller, "A-1042?", 500);
  const task = await controller.handleDelegation(delegation("item_lookup", 1000));

  assert.equal(task.status, "completed");
  assert.equal(task.orderId, "A-1042");
  assert.equal(sent[0].type, "session.thinking.append");
  assert.equal(sent[0].delegation_id, "item_lookup");
  assert.equal(sent[0].content, "");
  const result = sent.find((event) => event.type === "session.commentary.append");
  assert.equal(result.delegation_id, "item_lookup");
  assert.match(result.content, /in transit/);
  assert.match(result.content, /Northstar Parcel/);
  assert.notEqual(result.event_id, sent[0].event_id);
});

test("spoken order IDs are normalized before lookup", async () => {
  const { controller, sent } = controllerWith();
  user(controller, "Where is order A one zero four two?", 0);
  const task = await controller.handleDelegation(delegation("item_spoken_lookup", 1000));
  assert.equal(task.status, "completed");
  assert.equal(task.orderId, "A-1042");
  const result = sent.find((event) => event.type === "session.commentary.append");
  assert.match(result.content, /A-1042/);
  assert.match(result.content, /in transit/);
});

test("hyphenated spoken order IDs are normalized before lookup", async () => {
  const { controller } = controllerWith();
  user(controller, "Where is order A one-zero-four-two?", 0);
  const task = await controller.handleDelegation(delegation("item_hyphenated_lookup", 1000));
  assert.equal(task.status, "completed");
  assert.equal(task.orderId, "A-1042");
});

test("spoken month-name dates override the weekday fallback", () => {
  assert.equal(resolveRequestedDate("Actually, can it arrive Monday, November thirtieth instead?", NOW()), "2026-11-30");
  assert.equal(classifyRequest("Actually, can it arrive Monday, November thirtieth instead?", null, NOW()).requestedDate, "2026-11-30");
});

test("barge-in revision aborts stale work, preserves order state, and suppresses the old result", async () => {
  let lookupCalls = 0;
  const { controller, sent } = controllerWith({
    lookupOrder: async (orderId, { signal }) => {
      lookupCalls += 1;
      if (lookupCalls === 1) return abortOnSignal(signal);
      assert.equal(orderId, "A-1042");
      return structuredClone(ORDER);
    },
  });

  user(controller, "Can order A-1042 arrive Monday?", 0);
  const firstPromise = controller.handleDelegation(delegation("item_monday", 1000));
  user(controller, "Actually, Monday—no, Tuesday.", 2000);
  const revised = await controller.handleDelegation(delegation("item_tuesday", 2500));
  await firstPromise;

  assert.equal(revised.status, "awaiting_confirmation");
  assert.equal(revised.orderId, "A-1042");
  assert.equal(revised.requestedDate, "2026-11-24");
  assert.equal(revised.revision, 1);
  assert.equal(controller.tasks.get("item_monday").status, "superseded");
  const spoken = sent.filter((event) => event.type === "session.commentary.append");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].delegation_id, "item_tuesday");
  assert.match(spoken[0].content, /Tuesday, 24 November 2026/);
  assert.match(spoken[0].content, /No change has been submitted/);
});

test("cancellation of an in-flight write uses its idempotency operation and never emits stale success", async () => {
  let cancelledOperation = null;
  const { controller, sent } = controllerWith({
    requestChange: async (payload, { signal }) => {
      assert.equal(payload.operationId, "item_prepare");
      assert.equal(payload.confirmed, true);
      return abortOnSignal(signal);
    },
    cancelChange: async (payload) => {
      cancelledOperation = payload;
      return { status: "cancelled" };
    },
  });

  user(controller, "Please change order A-1042 to Monday.", 0);
  await controller.handleDelegation(delegation("item_prepare", 1000));
  user(controller, "Yes, submit it.", 2000);
  const writePromise = controller.handleDelegation(delegation("item_confirm", 2500));
  user(controller, "Cancel that.", 3000);
  const cancellation = await controller.handleDelegation(delegation("item_cancel", 3500));
  await writePromise;

  assert.deepEqual(cancelledOperation, { operationId: "item_prepare", orderId: "A-1042" });
  assert.equal(cancellation.status, "completed");
  assert.equal(controller.tasks.get("item_confirm").status, "cancelled");
  assert.equal(controller.tasks.get("item_prepare").status, "continued");
  const spoken = sent.filter((event) => event.type === "session.commentary.append");
  assert.equal(spoken.some((event) => event.delegation_id === "item_confirm" && /recorded/.test(event.content)), false);
  assert.equal(spoken.at(-1).delegation_id, "item_cancel");
  assert.match(spoken.at(-1).content, /cancelled/);
});

test("a correction while awaiting confirmation creates a revision without writing either version", async () => {
  let writes = 0;
  const { controller, sent } = controllerWith({
    requestChange: async () => { writes += 1; },
  });
  user(controller, "Move order A-1042 to Monday.", 0);
  await controller.handleDelegation(delegation("item_monday", 1000));
  user(controller, "Actually Wednesday instead.", 2000);
  const revision = await controller.handleDelegation(delegation("item_wednesday", 2500));

  assert.equal(revision.status, "awaiting_confirmation");
  assert.equal(revision.requestedDate, "2026-11-25");
  assert.equal(revision.revision, 1);
  assert.equal(writes, 0);
  assert.equal(controller.tasks.get("item_monday").status, "superseded");
  assert.equal(sent.filter((event) => event.type === "session.commentary.append").at(-1).delegation_id, "item_wednesday");
});
