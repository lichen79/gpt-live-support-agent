import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

export async function close(server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

export function post(base, path, body, { origin = true } = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: base } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function temporaryDatastore(t) {
  const directory = await mkdtemp(join(tmpdir(), "p119-live-demo-"));
  const dataFile = join(directory, "orders.json");
  const seed = JSON.parse(await readFile(fileURLToPath(new URL("../data/orders.json", import.meta.url)), "utf8"));
  // Real hosted calls can append requests to the demo datastore. Tests always
  // start from the same empty-request fixture so those calls cannot break them.
  seed.changeRequests = [];
  await writeFile(dataFile, `${JSON.stringify(seed, null, 2)}\n`);
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, dataFile, eventLogFile: join(directory, "events.jsonl") };
}

export const FIXED_CLOCK = () => new Date("2026-11-21T12:00:00.000Z");
