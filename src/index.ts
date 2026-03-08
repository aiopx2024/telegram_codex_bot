import { fileURLToPath } from "node:url";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Message } from "grammy/types";
import { loadConfig } from "./config.ts";
import { CodexAppServerClient } from "./codex-client.ts";
import { TelegramThreadStore } from "./store.ts";
import { truncateTelegramText } from "./shared.ts";

const HELP_TEXT = [
  "Commands:",
  "/new - start a new Codex thread",
  "/reset - same as /new",
  "/status - show current thread status",
  "/cancel - stop the current turn",
].join("\n");

function getText(message: Message | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }
  return undefined;
}

class DraftMessageController {
  private renderedText = "";
  private pendingText = "";
  private lastFlushAt = 0;

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number | string,
    private readonly messageId: number,
    private readonly editIntervalMs: number,
  ) {}

  async update(text: string): Promise<void> {
    this.pendingText = truncateTelegramText(text);
    await this.flush(false);
  }

  async finish(text: string): Promise<void> {
    this.pendingText = truncateTelegramText(text);
    await this.flush(true);
  }

  private async flush(force: boolean): Promise<void> {
    if (!force && Date.now() - this.lastFlushAt < this.editIntervalMs) {
      return;
    }
    if (!this.pendingText.trim() || this.pendingText === this.renderedText) {
      return;
    }
    await this.bot.api.editMessageText(this.chatId, this.messageId, this.pendingText);
    this.renderedText = this.pendingText;
    this.lastFlushAt = Date.now();
  }
}

async function main() {
  const config = loadConfig();
  const bot = new Bot(config.telegramBotToken);
  const store = new TelegramThreadStore(config.stateFilePath);
  const codex = new CodexAppServerClient(config);
  const activeControllers = new Map<string, AbortController>();

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : "unknown";
    const updateId = ctx.update.update_id;
    const text = getText(ctx.message)?.slice(0, 200) ?? "";
    console.log(`[update] id=${updateId} chat=${chatId} text=${JSON.stringify(text)}`);
    await next();
  });

  async function ensureThread(chatId: string): Promise<string> {
    const existing = await store.get(chatId);
    if (existing?.threadId) {
      try {
        return await codex.resumeThread(existing.threadId);
      } catch {
        await store.delete(chatId);
      }
    }
    const threadId = await codex.startThread();
    await store.set(chatId, threadId);
    return threadId;
  }

  async function resetThread(chatId: string): Promise<void> {
    const existing = await store.get(chatId);
    if (!existing?.threadId) {
      return;
    }
    await codex.archiveThread(existing.threadId);
    await store.delete(chatId);
  }

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command(["new", "reset"], async (ctx) => {
    const chatId = String(ctx.chat.id);
    await resetThread(chatId);
    await ctx.reply("Started a new Codex thread.");
  });

  bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const thread = await store.get(chatId);
    const active = activeControllers.has(chatId);
    await ctx.reply(
      thread?.threadId
        ? `thread: ${thread.threadId}\nactive: ${active ? "yes" : "no"}`
        : `thread: (none)\nactive: ${active ? "yes" : "no"}`,
    );
  });

  bot.command("cancel", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const controller = activeControllers.get(chatId);
    if (!controller) {
      await ctx.reply("No active turn.");
      return;
    }
    controller.abort();
    await ctx.reply("Cancellation requested.");
  });

  bot.on(":text", async (ctx) => {
    const messageText = getText(ctx.message)?.trim();
    if (!messageText || messageText.startsWith("/")) {
      return;
    }
    if (!config.allowGroups && ctx.chat.type !== "private") {
      return;
    }

    const chatId = String(ctx.chat.id);
    console.log(`[message] chat=${chatId} received text=${JSON.stringify(messageText)}`);
    if (activeControllers.has(chatId)) {
      await ctx.reply("Previous turn is still running. Send /cancel first if you want to stop it.");
      return;
    }

    const threadId = await ensureThread(chatId);
    console.log(`[message] chat=${chatId} using thread=${threadId}`);
    const placeholder = await ctx.reply("Thinking...");
    console.log(`[message] chat=${chatId} placeholder=${placeholder.message_id}`);
    const draft = new DraftMessageController(bot, ctx.chat.id, placeholder.message_id, config.editIntervalMs);
    const controller = new AbortController();
    activeControllers.set(chatId, controller);

    let output = "";
    let lastStatus = "Thinking...";

    try {
      for await (const event of codex.streamTurn({
        threadId,
        text: messageText,
        signal: controller.signal,
      })) {
        if (event.type === "output_text_delta") {
          output += event.text;
          await draft.update(output || lastStatus);
          continue;
        }
        if (event.type === "status") {
          lastStatus = `Thinking... (${event.text})`;
          if (!output) {
            await draft.update(lastStatus);
          }
          continue;
        }
        if (event.type === "tool_call") {
          lastStatus = `Working... ${event.text}`;
          if (!output) {
            await draft.update(lastStatus);
          }
          continue;
        }
        if (event.type === "done") {
          break;
        }
      }
      await store.set(chatId, threadId);
      await draft.finish(output.trim() || "Done.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
      await draft.finish(`Request failed: ${message}`);
    } finally {
      activeControllers.delete(chatId);
    }
  });

  bot.catch((error) => {
    const { ctx } = error;
    console.error(`Telegram update ${ctx.update.update_id} failed`, error.error);
    if (error.error instanceof GrammyError) {
      console.error("Telegram API error", error.error.description);
    }
    if (error.error instanceof HttpError) {
      console.error("Telegram transport error", error.error);
    }
  });

  await bot.start({
    onStart: (botInfo) => {
      console.log(`telegram-codex-bot ready as @${botInfo.username}`);
      console.log(`state file: ${config.stateFilePath}`);
      console.log(`cwd: ${config.workingDirectory}`);
    },
  });
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };
