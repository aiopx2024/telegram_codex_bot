# Telegram Codex Bot

Standalone Telegram bot that talks directly to `codex app-server`.

It does not depend on OpenClaw ACP or Telegram channel glue.

## Environment

Required:

- `TELEGRAM_BOT_TOKEN`

Optional:

- `CODEX_COMMAND`
  - default: `codex`
- `CODEX_ARGS`
  - default: `app-server`
  - accepts whitespace-separated arguments or a JSON array
- `CODEX_WORKDIR`
  - default: current working directory
- `TELEGRAM_CODEX_STATE_FILE`
  - default: `.data/telegram-codex-bot/threads.json`
- `CODEX_STARTUP_TIMEOUT_MS`
  - default: `20000`
- `CODEX_REQUEST_TIMEOUT_MS`
  - default: `120000`
- `TELEGRAM_EDIT_INTERVAL_MS`
  - default: `1000`
- `TELEGRAM_ALLOW_GROUPS`
  - default: `false`

## Run

```bash
pnpm start
```

## Commands

- `/start`
- `/help`
- `/new`
- `/reset`
- `/status`
- `/cancel`

## Behavior

- Each Telegram `chat.id` maps to one Codex `threadId`
- `/new` and `/reset` archive the current Codex thread and create a new one on the next message
- One chat can only have one active turn at a time
- The bot keeps editing one placeholder message while Codex is generating
