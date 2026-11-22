import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildSessionConfig } from "./session-config.js";
import { EventRecorder } from "./events.js";
import { OrderError, OrderStore } from "./orders.js";

const DEMO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC_ROOT = join(DEMO_ROOT, "public");
const OPENAI_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const MAX_SDP_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/live-session.js", ["live-session.js", "text/javascript; charset=utf-8"]],
  ["/task-controller.js", ["task-controller.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/playback-controller.js", ["playback-controller.js", "text/javascript; charset=utf-8"]],
  ["/session-recorder.js", ["session-recorder.js", "text/javascript; charset=utf-8"]],
  ["/replay-controller.js", ["replay-controller.js", "text/javascript; charset=utf-8"]],
]);
const CLIENT_EVENT_TYPES = new Set([
  "session.started",
  "session.paused",
  "session.resumed",
  "session.close_requested",
  "session.closed",
  "session.finalization_unconfirmed",
  "session.error",
  "delegation.created",
  "delegation.revised",
  "delegation.cancelled",
  "delegation.failed",
  "tool.result",
]);

class HttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function commonHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...commonHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw new HttpError("Same-origin Origin header is required", 403);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError("Invalid request origin", 403);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.host !== request.headers.host) {
    throw new HttpError("Unexpected request origin", 403);
  }
  const requestHost = new URL(`http://${request.headers.host}`);
  if (!["127.0.0.1", "localhost"].includes(requestHost.hostname)) {
    throw new HttpError("The loopback demo accepts only loopback origins", 403);
  }
}

async function readJson(request, limit = MAX_JSON_BYTES) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError("JSON request is too large", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError("JSON request is too large", 413);
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError("A JSON body is required", 400);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError("A JSON object body is required", 400);
  }
}

function stringField(value, name, maximum = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new HttpError(`${name} must be a non-empty string of at most ${maximum} characters`, 400);
  }
  return value;
}

async function createLiveSession({ request, response, apiKey, fetchImpl, openaiUrl, sessionConfig, recorder }) {
  const body = await readJson(request, MAX_SDP_BYTES);
  if (typeof body?.sdp !== "string" || !body.sdp.trim()) {
    throw new HttpError("An SDP offer is required", 400);
  }
  if (!apiKey) {
    await recorder.record("session.create_rejected", { reason: "missing_server_credential" });
    throw new HttpError("Set OPENAI_API_KEY on the trusted server; browser credentials are not accepted", 503);
  }

  await recorder.record("session.create_requested", { model: sessionConfig.model });
  let upstream;
  try {
    upstream = await fetchImpl(openaiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: sessionConfig,
        transport: { type: "webrtc", sdp: body.sdp },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    await recorder.record("session.create_failed", { reason: "upstream_request_failed" });
    throw new HttpError("Could not reach the Live session endpoint", 502);
  }

  let result;
  try {
    result = JSON.parse(await upstream.text());
  } catch {
    result = null;
  }
  if (upstream.status !== 201) {
    const upstreamStatus = upstream.status;
    await recorder.record("session.create_failed", { upstreamStatus });
    const statusCode = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
    throw new HttpError(`Live session creation failed (upstream ${upstreamStatus})`, statusCode);
  }
  if (typeof result?.session?.id !== "string" || typeof result?.transport?.sdp !== "string") {
    await recorder.record("session.create_failed", { reason: "invalid_upstream_response" });
    throw new HttpError("Live endpoint returned an invalid session response", 502);
  }

  await recorder.record("session.created", { sessionId: result.session.id, upstreamStatus: 201 });
  sendJson(response, 201, result);
}

export async function createDemoServer({
  apiKey,
  dataFile = join(DEMO_ROOT, "data", "orders.json"),
  eventLogFile = join(DEMO_ROOT, "var", "events.jsonl"),
  fetchImpl = globalThis.fetch,
  openaiUrl = OPENAI_SESSIONS_URL,
  session = {},
  clock,
  idFactory,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const sessionConfig = buildSessionConfig(session);
  const store = await OrderStore.open(dataFile, { clock, idFactory });
  const recorder = new EventRecorder(eventLogFile, { clock });

  async function handleTool(response, name, operation, auditFields = () => ({})) {
    await recorder.record("tool.started", { tool: name, ...auditFields() });
    try {
      const result = await operation();
      await recorder.record("tool.completed", {
        tool: name,
        status: result.status ?? "ok",
        ...auditFields(),
      });
      sendJson(response, 200, result);
    } catch (error) {
      await recorder.record("tool.failed", {
        tool: name,
        statusCode: error instanceof OrderError ? error.statusCode : 500,
        ...auditFields(),
      });
      throw error;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://local.invalid");
      if (url.pathname.startsWith("/api/") && request.method === "POST") requireSameOrigin(request);

      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
          model: sessionConfig.model,
          delegation: "client",
          standby: {
            wakePolicy: sessionConfig.wake_policy.type,
            idleTimeoutSeconds: sessionConfig.idle_timeout_s,
            vadThreshold: sessionConfig.wake_policy.vad_threshold,
          },
          voice: sessionConfig.audio.output.voice,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session") {
        await createLiveSession({ request, response, apiKey, fetchImpl, openaiUrl, sessionConfig, recorder });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tools/orders.lookup") {
        const body = await readJson(request);
        await handleTool(response, "orders.lookup", async () => ({ order: await store.lookup(body.orderId) }), () => ({ orderId: typeof body.orderId === "string" ? body.orderId : "invalid" }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tools/orders.change-request") {
        const body = await readJson(request);
        await handleTool(response, "orders.change-request", async () => {
          const result = await store.requestChange(body);
          return { status: result.changeRequest.status, changeRequest: result.changeRequest, idempotent: result.idempotent };
        }, () => ({ operationId: typeof body.operationId === "string" ? body.operationId : "invalid", orderId: typeof body.orderId === "string" ? body.orderId : "invalid" }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tools/orders.change-request/cancel") {
        const body = await readJson(request);
        await handleTool(response, "orders.change-request.cancel", async () => store.cancelChange(body), () => ({ operationId: typeof body.operationId === "string" ? body.operationId : "invalid" }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        const body = await readJson(request);
        if (!CLIENT_EVENT_TYPES.has(body.type)) throw new HttpError("Unsupported client event type", 400);
        const fields = { source: "browser" };
        for (const key of ["sessionId", "delegationId", "operationId", "status", "reason"]) {
          if (body[key] !== undefined) fields[key] = stringField(body[key], key, 160);
        }
        if (body.revision !== undefined) {
          if (!Number.isInteger(body.revision) || body.revision < 0 || body.revision > 10_000) {
            throw new HttpError("revision must be a non-negative integer", 400);
          }
          fields.revision = body.revision;
        }
        await recorder.record(body.type, fields);
        sendJson(response, 202, { recorded: true });
        return;
      }

      const staticFile = STATIC_FILES.get(url.pathname);
      if (staticFile && (request.method === "GET" || request.method === "HEAD")) {
        const [file, contentType] = staticFile;
        const body = await readFile(join(PUBLIC_ROOT, file));
        response.writeHead(200, {
          ...commonHeaders(),
          "Content-Type": contentType,
          "Content-Length": body.length,
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError || error instanceof OrderError) {
        sendJson(response, error.statusCode, { error: error.message });
      } else {
        await recorder.record("server.error", { method: request.method ?? "UNKNOWN" });
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  });

  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return { server, store, recorder, sessionConfig };
}
