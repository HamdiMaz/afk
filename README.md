# afk

A Pi package extension that allows the agent to communicate with the user when they're afk.

## Status

AFK provides a Pi extension MVP with `/afk`, `/afk-settings`, and an `afk` agent tool backed by a linked Telegram bot.

## AFK MVP usage

1. Create a Telegram bot with BotFather and copy the bot token.
2. Start Pi with this package loaded: `pi -e .`.
3. Run `/afk-settings`.
4. Paste the bot token when prompted.
5. Send the displayed one-time code directly to the Telegram bot.
6. Run `/afk` to enable AFK mode for the current Pi session.
7. While AFK mode is on, the agent can use the `afk` tool to notify you or ask questions through Telegram.
8. Run `/afk` again to turn AFK mode off.

AFK mode is session-scoped. It turns off on `/new`, `/resume`, `/fork`, `/clone`, `/reload`, and Pi shutdown. Telegram bot settings remain saved in user config.

## Install for local development

```bash
npm install
npm run check
```

## Use with Pi during development

```bash
pi -e .
```

Pi loads the package through `package.json`:

```json
{ "pi": { "extensions": ["./extensions/index.ts"] } }
```

## Project layout

```text
extensions/index.ts             Pi extension entry point
extensions/controller.ts        AFK runtime orchestration
extensions/config.ts            Telegram config persistence
extensions/lock.ts              Bot-token process lock
extensions/ask-queue.ts         Serialized blocking question queue
extensions/telegram.ts          grammY bridge
extensions/telegram-format.ts   Telegram question/button formatting
extensions/types.ts             Shared schemas and types
extensions/README.md            Extension-specific notes
tests/                          Node test runner tests
```

## Release checks

```bash
npm run check
```
