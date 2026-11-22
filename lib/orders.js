import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export class OrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "OrderError";
    this.statusCode = statusCode;
  }
}

export function normalizeOrderId(value) {
  if (typeof value !== "string") throw new OrderError("orderId is required");
  const match = value.trim().toUpperCase().match(/^([A-Z])[-\s]?(\d{4})$/);
  if (!match) throw new OrderError("orderId must look like A-1042");
  return `${match[1]}-${match[2]}`;
}

function normalizeOperationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OrderError("operationId is required and must contain only letters, numbers, . _ : or -");
  }
  return value;
}

function validFutureDate(value, clock) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new OrderError("requestedDate must use YYYY-MM-DD");
  }
  const requested = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(requested.getTime()) || requested.toISOString().slice(0, 10) !== value) {
    throw new OrderError("requestedDate is not a valid calendar date");
  }
  const now = clock();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (requested.getTime() <= today) throw new OrderError("requestedDate must be after today");
  return value;
}

function validateData(data) {
  if (!data || !Array.isArray(data.orders) || !Array.isArray(data.changeRequests)) {
    throw new TypeError("Order datastore must contain orders and changeRequests arrays");
  }
  const ids = new Set();
  for (const order of data.orders) {
    if (!order || typeof order.id !== "string" || ids.has(order.id)) {
      throw new TypeError("Order datastore contains an invalid or duplicate order ID");
    }
    ids.add(order.id);
  }
}

export class OrderStore {
  constructor(file, { clock = () => new Date(), idFactory = () => `cr_${randomUUID()}` } = {}) {
    this.file = file;
    this.clock = clock;
    this.idFactory = idFactory;
    this.data = null;
    this.writeQueue = Promise.resolve();
    this.tempCounter = 0;
  }

  static async open(file, options) {
    const store = new OrderStore(file, options);
    store.data = JSON.parse(await readFile(file, "utf8"));
    validateData(store.data);
    return store;
  }

  async lookup(orderId) {
    const id = normalizeOrderId(orderId);
    await this.writeQueue;
    const order = this.data.orders.find((candidate) => candidate.id === id);
    if (!order) throw new OrderError(`Order ${id} was not found`, 404);
    return structuredClone(order);
  }

  async requestChange({ orderId, requestedDate, confirmed, operationId }) {
    const id = normalizeOrderId(orderId);
    const date = validFutureDate(requestedDate, this.clock);
    const operation = normalizeOperationId(operationId);
    if (confirmed !== true) {
      throw new OrderError("Explicit confirmed: true is required before a change request can be recorded");
    }

    return this.enqueue(async () => {
      const existing = this.data.changeRequests.find((request) => request.operationId === operation);
      if (existing) {
        if (existing.status === "cancelled") {
          throw new OrderError("This change-request operation was cancelled and cannot be reused", 409);
        }
        if (existing.orderId !== id || existing.requestedDate !== date) {
          throw new OrderError("operationId was already used for a different change request", 409);
        }
        return { changeRequest: structuredClone(existing), idempotent: true };
      }

      const order = this.data.orders.find((candidate) => candidate.id === id);
      if (!order) throw new OrderError(`Order ${id} was not found`, 404);
      const timestamp = this.clock().toISOString();
      const changeRequest = {
        id: this.idFactory(),
        operationId: operation,
        orderId: id,
        previousDeliveryDate: order.delivery?.scheduledDate ?? null,
        requestedDate: date,
        status: "requested",
        createdAt: timestamp,
        cancelledAt: null,
      };
      this.data.changeRequests.push(changeRequest);
      await this.persist();
      return { changeRequest: structuredClone(changeRequest), idempotent: false };
    });
  }

  async cancelChange({ operationId, orderId }) {
    const operation = normalizeOperationId(operationId);
    const id = orderId == null ? null : normalizeOrderId(orderId);
    return this.enqueue(async () => {
      const existing = this.data.changeRequests.find((request) => request.operationId === operation);
      if (existing) {
        if (existing.status !== "cancelled") {
          existing.status = "cancelled";
          existing.cancelledAt = this.clock().toISOString();
          await this.persist();
        }
        return { status: "cancelled", changeRequest: structuredClone(existing) };
      }

      const timestamp = this.clock().toISOString();
      const tombstone = {
        id: this.idFactory(),
        operationId: operation,
        orderId: id,
        previousDeliveryDate: null,
        requestedDate: null,
        status: "cancelled",
        createdAt: timestamp,
        cancelledAt: timestamp,
      };
      // A tombstone prevents an aborted HTTP request from later creating the operation.
      this.data.changeRequests.push(tombstone);
      await this.persist();
      return { status: "not_started", changeRequest: structuredClone(tombstone) };
    });
  }

  enqueue(operation) {
    const result = this.writeQueue.then(async () => {
      const snapshot = structuredClone(this.data);
      try {
        return await operation();
      } catch (error) {
        // A failed atomic write must not leave an unpersisted success in memory.
        this.data = snapshot;
        throw error;
      }
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async persist() {
    const temporary = `${this.file}.${process.pid}.${++this.tempCounter}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.file);
  }
}
