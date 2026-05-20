# AFK Extension

Runtime pieces:

- `index.ts` wires Pi commands, tool registration, and lifecycle hooks.
- `controller.ts` owns AFK runtime state and composes config, locking, Telegram, and the ask queue.
- `config.ts` persists Telegram bot settings in user config.
- `lock.ts` prevents two Pi processes from polling with the same bot token.
- `ask-queue.ts` serializes blocking AFK questions.
- `telegram.ts` adapts grammY long polling to the controller.
- `telegram-format.ts` formats Telegram question messages and buttons.
- `types.ts` contains shared schemas and TypeScript types.
