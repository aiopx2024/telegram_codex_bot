import fs from "node:fs";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type ThreadRecord = {
  chatId: string;
  threadId: string;
  updatedAt: string;
};

export class TelegramThreadStore {
  private readonly cache = new Map<string, ThreadRecord>();
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(chatId: string): Promise<ThreadRecord | null> {
    await this.load();
    return this.cache.get(chatId) ?? null;
  }

  async set(chatId: string, threadId: string): Promise<void> {
    await this.load();
    this.cache.set(chatId, {
      chatId,
      threadId,
      updatedAt: new Date().toISOString(),
    });
    await this.flush();
  }

  async delete(chatId: string): Promise<void> {
    await this.load();
    this.cache.delete(chatId);
    await this.flush();
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.chatId === "string" &&
          typeof item.threadId === "string"
        ) {
          this.cache.set(item.chatId, item as ThreadRecord);
        }
      }
    } catch {
      // Ignore corrupted cache and rebuild it on the next write.
    }
  }

  private async flush(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const payload = JSON.stringify([...this.cache.values()], null, 2);
      await writeFile(this.filePath, `${payload}\n`, "utf8");
    });
    await this.writeChain;
  }
}
