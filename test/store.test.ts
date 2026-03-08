import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TelegramThreadStore } from "../src/store.ts";

describe("TelegramThreadStore", () => {
  it("persists thread mappings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-store-"));
    const store = new TelegramThreadStore(path.join(dir, "threads.json"));

    await store.set("123", "thread-1");
    expect(await store.get("123")).toMatchObject({ chatId: "123", threadId: "thread-1" });

    const raw = await readFile(path.join(dir, "threads.json"), "utf8");
    expect(raw).toContain("thread-1");
  });
});
