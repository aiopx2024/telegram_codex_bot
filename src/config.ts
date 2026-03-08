import path from "node:path";

export type TelegramCodexBotConfig = {
  telegramBotToken: string;
  codexCommand: string;
  codexArgs: string[];
  workingDirectory: string;
  stateFilePath: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  editIntervalMs: number;
  allowGroups: boolean;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return ["app-server"];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramCodexBotConfig {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  const workingDirectory = path.resolve(
    env.CODEX_WORKDIR?.trim() || env.TELEGRAM_CODEX_WORKDIR?.trim() || process.cwd(),
  );

  return {
    telegramBotToken,
    codexCommand: env.CODEX_COMMAND?.trim() || "codex",
    codexArgs: parseArgs(env.CODEX_ARGS),
    workingDirectory,
    stateFilePath: path.resolve(
      env.TELEGRAM_CODEX_STATE_FILE?.trim() ||
        path.join(process.cwd(), ".data", "telegram-codex-bot", "threads.json"),
    ),
    startupTimeoutMs: parsePositiveInteger(env.CODEX_STARTUP_TIMEOUT_MS, 20_000),
    requestTimeoutMs: parsePositiveInteger(env.CODEX_REQUEST_TIMEOUT_MS, 120_000),
    editIntervalMs: parsePositiveInteger(env.TELEGRAM_EDIT_INTERVAL_MS, 1_000),
    allowGroups: parseBoolean(env.TELEGRAM_ALLOW_GROUPS, false),
  };
}
