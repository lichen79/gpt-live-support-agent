const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ACTIVE_STATES = new Set(["running", "awaiting_confirmation"]);
const STOPPED_STATES = new Set(["superseded", "cancelled", "continued"]);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, "twenty-first": 21, "twenty-second": 22, "twenty-third": 23, "twenty-fourth": 24, "twenty-fifth": 25, "twenty-sixth": 26, "twenty-seventh": 27, "twenty-eighth": 28, "twenty-ninth": 29, thirtieth: 30, "thirty-first": 31 };

export function resolveRequestedDate(text, now = new Date()) {
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const candidates = [];
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    candidates.push({ index: match.index, value: match[0] });
  }
  for (const match of text.matchAll(new RegExp(`\\b(${MONTHS.join("|")})\\s+((?:\\d{1,2}(?:st|nd|rd|th)?)|(?:${Object.keys(ORDINALS).join("|")}))\\b`, "gi"))) {
    const month = MONTHS.indexOf(match[1].toLowerCase());
    const day = /^\d/.test(match[2]) ? Number.parseInt(match[2], 10) : ORDINALS[match[2].toLowerCase()];
    const date = new Date(Date.UTC(base.getUTCFullYear(), month, day));
    if (date < base) date.setUTCFullYear(date.getUTCFullYear() + 1);
    candidates.push({ index: match.index, value: date.toISOString().slice(0, 10) });
  }
  for (const match of text.matchAll(/\btomorrow\b/gi)) {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + 1);
    candidates.push({ index: match.index, value: date.toISOString().slice(0, 10) });
  }
  for (let day = 0; day < WEEKDAYS.length; day += 1) {
    for (const match of text.matchAll(new RegExp(`\\b${WEEKDAYS[day]}\\b`, "gi"))) {
      const date = new Date(base);
      const offset = (day - base.getUTCDay() + 7) % 7 || 7;
      date.setUTCDate(date.getUTCDate() + offset);
      candidates.push({ index: match.index, value: date.toISOString().slice(0, 10) });
    }
  }
  candidates.sort((left, right) => left.index - right.index);
  return candidates.at(-1)?.value ?? null;
}

export function formatDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(date);
  const day = new Intl.DateTimeFormat("en", { day: "numeric", timeZone: "UTC" }).format(date);
  const month = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(date);
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "UTC" }).format(date);
  return `${weekday}, ${day} ${month} ${year}`;
}

function extractOrderId(text) {
  const matches = [...text.matchAll(/\b([A-Z])[-\s]?(\d{4})\b/gi)];
  if (matches.length > 0) {
    const match = matches.at(-1);
    return `${match[1].toUpperCase()}-${match[2]}`;
  }
  const spoken = text.match(/\border\s+([A-Z])((?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)){4})\b/i);
  if (!spoken) return null;
  const digits = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const number = spoken[2].trim().split(/[\s-]+/).map((word) => digits[word.toLowerCase()]).join("");
  return `${spoken[1].toUpperCase()}-${number}`;
}

export function classifyRequest(text, currentTask, now = new Date()) {
  const orderId = extractOrderId(text) ?? currentTask?.orderId ?? null;
  const requestedDate = resolveRequestedDate(text, now);
  const lower = text.toLowerCase();
  const base = { orderId, requestedDate, text };

  if (/\b(cancel|stop that|forget that|never ?mind)\b/.test(lower)) return { ...base, kind: "cancel" };
  const confirmation = /\b(yes|yeah|yep|confirm|go ahead|submit|please do)\b/.test(lower);
  if (confirmation && currentTask?.status === "awaiting_confirmation" && (!requestedDate || requestedDate === currentTask.requestedDate)) {
    return { ...base, kind: "confirm" };
  }
  const changeLanguage = /\b(deliver|delivery|arrive|arrival|reschedul|change|move|instead|actually)\b/.test(lower);
  if (requestedDate && (changeLanguage || currentTask)) return { ...base, kind: "change" };
  if (changeLanguage) return { ...base, kind: "change" };
  if (orderId) return { ...base, kind: "lookup" };
  return { ...base, kind: "unknown" };
}

function taskSnapshot(task) {
  return {
    id: task.id,
    revision: task.revision,
    kind: task.kind,
    status: task.status,
    orderId: task.orderId ?? null,
    requestedDate: task.requestedDate ?? null,
    operationId: task.operationId ?? null,
    tool: task.tool ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
    cancellation: task.cancellation ?? null,
    updates: task.updates.map((update) => ({ ...update })),
  };
}

export class TaskController {
  constructor({ lookupOrder, requestChange, cancelChange, send, now = () => new Date(), onTranscript = () => {}, onTasks = () => {} }) {
    this.tools = { lookupOrder, requestChange, cancelChange };
    this.send = send;
    this.now = now;
    this.onTranscript = onTranscript;
    this.onTasks = onTasks;
    this.fragments = [];
    this.tasks = new Map();
    this.sequence = 0;
    this.transcriptCursor = 0;
    this.eventCounter = 0;
    this.activeTask = null;
    this.lastTask = null;
    this.acceptResults = true;
  }

  appendTranscript(event) {
    if (!["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type) || typeof event.delta !== "string") return;
    this.fragments.push({
      role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
      text: event.delta,
      startMs: Number.isFinite(event.start_ms) ? event.start_ms : null,
      endMs: Number.isFinite(event.end_ms) ? event.end_ms : null,
      sequence: ++this.sequence,
    });
    if (this.fragments.length > 500) this.fragments.splice(0, this.fragments.length - 500);
    this.onTranscript(this.captions());
  }

  captions() {
    return {
      user: this.fragments.filter((fragment) => fragment.role === "user").map((fragment) => fragment.text).join(""),
      assistant: this.fragments.filter((fragment) => fragment.role === "assistant").map((fragment) => fragment.text).join(""),
    };
  }

  consumeUserContext(offsetMs) {
    const context = this.fragments.filter((fragment) => (
      fragment.sequence > this.transcriptCursor
      && fragment.role === "user"
      && (fragment.startMs === null || !Number.isFinite(offsetMs) || fragment.startMs <= offsetMs)
    ));
    this.transcriptCursor = this.sequence;
    return context.map((fragment) => fragment.text).join("");
  }

  async handleDelegation(event) {
    if (!this.acceptResults || event.type !== "session.delegation.created" || event.delegation?.target !== "client") return null;
    const id = event.delegation.id;
    if (typeof id !== "string" || !id || this.tasks.has(id)) return this.tasks.get(id)?.promise ?? null;

    const text = this.consumeUserContext(event.offset_ms);
    const previous = this.activeTask;
    const intent = classifyRequest(text, previous ?? this.lastTask, this.now());
    const task = {
      id,
      revision: previous && ["change", "confirm"].includes(intent.kind) ? previous.revision + (intent.kind === "change" ? 1 : 0) : 0,
      kind: intent.kind,
      status: "running",
      orderId: intent.orderId,
      requestedDate: intent.requestedDate,
      operationId: id,
      updates: [],
    };
    this.tasks.set(id, task);
    this.append(task, "session.thinking.append", "");
    this.notify();

    task.promise = this.run(task, intent, previous).catch((error) => this.fail(task, error));
    return task.promise;
  }

  async run(task, intent, previous) {
    switch (intent.kind) {
      case "lookup":
        return this.lookup(task);
      case "change":
        return this.prepareChange(task, previous);
      case "confirm":
        if (previous?.status === "awaiting_confirmation") return this.submitChange(task, previous);
        return this.finish(task, "needs_clarification", "There is no delivery change awaiting confirmation. Ask for a new delivery date first.");
      case "cancel":
        return this.cancel(task, previous);
      default:
        return this.finish(task, "needs_clarification", "Please provide an order ID, such as A-1042, and whether you want a status lookup or a delivery change.");
    }
  }

  async lookup(task) {
    if (!task.orderId) return this.finish(task, "needs_clarification", "Which order ID should I look up?");
    this.activeTask = task;
    task.tool = "orders.lookup";
    task.abortController = new AbortController();
    this.notify();
    const order = await this.tools.lookupOrder(task.orderId, { signal: task.abortController.signal });
    if (this.stopped(task)) return task;
    task.order = order;
    task.tool = null;
    const delivery = order.delivery?.scheduledDate ? ` Scheduled delivery is ${formatDate(order.delivery.scheduledDate)}.` : "";
    const carrier = order.carrier ? ` Carrier: ${order.carrier}.` : "";
    return this.finish(task, "completed", `Order ${order.id} is ${String(order.status).replaceAll("_", " ")}.${carrier}${delivery}`);
  }

  async prepareChange(task, previous) {
    this.activeTask = task;
    if (previous && ACTIVE_STATES.has(previous.status)) {
      task.revision = previous.revision + 1;
      const cancellation = await this.stopTask(previous, "superseded");
      if (!cancellation.confirmed) {
        return this.finish(task, "failed", "The earlier change request could not be confirmed cancelled. No new request was submitted; check the order before retrying.");
      }
    }
    if (!task.orderId) return this.finish(task, "needs_clarification", "Which order ID should the delivery change apply to?");
    if (!task.requestedDate) return this.finish(task, "needs_clarification", `For order ${task.orderId}, which future delivery date should I request?`);

    this.activeTask = task;
    task.tool = "orders.lookup";
    task.abortController = new AbortController();
    this.notify();
    const order = await this.tools.lookupOrder(task.orderId, { signal: task.abortController.signal });
    if (this.stopped(task)) return task;
    task.order = order;
    task.tool = null;
    task.status = "awaiting_confirmation";
    task.result = `Order ${order.id} was found. Say yes to request delivery on ${formatDate(task.requestedDate)}. No change has been submitted.`;
    this.append(task, "session.commentary.append", task.result);
    this.notify();
    return task;
  }

  async submitChange(task, previous) {
    previous.status = "continued";
    previous.abortController?.abort();
    this.append(previous, "session.thinking.append", `The caller confirmed this request in delegation ${task.id}; its verified result will be returned there.`);
    task.kind = "change_request";
    task.orderId = previous.orderId;
    task.requestedDate = previous.requestedDate;
    task.operationId = previous.operationId ?? previous.id;
    task.revision = previous.revision;
    task.writeStarted = true;
    task.tool = "orders.change-request";
    task.abortController = new AbortController();
    this.activeTask = task;
    this.notify();

    const result = await this.tools.requestChange({
      orderId: task.orderId,
      requestedDate: task.requestedDate,
      confirmed: true,
      operationId: task.operationId,
    }, { signal: task.abortController.signal });
    if (this.stopped(task)) return task;
    if (result.status !== "requested" || !result.changeRequest?.id) {
      throw new Error("The order tool did not return a confirmed change-request record");
    }
    task.tool = null;
    task.changeRequest = result.changeRequest;
    return this.finish(task, "completed", `Change request ${result.changeRequest.id} for order ${task.orderId} on ${formatDate(task.requestedDate)} is recorded. The delivery change is not yet confirmed.`);
  }

  async cancel(task, previous) {
    this.activeTask = task;
    if (!previous || !ACTIVE_STATES.has(previous.status)) {
      return this.finish(task, "completed", "There is no active order task to cancel.");
    }
    const hadPendingWrite = Boolean(previous.writeStarted);
    const wasAwaitingConfirmation = previous.status === "awaiting_confirmation";
    const cancellation = await this.stopTask(previous, "cancelled");
    if (!cancellation.confirmed) {
      return this.finish(task, "failed", "Cancellation is unconfirmed because the order service could not be reached. Check the order before retrying; the earlier request may have been recorded.");
    }
    const content = hadPendingWrite
      ? `Cancellation for the previous change-request operation is recorded as ${cancellation.status}. No new delivery change was submitted.`
      : wasAwaitingConfirmation
        ? "The pending delivery change was cancelled before submission. No change request was recorded."
        : "The order lookup was stopped. No delivery change was requested.";
    return this.finish(task, "completed", content);
  }

  async stopTask(task, status) {
    if (!ACTIVE_STATES.has(task.status)) return { confirmed: true, status: "not_active" };
    task.status = status;
    task.tool = null;
    task.abortController?.abort();
    this.append(task, "session.thinking.append", status === "superseded"
      ? `This task was revised by a newer delegation. Do not report its earlier result.`
      : `This task was cancelled by the caller. Do not report its earlier result.`);
    this.notify();

    if (!task.writeStarted) return { confirmed: true, status: "not_started" };
    try {
      const result = await this.tools.cancelChange({ operationId: task.operationId, orderId: task.orderId });
      task.cancellation = result.status;
      this.notify();
      return { confirmed: ["cancelled", "not_started"].includes(result.status), status: result.status };
    } catch {
      task.cancellation = "unconfirmed";
      this.notify();
      return { confirmed: false, status: "unconfirmed" };
    }
  }

  fail(task, error) {
    if (this.stopped(task)) return task;
    if (error?.name === "AbortError") {
      task.status = "cancelled";
      this.notify();
      return task;
    }
    const detail = typeof error?.message === "string" ? error.message.slice(0, 240) : "Unknown tool error";
    task.error = detail;
    return this.finish(task, "failed", `The order backend did not confirm success: ${detail}. Check the order before retrying; do not assume that a change was recorded.`);
  }

  finish(task, status, content) {
    if (this.stopped(task)) return task;
    task.status = status;
    task.tool = null;
    task.result = content;
    this.append(task, "session.commentary.append", content);
    if (this.activeTask === task) {
      this.activeTask = null;
      this.lastTask = task;
    }
    this.notify();
    return task;
  }

  append(task, type, content) {
    const event = {
      type,
      event_id: `app_${++this.eventCounter}`,
      delegation_id: task.id,
      content,
    };
    const delivered = this.acceptResults && this.send(event) !== false;
    task.updates.push({ eventId: event.event_id, type, delegationId: task.id, delivered });
    return delivered;
  }


  stopped(task) {
    return STOPPED_STATES.has(task.status) || !this.acceptResults;
  }

  notify() {
    this.onTasks([...this.tasks.values()].map(taskSnapshot));
  }

  async shutdown() {
    this.acceptResults = false;
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATES.has(task.status)) await this.stopTask(task, "cancelled");
    }
    this.activeTask = null;
    this.notify();
  }

  reset() {
    this.acceptResults = false;
    for (const task of this.tasks.values()) task.abortController?.abort();
    this.fragments = [];
    this.tasks.clear();
    this.activeTask = null;
    this.lastTask = null;
    this.transcriptCursor = this.sequence;
    this.acceptResults = true;
    this.onTranscript(this.captions());
    this.notify();
  }
}
