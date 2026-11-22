import { createDemoServer } from "./lib/app.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new RangeError("PORT must be an integer from 1 to 65535");
}

const { server, recorder } = await createDemoServer({
  // This is the only place the credential is read. It is never sent to the browser.
  apiKey: process.env.OPENAI_API_KEY,
  session: {
    idleTimeoutSeconds: Number(process.env.LIVE_IDLE_TIMEOUT_S ?? 20),
    vadThreshold: Number(process.env.LIVE_VAD_THRESHOLD ?? 0.5),
    voice: process.env.LIVE_VOICE ?? "marin",
  },
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GPT-Live support demo: http://127.0.0.1:${port}`);
  console.log(`Standby: speech wake, ${process.env.LIVE_IDLE_TIMEOUT_S ?? 20}s idle timeout`);
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY is not set; real hosted session creation will return 503.");
  }
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing the HTTP server.`);
  server.close(async (error) => {
    await recorder.flush();
    process.exitCode = error ? 1 : 0;
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
