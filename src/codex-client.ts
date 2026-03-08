import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { TelegramCodexBotConfig } from "./config.ts";
import {
  isJsonRpcMessage,
  normalizeJsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./jsonrpc.ts";
import { asString, asTrimmedString, isRecord } from "./shared.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export type CodexTurnEvent =
  | { type: "status"; text: string }
  | { type: "output_text_delta"; text: string }
  | { type: "thought_text_delta"; text: string }
  | { type: "tool_call"; text: string }
  | { type: "done" };

function extractThreadId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  if (isRecord(result.thread)) {
    return asTrimmedString(result.thread.id) ?? null;
  }
  return asTrimmedString(result.thread_id) ?? asTrimmedString(result.id) ?? null;
}

function extractTurnId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  if (isRecord(result.turn)) {
    return asTrimmedString(result.turn.id) ?? null;
  }
  return asTrimmedString(result.turn_id) ?? asTrimmedString(result.id) ?? null;
}

function extractErrorMessage(payload: Record<string, unknown>): string | null {
  const error = isRecord(payload.error) ? payload.error : payload;
  return (
    asTrimmedString(error.message) ??
    asTrimmedString(error.additionalDetails) ??
    asTrimmedString(error.codexErrorInfo) ??
    null
  );
}

function formatToolStatus(item: Record<string, unknown>): string | null {
  const title =
    asTrimmedString(item.title) ??
    asTrimmedString(item.command) ??
    asTrimmedString(item.call_id) ??
    null;
  if (!title) {
    return null;
  }
  const status = asTrimmedString(item.status) ?? "running";
  return `${title} (${status})`;
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  private readonly activeTurnsByThreadId = new Map<string, string>();

  constructor(private readonly config: TelegramCodexBotConfig) {}

  async ensureStarted(): Promise<void> {
    if (this.initialized && this.child) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }
    await this.startPromise;
  }

  async stop(): Promise<void> {
    this.initialized = false;
    this.startPromise = null;
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      pending.timer?.unref?.();
      pending.reject(new Error("codex app-server stopped"));
    }
    this.pending.clear();
    if (!child) {
      return;
    }
    child.kill("SIGTERM");
  }

  async startThread(): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: this.config.workingDirectory,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "telegram-codex-bot",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }
    return threadId;
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.config.workingDirectory,
      sandbox: "workspace-write",
      persistExtendedHistory: true,
    });
    const resumedThreadId = extractThreadId(result);
    if (!resumedThreadId) {
      throw new Error("codex app-server did not return a resumed thread id");
    }
    return resumedThreadId;
  }

  async archiveThread(threadId: string): Promise<void> {
    try {
      await this.request("thread/archive", { threadId });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error);
      if (
        !message.includes("no rollout found for thread id") &&
        !message.includes("thread not found")
      ) {
        throw error;
      }
    }
  }

  async interruptTurn(threadId: string): Promise<void> {
    const turnId = this.activeTurnsByThreadId.get(threadId);
    if (!turnId) {
      return;
    }
    await this.request("turn/interrupt", { threadId, turnId, reason: "user-cancel" });
  }

  async *streamTurn(input: { threadId: string; text: string; signal?: AbortSignal }) {
    await this.ensureStarted();

    const queue: CodexTurnEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let failure: Error | null = null;

    const push = (event: CodexTurnEvent) => {
      queue.push(event);
      resolveNext?.();
    };

    const unsubscribe = this.onNotification((message) => {
      const params = isRecord(message.params) ? message.params : {};
      const threadId = this.extractThreadIdFromPayload(params);
      if (threadId && threadId !== input.threadId) {
        return;
      }
      if (message.method === "turn/started") {
        const turnId = this.extractTurnIdFromPayload(params);
        if (turnId) {
          this.activeTurnsByThreadId.set(input.threadId, turnId);
        }
        return;
      }
      if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/assistantMessage/delta"
      ) {
        const delta = asString(params.delta) ?? asString(params.text);
        if (delta) {
          push({ type: "output_text_delta", text: delta });
        }
        return;
      }
      if (
        message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/reasoning/textDelta"
      ) {
        const delta = asString(params.delta) ?? asString(params.text);
        if (delta) {
          push({ type: "thought_text_delta", text: delta });
        }
        return;
      }
      if (message.method === "turn/status/changed") {
        const status = isRecord(params.status)
          ? asString(params.status.type) ?? JSON.stringify(params.status)
          : asString(params.status);
        if (status) {
          push({ type: "status", text: status });
        }
        return;
      }
      if (message.method === "error") {
        const errorText = extractErrorMessage(params);
        const willRetry = isRecord(params.error) ? params.error.willRetry === true : false;
        if (errorText) {
          if (willRetry) {
            push({ type: "status", text: errorText });
            return;
          }
          failure = new Error(errorText);
        } else if (!willRetry) {
          failure = new Error("Codex turn failed");
        }
        if (!willRetry) {
          done = true;
          push({ type: "done" });
        }
        return;
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        const item = isRecord(params.item) ? params.item : null;
        if (!item) {
          return;
        }
        const itemType = asTrimmedString(item.type);
        if (
          itemType === "exec_command_begin" ||
          itemType === "exec_command_end" ||
          itemType === "patch_apply_begin" ||
          itemType === "patch_apply_end"
        ) {
          const text = formatToolStatus(item);
          if (text) {
            push({ type: "tool_call", text });
          }
        }
        return;
      }
      if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : {};
        this.activeTurnsByThreadId.delete(input.threadId);
        const status = asTrimmedString(turn.status) ?? "completed";
        if (status === "failed") {
          const messageText = isRecord(turn.error)
            ? asTrimmedString(turn.error.message) ?? "Codex turn failed"
            : "Codex turn failed";
          failure = new Error(messageText);
        }
        done = true;
        push({ type: "done" });
      }
    });

    const abortListener = () => {
      void this.interruptTurn(input.threadId).catch(() => {});
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      const result = await this.request("turn/start", {
        threadId: input.threadId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
        cwd: this.config.workingDirectory,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [this.config.workingDirectory],
          networkAccess: true,
        },
      });
      const turnId = extractTurnId(result);
      if (turnId) {
        this.activeTurnsByThreadId.set(input.threadId, turnId);
      }

      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
          resolveNext = null;
          continue;
        }
        const event = queue.shift();
        if (event) {
          yield event;
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", abortListener);
      unsubscribe();
      this.activeTurnsByThreadId.delete(input.threadId);
    }

    if (failure) {
      throw failure;
    }
  }

  private onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  private async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<unknown> {
    await this.ensureStarted();
    return await this.requestStarted(method, params, timeoutMs);
  }

  private async requestStarted(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      throw new Error("codex app-server is not running");
    }
    const id = randomUUID();
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.config.codexCommand, this.config.codexArgs, {
      cwd: this.config.workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {
      // Ignore EPIPE after child exit.
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      this.handleLine(line);
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    child.once("error", (error) => {
      this.failPending(error);
    });
    child.once("close", (code, signal) => {
      this.initialized = false;
      this.startPromise = null;
      this.child = null;
      const message =
        stderr.trim() ||
        `codex app-server exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`;
      this.failPending(new Error(message));
    });

    await this.requestStarted("initialize", {
      clientInfo: {
        name: "telegram-codex-bot",
        title: "Telegram Codex Bot",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    }, this.config.startupTimeoutMs);
    this.notifyStarted("initialized", {});
    this.initialized = true;
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.ensureStarted();
    this.notifyStarted(method, params);
  }

  private notifyStarted(method: string, params?: Record<string, unknown>): void {
    const child = this.child;
    if (!child) {
      throw new Error("codex app-server is not running");
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
    );
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (!isJsonRpcMessage(parsed)) {
      return;
    }
    if ("method" in parsed && typeof parsed.method === "string") {
      if ("id" in parsed) {
        void this.handleServerRequest(parsed as JsonRpcRequest);
        return;
      }
      for (const handler of this.notificationHandlers) {
        handler(parsed as JsonRpcNotification);
      }
      return;
    }
    if (!("id" in parsed)) {
      return;
    }
    const id = normalizeJsonRpcId(parsed.id);
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in parsed) {
      const message = isRecord(parsed.error)
        ? asTrimmedString(parsed.error.message) ?? "codex app-server request failed"
        : "codex app-server request failed";
      pending.reject(new Error(message));
      return;
    }
    if ("result" in parsed) {
      pending.resolve(parsed.result);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.child) {
      return;
    }
    if (request.method === "tool/requestUserInput") {
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            outcome: "cancelled",
            reason: "telegram bot is non-interactive",
          },
        })}\n`,
      );
      return;
    }
    if (request.method === "shutdown") {
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`,
      );
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `unsupported request: ${request.method}` },
      })}\n`,
    );
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private extractThreadIdFromPayload(payload: Record<string, unknown>): string | undefined {
    if (isRecord(payload.thread)) {
      return asTrimmedString(payload.thread.id);
    }
    return asTrimmedString(payload.threadId) ?? asTrimmedString(payload.conversationId);
  }

  private extractTurnIdFromPayload(payload: Record<string, unknown>): string | undefined {
    if (isRecord(payload.turn)) {
      return asTrimmedString(payload.turn.id);
    }
    return asTrimmedString(payload.turnId);
  }
}
