import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDemoServer } from "../lib/app.js";
import { listen, close, post, temporaryDatastore, FIXED_CLOCK } from "./helpers.js";

test("order tools enforce confirmation, persist idempotent requests, and cancel safely", async (t) => {
  const files = await temporaryDatastore(t);
  let id = 0;
  const { server, recorder } = await createDemoServer({
    dataFile: files.dataFile,
    eventLogFile: files.eventLogFile,
    clock: FIXED_CLOCK,
    idFactory: () => `cr_test_${++id}`,
  });
  const base = await listen(server);
  t.after(() => close(server));

  const lookup = await post(base, "/api/tools/orders.lookup", { orderId: "a1042" });
  assert.equal(lookup.status, 200);
  const { order } = await lookup.json();
  assert.equal(order.id, "A-1042");
  assert.equal(order.status, "in_transit");
  assert.equal(order.delivery.scheduledDate, "2026-11-27");

  const missing = await post(base, "/api/tools/orders.lookup", { orderId: "Z-9999" });
  assert.equal(missing.status, 404);

  const change = {
    orderId: "A-1042",
    requestedDate: "2026-11-23",
    operationId: "item_change_1",
    confirmed: true,
  };
  const unconfirmed = await post(base, "/api/tools/orders.change-request", { ...change, confirmed: false });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /Explicit confirmed/);

  const past = await post(base, "/api/tools/orders.change-request", { ...change, requestedDate: "2026-11-20" });
  assert.equal(past.status, 400);

  const requested = await post(base, "/api/tools/orders.change-request", change);
  assert.equal(requested.status, 200);
  const requestedBody = await requested.json();
  assert.equal(requestedBody.status, "requested");
  assert.equal(requestedBody.changeRequest.id, "cr_test_1");
  assert.equal(requestedBody.idempotent, false);

  const repeated = await post(base, "/api/tools/orders.change-request", change);
  const repeatedBody = await repeated.json();
  assert.equal(repeatedBody.idempotent, true);
  assert.equal(repeatedBody.changeRequest.id, "cr_test_1");

  const cancelled = await post(base, "/api/tools/orders.change-request/cancel", {
    operationId: change.operationId,
    orderId: change.orderId,
  });
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.status, "cancelled");
  assert.equal(cancelledBody.changeRequest.status, "cancelled");

  const lateRetry = await post(base, "/api/tools/orders.change-request", change);
  assert.equal(lateRetry.status, 409);

  const abortedOperation = await post(base, "/api/tools/orders.change-request/cancel", {
    operationId: "item_aborted_2",
    orderId: "A-1042",
  });
  assert.equal((await abortedOperation.json()).status, "not_started");
  const lateArrival = await post(base, "/api/tools/orders.change-request", {
    ...change,
    operationId: "item_aborted_2",
  });
  assert.equal(lateArrival.status, 409);

  const persisted = JSON.parse(await readFile(files.dataFile, "utf8"));
  assert.equal(persisted.changeRequests.length, 2);
  assert.equal(persisted.changeRequests[0].status, "cancelled");
  assert.equal(persisted.changeRequests[1].status, "cancelled");
  assert.equal(persisted.orders[0].delivery.scheduledDate, "2026-11-27", "a request must not masquerade as confirmed delivery");

  await recorder.flush();
  const audit = await readFile(files.eventLogFile, "utf8");
  assert.match(audit, /orders\.lookup/);
  assert.match(audit, /orders\.change-request\.cancel/);
});
