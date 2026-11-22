import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export class EventRecorder {
  constructor(file, { clock = () => new Date() } = {}) {
    this.file = file;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.ready = mkdir(dirname(file), { recursive: true });
  }

  record(type, fields = {}) {
    const entry = {
      timestamp: this.clock().toISOString(),
      type,
      ...fields,
    };
    this.queue = this.queue.then(async () => {
      await this.ready;
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.queue;
  }

  async flush() {
    await this.ready;
    await this.queue;
  }
}
